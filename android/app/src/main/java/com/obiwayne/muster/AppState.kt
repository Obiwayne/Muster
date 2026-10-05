package com.obiwayne.muster

import android.app.Application
import androidx.work.WorkManager
import com.obiwayne.muster.data.Api
import com.obiwayne.muster.data.ApiException
import com.obiwayne.muster.data.Backend
import com.obiwayne.muster.data.DemoBackend
import com.obiwayne.muster.data.Held
import com.obiwayne.muster.data.Link
import com.obiwayne.muster.data.NeedItem
import com.obiwayne.muster.data.NeedsResponse
import com.obiwayne.muster.data.OfflineException
import com.obiwayne.muster.data.Prefs
import com.obiwayne.muster.data.RemoteBackend
import com.obiwayne.muster.data.SecureStore
import com.obiwayne.muster.data.UnlinkedException
import com.obiwayne.muster.notify.EventService
import com.obiwayne.muster.notify.Notifier
import com.obiwayne.muster.notify.PollWorker
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/** Where the app is told to go from a notification tap. */
data class OpenTarget(val kind: String, val projectId: String, val taskId: String?, val noteId: String?, val itemId: String? = null)

/** What happened to a Send tap on a held remote write. */
sealed interface SendOutcome {
    data class Sent(val summary: String) : SendOutcome

    /** 404: the gateway already dropped it (expired). */
    data object Gone : SendOutcome

    /** 409 or no answer: still held, nothing was sent. */
    data class Failed(val error: String) : SendOutcome
}

/** App-wide state: the link, the needs list and the current backend (real or demo). */
class AppState(private val app: Application) {
    val store by lazy { SecureStore(app) }

    val link = MutableStateFlow<Link?>(null)
    val demo = MutableStateFlow(false)
    val needs = MutableStateFlow<NeedsResponse?>(null)
    val offline = MutableStateFlow(false)
    val refreshing = MutableStateFlow(false)
    val selectedProject = MutableStateFlow<String?>(null)
    val prefs = MutableStateFlow<Prefs?>(null)
    val wsConnected = MutableStateFlow(false)
    val lastSync = MutableStateFlow(0L)
    val openTarget = MutableStateFlow<OpenTarget?>(null)
    val homeTab = MutableStateFlow("needs")

    /** Tablet list + detail: the open item as "task:pid:tid" or "note:pid:nid" (see ui.openKey); null = the first one. */
    val selectedNeed = MutableStateFlow<String?>(null)

    /** Held remote writes that expired while shown: kept greyed out until dismissed, so a card never vanishes mid-read. */
    val expiredHeld = MutableStateFlow<List<NeedItem>>(emptyList())

    /** Send failures per held item id (the gateway's reason); the card stays held and shows Try again / Discard. */
    val heldErrors = MutableStateFlow<Map<String, String>>(emptyMap())

    /** Held items whose Send got no answer: if a retry then gets 404, the first Send may have gone through. */
    private val sendUnanswered = mutableSetOf<String>()

    /** Expired cards that may in fact have been sent ("check crew chat"), from [sendUnanswered] + 404. */
    val heldMaybeSent = MutableStateFlow<Set<String>>(emptySet())

    /** A held item to scroll to (from a notification tap). */
    val focusHeld = MutableStateFlow<String?>(null)
    private val dismissedHeld = mutableSetOf<String>()

    /** Debug builds: a pairing URI handed in by adb, consumed by the scan screen as if it had been scanned. */
    val debugPairUri = MutableStateFlow<String?>(null)

    private var api: Api? = null
    private var demoBackend: DemoBackend? = null

    fun init() {
        link.value = store.load()
        lastSync.value = store.lastSyncAt
        prefs.value = store.cachedPrefs
    }

    fun api(): Api? {
        val l = link.value ?: return null
        val a = api
        if (a != null && a.link == l) return a
        return Api(l, store).also { api = it }
    }

    fun backend(): Backend? = if (demo.value) demoBackend else api()?.let { RemoteBackend(it) }

    /** The PC name for headers ("WAYNE-PC"). */
    val pcName: String get() = needs.value?.pcName?.ifBlank { null } ?: currentLink()?.pcName ?: "your PC"

    fun currentLink(): Link? = if (demo.value) demoBackend?.link else link.value

    /**
     * Runs a backend call. A 401 unlinks the phone; going offline flips [offline]. Returns null on failure, and
     * reports the message through [onError].
     */
    suspend fun <T> call(onError: (String) -> Unit = {}, block: suspend Backend.() -> T): T? {
        val b = backend() ?: return null
        return try {
            block(b).also { offline.value = false }
        } catch (e: UnlinkedException) {
            onUnlinked()
            onError(e.message ?: "Unlinked")
            null
        } catch (e: OfflineException) {
            offline.value = true
            onError("Can't reach ${e.pcName}")
            null
        } catch (e: Exception) {
            onError(e.message ?: "Something went wrong")
            null
        }
    }

    suspend fun refreshNeeds(): NeedsResponse? {
        refreshing.value = true
        try {
            val res = call { needs() } ?: return null
            setNeeds(res)
            return res
        } finally {
            refreshing.value = false
        }
    }

    fun setNeeds(fresh: NeedsResponse) {
        // A dismissed expired card stays gone even if a poll lands before the gateway's sweep.
        val res = fresh.copy(items = fresh.items.filter { it.id !in dismissedHeld })
        keepExpired(needs.value?.items.orEmpty(), res.items)
        needs.value = res
        val now = System.currentTimeMillis()
        lastSync.value = now
        if (!demo.value) store.lastSyncAt = now
        val sel = selectedProject.value
        if (sel != null && res.projects.none { it.id == sel }) selectedProject.value = null
        if (selectedProject.value == null && !projectChosen) {
            selectedProject.value = defaultProject(res)
        }
    }

    /** True once the user picked something in the switcher (including "All projects"). */
    var projectChosen = false

    private fun defaultProject(res: NeedsResponse): String? =
        res.items.groupBy { it.projectId }.maxByOrNull { it.value.size }?.key
            ?: res.projects.firstOrNull { it.running }?.id

    fun upsertNeed(item: NeedItem) = needs.update { n ->
        n?.copy(items = n.items.filter { it.id != item.id } + item)
    }

    /** Removes an item. A held write that went away because its time ran out stays as an expired card ([keep]). */
    fun removeNeed(id: String, keep: Boolean = true) {
        val before = needs.value?.items.orEmpty()
        needs.update { n -> n?.copy(items = n.items.filter { it.id != id }) }
        if (keep) keepExpired(before, needs.value?.items.orEmpty())
    }

    private fun keepExpired(before: List<NeedItem>, after: List<NeedItem>) {
        val now = java.time.Instant.now().plusSeconds(5) // the gateway's sweep may run a moment before our clock
        val ids = after.map { it.id }.toSet()
        val gone = before.filter { it.isHeld && it.id !in ids && it.id !in dismissedHeld && Held.isExpired(it.remote!!, now) }
        if (gone.isNotEmpty()) expiredHeld.update { list -> list + gone.filter { g -> list.none { it.id == g.id } } }
    }

    /** Dismiss on an expired card. */
    fun dismissHeld(id: String) {
        dismissedHeld += id
        expiredHeld.update { list -> list.filter { it.id != id } }
        heldMaybeSent.update { it - id }
        heldErrors.update { it - id }
        removeNeed(id, keep = false)
    }

    /** Marks a held item expired now (its send got 404). */
    fun expireHeld(item: NeedItem) {
        expiredHeld.update { list -> if (list.any { it.id == item.id }) list else list + item }
        heldErrors.update { it - item.id }
        removeNeed(item.id, keep = false)
    }

    /** Send on a held card: posts the digest exactly as received. */
    suspend fun sendHeld(item: NeedItem): SendOutcome {
        val r = item.remote ?: return SendOutcome.Failed("This card has nothing to send.")
        val b = backend() ?: return SendOutcome.Failed("This phone isn't linked to a PC.")
        val out = try {
            SendOutcome.Sent(b.sendPending(item.projectId, r.pendingId, r.digest)).also { offline.value = false }
        } catch (e: UnlinkedException) {
            onUnlinked()
            SendOutcome.Failed(e.message ?: "Unlinked")
        } catch (e: OfflineException) {
            offline.value = true
            sendUnanswered += item.id
            SendOutcome.Failed("Couldn't reach ${e.pcName}. It's still held; try again when the PC answers.")
        } catch (e: ApiException) {
            if (e.code != 404) sendUnanswered -= item.id // the gateway still had it held, so nothing went through earlier
            if (e.code == 404) SendOutcome.Gone else SendOutcome.Failed(e.message ?: "HTTP ${e.code}")
        } catch (e: Exception) {
            SendOutcome.Failed(e.message ?: "Something went wrong")
        }
        when (out) {
            is SendOutcome.Sent -> {
                sendUnanswered -= item.id
                heldErrors.update { it - item.id }
                removeNeed(item.id, keep = false)
            }
            SendOutcome.Gone -> {
                if (sendUnanswered.remove(item.id)) heldMaybeSent.update { it + item.id }
                expireHeld(item)
            }
            is SendOutcome.Failed -> heldErrors.update { it + (item.id to out.error) }
        }
        return out
    }

    /** Discard on a held card. A 404 means it's already gone, which is what Discard wanted. */
    suspend fun discardHeld(item: NeedItem, onError: (String) -> Unit): Boolean {
        val r = item.remote ?: return false
        var gone = false
        val ok = call({ msg -> onError(msg) }) {
            try {
                discardPending(item.projectId, r.pendingId)
            } catch (e: ApiException) {
                if (e.code != 404) throw e
                gone = true
            }
        } != null || gone
        if (ok) {
            heldErrors.update { it - item.id }
            removeNeed(item.id, keep = false)
        }
        return ok
    }

    suspend fun loadPrefs(): Prefs? {
        val p = call { prefs() } ?: return prefs.value
        prefs.value = p
        if (!demo.value) store.cachedPrefs = p
        return p
    }

    suspend fun savePrefs(p: Prefs, onError: (String) -> Unit) {
        val old = prefs.value
        prefs.value = p
        val saved = call(onError) { putPrefs(p) }
        if (saved == null) {
            prefs.value = old
        } else {
            prefs.value = saved
            if (!demo.value) store.cachedPrefs = saved
        }
    }

    fun completePairing(newLink: Link, workingHost: String) {
        store.save(newLink)
        store.workingHost = workingHost
        link.value = newLink
        api = null
    }

    /** Starts the listener service and the 15-minute fallback poll. */
    fun startListening() {
        if (demo.value || link.value == null) return
        EventService.start(app)
        PollWorker.schedule(app)
    }

    suspend fun unlink() {
        if (demo.value) {
            exitDemo()
            return
        }
        runCatching { backend()?.unlink() }
        onUnlinked()
    }

    fun onUnlinked() {
        EventService.stop(app)
        WorkManager.getInstance(app).cancelUniqueWork(PollWorker.NAME)
        Notifier.cancelAll(app)
        store.clear()
        api = null
        link.value = null
        needs.value = null
        prefs.value = null
        selectedProject.value = null
        projectChosen = false
        offline.value = false
        clearHeld()
    }

    private fun clearHeld() {
        expiredHeld.value = emptyList()
        heldErrors.value = emptyMap()
        heldMaybeSent.value = emptySet()
        sendUnanswered.clear()
        dismissedHeld.clear()
        focusHeld.value = null
    }

    /** Debug demo. [held] adds held remote writes (goal, reply, answer, expired); [holdOff] shows the hold-off banner. */
    fun enterDemo(held: Set<String> = emptySet(), holdOff: Boolean = false, sendFails: Boolean = false) {
        demoBackend = DemoBackend(held, holdOff, sendFails)
        demo.value = true
        needs.value = null
        projectChosen = false
        selectedProject.value = null
        clearHeld()
    }

    fun exitDemo() {
        demo.value = false
        demoBackend = null
        clearHeld()
        needs.value = null
        prefs.value = store.cachedPrefs
        selectedProject.value = null
        projectChosen = false
    }
}

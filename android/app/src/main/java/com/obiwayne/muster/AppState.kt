package com.obiwayne.muster

import android.app.Application
import androidx.work.WorkManager
import com.obiwayne.muster.data.Api
import com.obiwayne.muster.data.Backend
import com.obiwayne.muster.data.DemoBackend
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
data class OpenTarget(val kind: String, val projectId: String, val taskId: String?, val noteId: String?)

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

    fun setNeeds(res: NeedsResponse) {
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

    fun removeNeed(id: String) = needs.update { n -> n?.copy(items = n.items.filter { it.id != id }) }

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
    }

    fun enterDemo() {
        demoBackend = DemoBackend()
        demo.value = true
        needs.value = null
        projectChosen = false
        selectedProject.value = null
    }

    fun exitDemo() {
        demo.value = false
        demoBackend = null
        needs.value = null
        prefs.value = store.cachedPrefs
        selectedProject.value = null
        projectChosen = false
    }
}

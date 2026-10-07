package com.obiwayne.muster.notify

import android.content.Context
import com.obiwayne.muster.AppState
import com.obiwayne.muster.data.NeedItem
import com.obiwayne.muster.data.Prefs
import com.obiwayne.muster.data.QuietHours
import com.obiwayne.muster.data.ServerEvent
import java.time.LocalTime

/** Turns needs (from the WebSocket or a poll) into notifications, once per item. */
object NeedsSync {
    private fun minuteNow(): Int = LocalTime.now().let { it.hour * 60 + it.minute }

    private fun prefs(state: AppState): Prefs = state.prefs.value ?: state.store.cachedPrefs ?: Prefs()

    fun notifyIfNew(ctx: Context, state: AppState, item: NeedItem, filter: Boolean = true) {
        val seen = state.store.notifiedIds
        if (item.id in seen) return
        state.store.notifiedIds = seen + item.id
        if (filter && !QuietHours.shouldNotify(item, prefs(state), minuteNow())) return
        Notifier.postNeed(ctx, item, state.pcName)
    }

    /** Fetches /api/needs, notifies what is new and clears notifications for items that went away. */
    suspend fun poll(ctx: Context, state: AppState): Boolean {
        if (state.demo.value) return false
        val res = state.refreshNeeds() ?: return false
        if (state.prefs.value == null) state.loadPrefs()
        val ids = res.items.map { it.id }.toSet()
        val seen = state.store.notifiedIds
        for (gone in seen - ids) Notifier.cancel(ctx, gone)
        state.store.notifiedIds = seen intersect ids
        res.items.sortedBy { it.createdAt }.forEach { notifyIfNew(ctx, state, it) }
        return true
    }

    fun onEvent(ctx: Context, state: AppState, ev: ServerEvent) {
        when (ev) {
            is ServerEvent.Need -> {
                state.upsertNeed(ev.item)
                // The gateway already applied this device's prefs: need_silent only updates the list.
                if (ev.notify) notifyIfNew(ctx, state, ev.item, filter = false)
            }
            is ServerEvent.Resolved -> {
                state.removeNeed(ev.id)
                Notifier.cancel(ctx, ev.id)
                state.store.notifiedIds = state.store.notifiedIds - ev.id
            }
            ServerEvent.Test -> Notifier.test(ctx, state.pcName)
            is ServerEvent.Hosts -> state.updateHosts(ev.hosts)
            else -> Unit
        }
    }
}

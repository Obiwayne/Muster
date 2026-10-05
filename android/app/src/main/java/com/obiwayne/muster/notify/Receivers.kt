package com.obiwayne.muster.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import com.obiwayne.muster.MusterApp
import com.obiwayne.muster.data.AnswerChoice
import com.obiwayne.muster.data.ApiException
import com.obiwayne.muster.data.AskOption
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** APPROVE, REPLY, ANSWER and DISCARD (a held remote write) from a notification: calls the gateway, then updates the notification. */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext
        val state = MusterApp.state
        val itemId = intent.getStringExtra(Notifier.EXTRA_ITEM) ?: return
        val kind = intent.getStringExtra(Notifier.EXTRA_KIND) ?: "review"
        val pid = intent.getStringExtra(Notifier.EXTRA_PROJECT) ?: return
        val tid = intent.getStringExtra(Notifier.EXTRA_TASK)
        val nid = intent.getStringExtra(Notifier.EXTRA_NOTE)
        val projectName = state.needs.value?.projects?.firstOrNull { it.id == pid }?.name
        val pending = goAsync()
        scope.launch {
            try {
                when (intent.action) {
                    ACTION_APPROVE -> {
                        if (tid == null) return@launch
                        var error: String? = null
                        val ok = state.call({ error = it }) { approve(pid, tid) } != null
                        if (ok) {
                            state.removeNeed(itemId)
                            Notifier.postStatus(app, itemId, kind, projectName, "Approved $tid", "The Captain merges it and pushes.", 4000)
                        } else {
                            Notifier.postStatus(app, itemId, kind, projectName, "Couldn't approve $tid", error ?: "Try again from the app.", null)
                        }
                    }
                    ACTION_REPLY -> {
                        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifier.KEY_REPLY)?.toString()?.trim()
                        if (nid == null || text.isNullOrEmpty()) return@launch
                        var error: String? = null
                        val ok = state.call({ error = it }) { reply(pid, nid, text) } != null
                        if (ok) {
                            Notifier.postStatus(app, itemId, kind, projectName, "Answer sent", text, 4000)
                        } else {
                            Notifier.postStatus(app, itemId, kind, projectName, "Couldn't send your answer", error ?: "Try again from the app.", null)
                        }
                    }
                    ACTION_DISCARD -> {
                        val pendingId = intent.getStringExtra(Notifier.EXTRA_PENDING) ?: return@launch
                        var error: String? = null
                        val ok = state.call({ error = it }) {
                            try {
                                discardPending(pid, pendingId)
                            } catch (e: ApiException) {
                                if (e.code != 404) throw e // 404: already gone, which is what Discard wanted
                            }
                        } != null
                        if (ok) {
                            state.removeNeed(itemId, keep = false)
                            Notifier.postStatus(app, itemId, kind, projectName, "Discarded $pendingId", "Nothing was sent.", 4000)
                        } else {
                            Notifier.postStatus(app, itemId, kind, projectName, "Couldn't discard $pendingId", error ?: "Open Muster to discard it.", null)
                        }
                    }
                    ACTION_ANSWER -> {
                        val choice = intent.getStringExtra(Notifier.EXTRA_CHOICE)
                        if (nid == null || choice == null) return@launch
                        var error: String? = null
                        val ok = state.call({ error = it }) { answer(pid, nid, listOf(AnswerChoice(listOf(choice)))) } != null
                        if (ok) {
                            state.removeNeed(itemId)
                            val shown = AskOption(choice).shownLabel
                            Notifier.postStatus(app, itemId, kind, projectName, "Answer sent", shown, 4000)
                        } else {
                            Notifier.postStatus(app, itemId, kind, projectName, "Couldn't send your answer", error ?: "Try again from the app.", null)
                        }
                    }
                }
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_APPROVE = "com.obiwayne.muster.APPROVE"
        const val ACTION_REPLY = "com.obiwayne.muster.REPLY"
        const val ACTION_ANSWER = "com.obiwayne.muster.ANSWER"
        const val ACTION_DISCARD = "com.obiwayne.muster.DISCARD"
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }
}

/** Starts listening again after a reboot or an app update, when the phone is linked. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val state = MusterApp.state
        if (state.link.value == null) return
        PollWorker.schedule(context)
        try {
            EventService.start(context)
        } catch (_: Exception) {
            // Background start refused: the 15-minute poll still runs.
        }
    }
}

package com.obiwayne.muster.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.media.AudioAttributes
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import com.obiwayne.muster.MainActivity
import com.obiwayne.muster.R
import com.obiwayne.muster.data.AskText
import com.obiwayne.muster.data.Kind
import com.obiwayne.muster.data.NeedItem

object Notifier {
    const val CH_REVIEWS = "reviews"
    const val CH_QUESTIONS = "questions"
    const val CH_BLOCKED = "blocked"
    const val CH_OTHER = "other"
    const val CH_SERVICE = "service"

    const val EXTRA_KIND = "muster.kind"
    const val EXTRA_PROJECT = "muster.project"
    const val EXTRA_TASK = "muster.task"
    const val EXTRA_NOTE = "muster.note"
    const val EXTRA_ITEM = "muster.item"
    const val EXTRA_TITLE = "muster.title"
    const val EXTRA_CHOICE = "muster.choice"
    const val KEY_REPLY = "muster.reply"

    const val SERVICE_ID = 1
    private const val CREW = 0xFF2DD4BF.toInt()

    /** Alert channels carry their sound, so their real ids are `<base>_v<version>` (see [AlertSound]). */
    private val ALERT_BASES = listOf(CH_REVIEWS, CH_QUESTIONS, CH_BLOCKED, CH_OTHER)

    @Volatile
    private var version = 1

    /** The current id of an alert channel ([CH_REVIEWS], [CH_QUESTIONS], [CH_BLOCKED] or [CH_OTHER]). */
    fun channelId(base: String) = "${base}_v$version"

    @Synchronized
    fun createChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        var p = AlertSound.load(ctx)
        val chosen = p.uri
        if (p.play && chosen != null && !AlertSound.readable(ctx, chosen)) {
            // The chosen sound is gone: fall back to the phone's default.
            p = p.copy(uri = null)
            AlertSound.save(ctx, p)
        }
        version = AlertSound.version(ctx)
        val sound = AlertSound.soundUri(p)
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

        fun alert(base: String, name: String, importance: Int, about: String) =
            NotificationChannel(channelId(base), name, importance).apply {
                description = about
                setSound(sound, if (sound == null) null else attrs)
                enableVibration(p.vibrate)
            }

        nm.createNotificationChannels(
            listOf(
                alert(CH_REVIEWS, "Reviews", NotificationManager.IMPORTANCE_HIGH, "Work the Captain reviewed and that waits for your approval"),
                alert(CH_QUESTIONS, "Questions", NotificationManager.IMPORTANCE_HIGH, "The Captain or the crew asking you something"),
                alert(CH_BLOCKED, "Blocked merges", NotificationManager.IMPORTANCE_HIGH, "A merge waits on uncommitted files on your PC"),
                alert(CH_OTHER, "Other", NotificationManager.IMPORTANCE_DEFAULT, "Usage alerts and stuck agents"),
                NotificationChannel(CH_SERVICE, "Connection", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "The ongoing notification that keeps Muster listening to your PC"
                    setShowBadge(false)
                },
            ),
        )
        // Drop older alert channels, including the unversioned ids from before alert sounds, so system settings show one set.
        val current = ALERT_BASES.map(::channelId).toSet()
        nm.notificationChannels
            .map { it.id }
            .filter { id -> id !in current && ALERT_BASES.any { id == it || id.startsWith(it + "_v") } }
            .forEach(nm::deleteNotificationChannel)
    }

    fun canPost(ctx: Context) =
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED &&
            NotificationManagerCompat.from(ctx).areNotificationsEnabled()

    private fun notifId(itemId: String) = itemId.hashCode() and 0x7fffffff or 0x100

    fun openIntent(ctx: Context, item: NeedItem): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            action = "muster.open." + item.id
            putExtra(EXTRA_KIND, item.kind)
            putExtra(EXTRA_PROJECT, item.projectId)
            putExtra(EXTRA_TASK, item.taskId)
            putExtra(EXTRA_NOTE, item.noteId)
        }
        return PendingIntent.getActivity(ctx, notifId(item.id), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun actionIntent(ctx: Context, action: String, item: NeedItem, mutable: Boolean, choice: Int? = null): PendingIntent {
        val i = Intent(ctx, ActionReceiver::class.java).apply {
            this.action = action
            data = android.net.Uri.parse("muster://item/" + android.net.Uri.encode(item.id)) // unique per item
            putExtra(EXTRA_ITEM, item.id)
            putExtra(EXTRA_KIND, item.kind)
            putExtra(EXTRA_PROJECT, item.projectId)
            putExtra(EXTRA_TASK, item.taskId)
            putExtra(EXTRA_NOTE, item.noteId)
            putExtra(EXTRA_TITLE, item.taskId ?: item.noteId ?: "")
            choice?.let { putExtra(EXTRA_CHOICE, item.ask[0].options[it].label) }
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(ctx, notifId(item.id) + action.hashCode() + (choice ?: 0), i, flags)
    }

    fun channelFor(kind: String) = when (kind) {
        Kind.REVIEW, Kind.APPROVAL -> channelId(CH_REVIEWS)
        Kind.QUESTION, Kind.ESCALATION -> channelId(CH_QUESTIONS)
        Kind.BLOCKED -> channelId(CH_BLOCKED)
        else -> channelId(CH_OTHER)
    }

    /** Title and text as M08 shows them. */
    fun content(item: NeedItem, pcName: String): Pair<String, String> = when (item.kind) {
        Kind.REVIEW -> "Ready for review: ${item.taskId ?: item.title}" to listOf(item.title, item.summary).filter { it.isNotBlank() }
            .joinToString(". ") { it.trimEnd('.') } + "."
        Kind.APPROVAL -> "Waiting for your approval: ${item.taskId ?: ""}".trim() to item.title
        Kind.QUESTION -> (if (item.from.isBlank() || item.from == "captain") "The Captain has a question" else "${item.from} has a question") to
            item.summary.ifBlank { item.title }
        Kind.ESCALATION -> if (item.ask.isNotEmpty()) {
            "The Captain asks you" to AskText.summary(item.ask)
        } else {
            "The Captain needs a decision" to item.summary.ifBlank { item.title }
        }
        Kind.BLOCKED -> "Merge blocked" to item.summary.ifBlank { "Uncommitted files on $pcName" }
        Kind.USAGE -> "Usage alert" to item.summary.ifBlank { item.title }
        Kind.STUCK -> "${item.from.ifBlank { "An agent" }} is stuck" to item.summary.ifBlank { item.title }
        else -> item.title to item.summary
    }

    fun postNeed(ctx: Context, item: NeedItem, pcName: String) {
        if (!canPost(ctx)) return
        val (title, text) = content(item, pcName)
        val b = NotificationCompat.Builder(ctx, channelFor(item.kind))
            .setSmallIcon(R.drawable.ic_stat_muster)
            .setColor(CREW)
            .setContentTitle(title)
            .setContentText(if (item.ask.isNotEmpty()) item.ask[0].question else text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSubText(item.projectName.ifBlank { null })
            .setContentIntent(openIntent(ctx, item))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(if (item.isQuestion) NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setWhen(com.obiwayne.muster.data.Ago.parse(item.createdAt)?.toEpochMilli() ?: System.currentTimeMillis())
            .setShowWhen(true)

        when {
            item.isReview && item.canApprove -> {
                val approve = NotificationCompat.Action.Builder(0, "Approve", actionIntent(ctx, ActionReceiver.ACTION_APPROVE, item, false))
                    .setAuthenticationRequired(true) // unlock first (M08)
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_NONE)
                    .setShowsUserInterface(false)
                    .build()
                b.addAction(approve)
                b.addAction(NotificationCompat.Action.Builder(0, "Open", openIntent(ctx, item)).build())
            }
            quickAsk(item) -> {
                // One single-select question with up to three options: one tap per option, after unlocking (ASK.md).
                item.ask[0].options.forEachIndexed { i, o ->
                    val label = o.shownLabel.let { if (it.length > 24) it.take(23).trimEnd() + "…" else it }
                    b.addAction(
                        NotificationCompat.Action.Builder(0, label, actionIntent(ctx, ActionReceiver.ACTION_ANSWER, item, false, i))
                            .setAuthenticationRequired(true)
                            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_NONE)
                            .setShowsUserInterface(false)
                            .build(),
                    )
                }
            }
            item.isQuestion && item.noteId != null -> {
                // Quick answers from "A or B?" become one-tap choices (the M06 chips), instead of generic smart replies.
                val choices = com.obiwayne.muster.data.QuickAnswers.from(item.summary.ifBlank { item.title })
                val input = RemoteInput.Builder(KEY_REPLY).setLabel("Reply to the Captain…")
                    .apply { if (choices.isNotEmpty()) setChoices(choices.toTypedArray()) }
                    .build()
                val reply = NotificationCompat.Action.Builder(0, "Reply", actionIntent(ctx, ActionReceiver.ACTION_REPLY, item, true))
                    .addRemoteInput(input)
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                    .setShowsUserInterface(false)
                    .setAllowGeneratedReplies(false)
                    .build()
                b.addAction(reply)
            }
            else -> b.addAction(NotificationCompat.Action.Builder(0, "Open", openIntent(ctx, item)).build())
        }
        try {
            NotificationManagerCompat.from(ctx).notify(item.id, notifId(item.id), b.build())
        } catch (_: SecurityException) {
        }
    }

    /** An ask item that fits as one-tap notification actions: one single-select question, 1–3 options. */
    fun quickAsk(item: NeedItem) = item.noteId != null && item.ask.size == 1 && !item.ask[0].multiSelect && item.ask[0].options.size in 1..3

    /** Replaces an item's notification with a short status line (after an action from the shade). */
    fun postStatus(ctx: Context, itemId: String, kind: String, projectName: String?, title: String, text: String, timeoutMs: Long?) {
        if (!canPost(ctx)) return
        val b = NotificationCompat.Builder(ctx, channelFor(kind))
            .setSmallIcon(R.drawable.ic_stat_muster)
            .setColor(CREW)
            .setContentTitle(title)
            .setContentText(text)
            .setSubText(projectName)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setAutoCancel(true)
            .setContentIntent(
                PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE),
            )
        if (timeoutMs != null) b.setTimeoutAfter(timeoutMs)
        try {
            NotificationManagerCompat.from(ctx).notify(itemId, notifId(itemId), b.build())
        } catch (_: SecurityException) {
        }
    }

    fun cancel(ctx: Context, itemId: String) = NotificationManagerCompat.from(ctx).cancel(itemId, notifId(itemId))

    fun cancelAll(ctx: Context) = NotificationManagerCompat.from(ctx).cancelAll()

    fun service(ctx: Context, pcName: String, connected: Boolean) =
        NotificationCompat.Builder(ctx, CH_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_muster)
            .setColor(CREW)
            .setContentTitle(if (connected) "Listening to $pcName" else "Reconnecting to $pcName…")
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
            .build()

    fun test(ctx: Context, pcName: String) {
        if (!canPost(ctx)) return
        val n = NotificationCompat.Builder(ctx, channelId(CH_OTHER))
            .setSmallIcon(R.drawable.ic_stat_muster)
            .setColor(CREW)
            .setContentTitle("Test from $pcName")
            .setContentText("Notifications from Muster reach this phone.")
            .setAutoCancel(true)
            .build()
        try {
            NotificationManagerCompat.from(ctx).notify("test", 2, n)
        } catch (_: SecurityException) {
        }
    }

    const val SOUND_TEST_TAG = "sound-test"

    /** M09 "Test": a sample alert on the questions channel, so it sounds and vibrates like a real one. False if it can't post. */
    fun testAlert(ctx: Context): Boolean {
        if (!canPost(ctx)) return false
        val n = NotificationCompat.Builder(ctx, channelId(CH_QUESTIONS))
            .setSmallIcon(R.drawable.ic_stat_muster)
            .setColor(CREW)
            .setContentTitle("The Captain has a question")
            .setContentText("This is how Muster alerts sound on this phone.")
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setTimeoutAfter(15_000)
            .setContentIntent(PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
            .build()
        return try {
            NotificationManagerCompat.from(ctx).notify(SOUND_TEST_TAG, 3, n)
            true
        } catch (_: SecurityException) {
            false
        }
    }
}

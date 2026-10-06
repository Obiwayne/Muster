package com.obiwayne.muster.data

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale

/** Quiet hours and per-kind notification filtering (PHONE.md, prefs). */
object QuietHours {
    /** "22:00" -> 1320; null if malformed. */
    fun parse(hhmm: String): Int? {
        val parts = hhmm.trim().split(':')
        if (parts.size != 2) return null
        val h = parts[0].toIntOrNull() ?: return null
        val m = parts[1].toIntOrNull() ?: return null
        if (h !in 0..23 || m !in 0..59) return null
        return h * 60 + m
    }

    fun format(minutes: Int): String = "%02d:%02d".format(minutes / 60, minutes % 60)

    /** True when [minuteOfDay] falls inside [from, to), wrapping past midnight. Equal ends mean no quiet time. */
    fun isQuiet(q: QuietPrefs, minuteOfDay: Int): Boolean {
        if (!q.on) return false
        val from = parse(q.from) ?: return false
        val to = parse(q.to) ?: return false
        if (from == to) return false
        return if (from < to) minuteOfDay in from until to else minuteOfDay >= from || minuteOfDay < to
    }

    /** Which prefs switch governs a need kind. */
    fun category(kind: String): String = when (kind) {
        Kind.REVIEW, Kind.APPROVAL -> "review"
        Kind.QUESTION, Kind.ESCALATION, Kind.REMOTE_WRITE -> "question"
        Kind.BLOCKED -> "blocked"
        Kind.USAGE -> "usage"
        Kind.STUCK -> "stuck"
        else -> "other"
    }

    fun shouldNotify(item: NeedItem, prefs: Prefs, minuteOfDay: Int): Boolean {
        if (prefs.projects[item.projectId] == false) return false
        val on = when (category(item.kind)) {
            "review" -> prefs.notify.review
            "question" -> prefs.notify.question
            "blocked" -> prefs.notify.blocked
            "usage" -> prefs.notify.usage
            "stuck" -> prefs.notify.stuck
            else -> false
        }
        if (!on) return false
        // A held remote write is something you just asked for in the Claude app: it ignores quiet hours (as the gateway does).
        if (isQuiet(prefs.quiet, minuteOfDay) && item.kind != Kind.BLOCKED && item.kind != Kind.REMOTE_WRITE) return false
        return true
    }
}

/** Text rules for the held-write Send card and the "hold is off" banner (REMOTE.md, milestone 4). */
object Held {
    /** Under this many seconds the countdown turns warm orange. */
    const val WARN_SECONDS = 180L

    fun secondsLeft(r: RemoteWrite, now: Instant = Instant.now()): Long? =
        Ago.parse(r.expiresAt)?.let { Duration.between(now, it).seconds }

    /**
     * Past `expiresAt`: still held (the gateway never drops a held write on time), just overdue. Send and Discard
     * both still work; the card shows [waitingSince] instead of the countdown.
     */
    fun isOverdue(r: RemoteWrite, now: Instant = Instant.now()): Boolean = (secondsLeft(r, now) ?: 1) <= 0

    /** "12:41 left"; "0:00 left" at the end. Empty when the time can't be read. */
    fun countdown(r: RemoteWrite, now: Instant = Instant.now()): String {
        val s = secondsLeft(r, now)?.coerceAtLeast(0) ?: return ""
        return "%d:%02d left".format(s / 60, s % 60)
    }

    /** "Waiting since 14:00 · still not sent" for an overdue card (the time Claude asked). */
    fun waitingSince(r: RemoteWrite, zone: ZoneId = ZoneId.systemDefault()): String {
        val t = clockTime(r.createdAt.ifBlank { null }, zone)
        return if (t.isEmpty()) "Still not sent" else "Waiting since $t · still not sent"
    }

    fun clockTime(iso: String?, zone: ZoneId = ZoneId.systemDefault()): String =
        iso?.let(Ago::parse)?.atZone(zone)?.let { "%02d:%02d".format(it.hour, it.minute) } ?: ""

    /** "HELD · GOAL" */
    fun chip(r: RemoteWrite) = "HELD · " + r.kind.uppercase().ifEmpty { "WRITE" }

    private fun questions(n: Int) = if (n == 1) "question" else "$n questions"

    /** "Claude wants to give the Captain a goal". */
    fun title(item: NeedItem, r: RemoteWrite): String {
        val who = r.client.ifBlank { "Claude" }
        val verb = "wants to"
        val note = r.replyTo?.id?.ifBlank { null } ?: item.noteId ?: "a note"
        return when (r.kind) {
            WriteKind.GOAL -> "$who $verb give the Captain a goal"
            WriteKind.REPLY -> "$who $verb reply on $note"
            WriteKind.ANSWER -> "$who $verb answer the Captain's ${questions(r.answers.size.coerceAtLeast(1))} on $note"
            WriteKind.APPROVE -> "$who $verb approve ${r.taskId ?: item.taskId ?: "a task"} for merge"
            else -> item.title.ifBlank { "$who $verb send something" }
        }
    }

    /** The route chip after "To": "StarCut · Captain", "StarCut · note N12", "StarCut · T58". */
    fun route(item: NeedItem, r: RemoteWrite): String {
        val project = r.projectName.ifBlank { item.projectName }
        val target = when (r.kind) {
            WriteKind.REPLY -> "note " + (r.replyTo?.id?.ifBlank { null } ?: item.noteId ?: "")
            WriteKind.APPROVE -> r.taskId ?: item.taskId ?: ""
            else -> "Captain"
        }.trim()
        return listOf(project, target).filter { it.isNotBlank() }.joinToString(" · ")
    }

    /** "asked 2 min ago in the Claude app" */
    fun asked(r: RemoteWrite, now: Instant = Instant.now()): String {
        val t = Ago.parse(r.createdAt)
        val ago = if (t == null) "" else {
            val m = Duration.between(t, now).toMinutes().coerceAtLeast(0)
            when {
                m < 1 -> "just now"
                m < 60 -> "$m min ago"
                else -> "${m / 60} h ago"
            }
        }
        val where = r.client.let { if (it.isBlank() || it.equals("claude", ignoreCase = true)) "in the Claude app" else "via $it" }
        return listOf("asked", ago, where).filter { it.isNotBlank() }.joinToString(" ")
    }

    /** The line under "Nothing has been sent yet." */
    fun lockText(r: RemoteWrite): String {
        val who = r.client.ifBlank { "Claude" }
        return when (r.kind) {
            WriteKind.REPLY -> {
                val from = r.replyTo?.from?.ifBlank { null }
                val to = if (from == null || from == "captain") "the Captain" else "$from and the Captain"
                "Locked. It reaches $to, as yours via $who, only when you tap Send."
            }
            WriteKind.ANSWER -> if (r.answers.size > 1) "Locked. They reach the Captain, as yours via $who, only when you tap Send."
            else "Locked. It reaches the Captain, as yours via $who, only when you tap Send."
            WriteKind.APPROVE -> "Locked. The Captain merges and pushes ${r.taskId ?: "it"} only when you tap Send."
            else -> "Locked. It reaches the Captain, as yours via $who, only when you tap Send."
        }
    }

    /** "off since 14:40 · 3 sent without your tap" */
    fun holdLine(h: HoldInfo, zone: ZoneId = ZoneId.systemDefault()): String {
        val since = clockTime(h.offSince, zone)
        return listOfNotNull(
            since.ifEmpty { null }?.let { "off since $it" },
            "${h.sentWithoutTap} sent without your tap",
        ).joinToString(" · ")
    }
}

/** Short relative times as the designs show them: "now", "4m", "2h", "3d". */
object Ago {
    fun short(iso: String, now: Instant = Instant.now()): String {
        val t = parse(iso) ?: return ""
        val s = Duration.between(t, now).seconds.coerceAtLeast(0)
        return when {
            s < 60 -> "now"
            s < 3600 -> "${s / 60}m"
            s < 86400 -> "${s / 3600}h"
            else -> "${s / 86400}d"
        }
    }

    fun long(iso: String, now: Instant = Instant.now()): String {
        val s = short(iso, now)
        return if (s.isEmpty() || s == "now") "just now" else "$s ago"
    }

    /** "resets 2h 10m" within a day, "resets Mon" beyond. */
    fun resets(iso: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        val t = iso?.let(::parse) ?: return ""
        val d = Duration.between(now, t)
        if (d.isNegative) return "resets now"
        val mins = d.toMinutes()
        return when {
            mins < 60 -> "resets ${mins}m"
            mins < 12 * 60 -> "resets ${mins / 60}h ${mins % 60}m"
            else -> "resets " + t.atZone(zone).dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault())
        }
    }

    fun parse(iso: String): Instant? = try {
        Instant.parse(iso)
    } catch (_: Exception) {
        null
    }
}

/** One line of the Captain's review as M05 draws it. */
data class ReviewLine(val text: String, val style: Style, val mono: Boolean) {
    enum class Style { PASS, NOTE, TEXT }
}

object ReviewText {
    private val bullet = Regex("^\\s*(?:[-*•✓✔]|\\[x]|\\[ ])\\s+")
    private val noteWords = Regex("^(minor|nit|note|follow[- ]?up|todo|later)\\b", RegexOption.IGNORE_CASE)
    private val monoHint = Regex("(`[^`]+`|\\btsc\\b|\\btests? pass(ed)?\\b|\\bnpm\\b|\\bvitest\\b)", RegexOption.IGNORE_CASE)

    /** Bulleted lines become check rows; "Minor:"/"Nit:" lines become amber dots. Plain prose stays as one paragraph. */
    fun lines(text: String): List<ReviewLine> {
        val raw = text.lines().map { it.trimEnd() }.filter { it.isNotBlank() }
        val bullets = raw.filter { bullet.containsMatchIn(it) }
        val source = if (bullets.isNotEmpty()) bullets else raw.drop(if (raw.size > 1) 1 else 0).ifEmpty { raw }
        return source.map { l ->
            val t = l.replace(bullet, "").trim()
            val isNote = noteWords.containsMatchIn(t) || l.trimStart().startsWith("[ ]")
            val style = if (bullets.isEmpty()) ReviewLine.Style.TEXT else if (isNote) ReviewLine.Style.NOTE else ReviewLine.Style.PASS
            ReviewLine(t.replace("`", ""), style, monoHint.containsMatchIn(t) && t.length < 60)
        }
    }
}

/** Quick answers for a question ("A or B?" -> ["A", "B"]); M06's chips. */
object QuickAnswers {
    private val articles = setOf("a", "an", "the")

    fun from(question: String): List<String> {
        val q = question.substringBefore('?').trim()
        if (!question.contains('?')) return emptyList()
        val idx = q.lastIndexOf(" or ")
        if (idx < 0) return emptyList()
        val leftWords = q.substring(0, idx).split(' ').filter { it.isNotBlank() }
        var right = q.substring(idx + 4).trim().trimEnd(',', '.').split(' ').filter { it.isNotBlank() }
        if (right.isEmpty() || leftWords.isEmpty()) return emptyList()
        if (right.first().lowercase() in articles) right = right.drop(1)
        val lastArticle = leftWords.indexOfLast { it.lowercase() in articles }
        val left = if (lastArticle >= 0 && lastArticle < leftWords.size - 1) {
            leftWords.drop(lastArticle + 1)
        } else {
            leftWords.takeLast(right.size.coerceAtLeast(1))
        }
        if (left.size > 6 || right.size > 6 || right.isEmpty()) return emptyList()
        return listOf(left.joinToString(" "), right.joinToString(" ")).map { cap(it) }
    }

    private fun cap(s: String) = s.replaceFirstChar { it.uppercase() }
}

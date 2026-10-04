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
        Kind.QUESTION, Kind.ESCALATION -> "question"
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
        if (isQuiet(prefs.quiet, minuteOfDay) && item.kind != Kind.BLOCKED) return false
        return true
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

package com.obiwayne.muster.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.obiwayne.muster.data.Held
import com.obiwayne.muster.data.HoldInfo
import com.obiwayne.muster.data.NeedItem
import com.obiwayne.muster.data.RemoteQuestion
import com.obiwayne.muster.data.RemoteWrite
import com.obiwayne.muster.data.WriteKind
import kotlinx.coroutines.delay
import java.time.Instant

/*
 * The Needs-you Send card for a write from the Claude app held for your tap (REMOTE.md, "Needs-you Send card"; Vellum
 * M10–M12 and "Send card — failed state"). Two pieces, so another layout (a tablet list + detail pane) can
 * host them apart: [SendCardBody] (what will be sent, never truncated) and [SendCardActions] (the "Nothing has been sent
 * yet" callout with Send / Discard at equal width). [SendCard] stacks both in one card; the phone's Needs tab pins the
 * actions above the tab bar when the card is taller than the screen.
 *
 * A held write never runs out: past `expiresAt` it is only overdue (amber "Waiting since … · still not sent" instead of
 * the countdown) and Send / Discard keep working until you tap one. A card that vanishes from /needs was sent or
 * discarded elsewhere.
 */

/** What a held card is doing. */
sealed interface HeldPhase {
    data object Held : HeldPhase
    data object Sending : HeldPhase
    data object Discarding : HeldPhase

    /** 409 or no answer: still held and unchanged; offers Try again / Discard. */
    data class Failed(val error: String) : HeldPhase
}

/** The current time, ticking once a second (aligned to the second, so countdowns change together). */
@Composable
fun rememberNow(): Instant {
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000L - System.currentTimeMillis() % 1000L)
            now = Instant.now()
        }
    }
    return now
}

/** The card's phase: busy, failed or held (an overdue card is still held). */
fun heldPhase(busy: String?, error: String?): HeldPhase {
    return when {
        busy == "send" -> HeldPhase.Sending
        busy == "discard" -> HeldPhase.Discarding
        error != null -> HeldPhase.Failed(error)
        else -> HeldPhase.Held
    }
}

/** The whole card: body plus (unless [showActions] is false, i.e. pinned elsewhere) the callout and buttons. */
@Composable
fun SendCard(
    item: NeedItem,
    phase: HeldPhase,
    showActions: Boolean,
    onSend: () -> Unit,
    onDiscard: () -> Unit,
    modifier: Modifier = Modifier,
    bodyModifier: Modifier = Modifier,
) {
    Column(
        modifier.fillMaxWidth().card(bg = C.mix(C.glowBlue, 7, C.surface), border = C.tint(C.glowBlue, 45)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SendCardBody(item, bodyModifier)
        if (showActions) SendCardActions(item, phase, onSend, onDiscard)
    }
}

/** Meta row, title, route, the quoted note (reply/answer) and the exact text. Never truncated. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SendCardBody(item: NeedItem, modifier: Modifier = Modifier) {
    val r = item.remote ?: return
    val now = rememberNow()
    val overdue = Held.isOverdue(r, now)
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        // HELD · GOAL   P7 ………… ⏱ 12:41 left
        Row(Modifier.fillMaxWidth().height(24.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Tag(Held.chip(r), C.heldInk, C.tint(C.glowBlue, 18))
            Txt(r.pendingId, ts(12, 16, color = C.muted, mono = true))
            Spacer(Modifier.weight(1f))
            if (!overdue) {
                val left = Held.secondsLeft(r, now)
                TimePill(Held.countdown(r, now), warn = left != null && left < Held.WARN_SECONDS)
            }
        }
        // Overdue: still held, so no countdown; how long it has waited, in the same amber as the last 3 minutes. On
        // its own line, as it's too long to share the meta row on a phone.
        if (overdue) TimePill(Held.waitingSince(r), warn = true)
        // Title, route, who asked and when.
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Txt(Held.title(item, r), ts(16, 22, FontWeight.SemiBold, C.text))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Txt("To", ts(13, 18, color = C.muted), Modifier.align(Alignment.CenterVertically))
                Row(
                    Modifier.align(Alignment.CenterVertically).clip(RoundedCornerShape(50)).background(C.surface2).padding(horizontal = 8.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    val dot = if (r.kind == WriteKind.REPLY) agentColor(r.replyTo?.from ?: "captain") else C.captain
                    Dot(dot, 6.dp)
                    Txt(Held.route(item, r), ts(13, 18, FontWeight.Medium, C.text))
                }
                Txt(Held.asked(r, now), ts(13, 18, color = C.faint), Modifier.align(Alignment.CenterVertically))
            }
        }
        // The question menu travels with a held answer (replyTo.questions): each answer shows under its question, and
        // the quote is left out (M12).
        val ask = r.replyTo?.questions.orEmpty()
        val inlineQuestions = r.kind == WriteKind.ANSWER && ask.isNotEmpty()
        if ((r.kind == WriteKind.REPLY || r.kind == WriteKind.ANSWER) && r.replyTo != null && !inlineQuestions) {
            ReplyingTo(r)
        }
        when (r.kind) {
            WriteKind.ANSWER -> AnswersBox(r, ask)
            WriteKind.APPROVE -> ExactBox("WILL APPROVE THIS FOR MERGE", listOfNotNull(r.taskId, r.taskTitle).joinToString(" · "))
            else -> ExactBox("WILL SEND EXACTLY THIS", r.text.orEmpty())
        }
    }
}

/** The timer pill: the countdown, or the overdue line; warm (amber) when [warn]. */
@Composable
private fun TimePill(label: String, warn: Boolean) {
    Row(
        Modifier.clip(RoundedCornerShape(50)).background(if (warn) C.tint(C.warm, 12) else Color.Transparent)
            .border(1.dp, if (warn) C.tint(C.warm, 55) else C.line, RoundedCornerShape(50))
            .padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Icon(Ic.timer, null, tint = C.muted, modifier = Modifier.size(12.dp))
        Txt(label.trim(), ts(12, 16, color = if (warn) C.warm else C.text, mono = true))
    }
}

@Composable
private fun Tag(text: String, fg: Color, bg: Color) {
    Box(Modifier.clip(RoundedCornerShape(5.dp)).background(bg).padding(horizontal = 7.dp, vertical = 3.dp)) {
        Txt(text, ts(11, 14, FontWeight.SemiBold, fg, spacing = Type.label.letterSpacing))
    }
}

/** A left rule like the designs' `border-left: 2px solid line`. */
private fun Modifier.leftRule(color: Color = C.line, width: Dp = 2.dp) = this.drawBehind {
    val w = width.toPx()
    drawLine(color, Offset(w / 2, 0f), Offset(w / 2, size.height), w)
}

/** The agent-written note a reply/answer goes to, as a quote (data, not a heading). */
@Composable
private fun ReplyingTo(r: RemoteWrite) {
    val q = r.replyTo ?: return
    Column(Modifier.fillMaxWidth().leftRule().padding(start = 12.dp, top = 2.dp, bottom = 2.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Txt("REPLYING TO", Type.label)
            Txt(listOf(q.id, "·", q.type, "from").filter { it.isNotBlank() }.joinToString(" "), ts(12, 16, color = C.muted, mono = true))
            Txt(q.from.ifBlank { "?" }, ts(12, 16, color = agentColor(q.from), mono = true))
        }
        Txt(q.text, ts(14, 20, color = C.muted))
        Txt("Written by an agent. Shown as it was when Claude asked.", ts(12, 16, color = C.faint))
    }
}

/** "WILL SEND EXACTLY THIS" with the full text. */
@Composable
private fun ExactBox(label: String, text: String) {
    val shape = RoundedCornerShape(10.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(C.term).border(1.dp, C.line, shape).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Txt(label, Type.label)
        SelectionContainer { Txt(text, ts(14, 21, color = C.text)) }
    }
}

/** Every answer, under its question when the note's questions are known: chips for choices, then the free text. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AnswersBox(r: RemoteWrite, ask: List<RemoteQuestion>) {
    val shape = RoundedCornerShape(10.dp)
    val n = r.answers.size
    Column(Modifier.fillMaxWidth().clip(shape).background(C.term).border(1.dp, C.line, shape)) {
        val label = when {
            n == 1 -> "WILL SEND EXACTLY THIS ANSWER"
            else -> "WILL SEND EXACTLY THESE $n ANSWERS"
        }
        Txt(label, Type.label, Modifier.padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 2.dp))
        r.answers.forEachIndexed { i, a ->
            Column(
                Modifier.fillMaxWidth()
                    .then(
                        if (i > 0) Modifier.drawBehind { drawLine(C.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) } else Modifier,
                    )
                    .padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = if (i == n - 1) 14.dp else 10.dp),
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                val q = ask.getOrNull(i)?.question?.ifBlank { null } ?: ask.getOrNull(i)?.header?.ifBlank { null } ?: "Question ${i + 1}"
                Txt("${i + 1} · $q", ts(13, 18, color = C.muted), Modifier.fillMaxWidth().leftRule().padding(start = 10.dp))
                if (a.choices.isNotEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        a.choices.forEach { c ->
                            Box(Modifier.clip(RoundedCornerShape(6.dp)).background(C.tint(C.glowBlue, 16)).padding(horizontal = 9.dp, vertical = 3.dp)) {
                                Txt(c, ts(14, 20, FontWeight.Medium, C.text))
                            }
                        }
                    }
                }
                val other = a.other?.trim().orEmpty()
                if (other.isNotEmpty()) SelectionContainer { Txt(other, ts(14, 21, color = C.text)) }
                if (a.choices.isEmpty() && other.isEmpty()) Txt("(no answer)", ts(14, 21, color = C.faint))
            }
        }
    }
}

/**
 * The "Nothing has been sent yet." callout with Send and Discard (equal width, no confirm), or the failed state. The
 * same once overdue. Shown at the bottom of the card, or pinned above the tab bar for a tall card.
 */
@Composable
fun SendCardActions(item: NeedItem, phase: HeldPhase, onSend: () -> Unit, onDiscard: () -> Unit, modifier: Modifier = Modifier) {
    val r = item.remote ?: return
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        when (phase) {
            is HeldPhase.Failed -> {
                Callout(Ic.alertSmall, C.stuck, C.tint(C.stuck, 10), C.tint(C.stuck, 45), "Send failed. Nothing was sent.", phase.error)
                Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HeldButton("Try again", Ic.refreshBold, C.glowBlue, Color.White, C.glowBlue, Modifier.weight(1f), onClick = onSend)
                    HeldButton("Discard", Ic.closeBold, C.surface2, C.text, C.line, Modifier.weight(1f), onClick = onDiscard)
                }
            }
            else -> {
                Callout(Ic.lock, C.heldInk, C.tint(C.glowBlue, 10), C.tint(C.glowBlue, 35), "Nothing has been sent yet.", Held.lockText(r))
                val working = phase == HeldPhase.Sending || phase == HeldPhase.Discarding
                Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HeldButton(
                        "Send", Ic.send, C.glowBlue, Color.White, C.glowBlue, Modifier.weight(1f),
                        busy = phase == HeldPhase.Sending, enabled = !working, onClick = onSend,
                    )
                    HeldButton(
                        "Discard", Ic.closeBold, C.surface2, C.text, C.line, Modifier.weight(1f),
                        busy = phase == HeldPhase.Discarding, enabled = !working, onClick = onDiscard,
                    )
                }
            }
        }
    }
}

@Composable
private fun Callout(icon: ImageVector, tint: Color, bg: Color, border: Color, title: String, text: String) {
    val shape = RoundedCornerShape(10.dp)
    Row(
        Modifier.fillMaxWidth().clip(shape).background(bg).border(1.dp, border, shape).padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.padding(top = 2.dp).size(15.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Txt(title, ts(14, 19, FontWeight.SemiBold))
            if (text.isNotBlank()) Txt(text, ts(13, 18, color = C.muted))
        }
    }
}

@Composable
private fun HeldButton(
    text: String,
    icon: ImageVector?,
    bg: Color,
    fg: Color,
    border: Color,
    modifier: Modifier = Modifier,
    busy: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(12.dp)
    Row(
        modifier.height(44.dp).clip(shape).background(if (enabled || busy) bg else bg.copy(alpha = 0.5f)).border(1.dp, border, shape)
            .clickable(enabled = enabled && !busy, onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), color = fg, strokeWidth = 2.dp)
        } else {
            if (icon != null) {
                Icon(icon, null, tint = fg, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(7.dp))
            }
            Txt(text, ts(15, 20, FontWeight.SemiBold, fg))
        }
    }
}

/** The bar that holds [SendCardActions] above the tab bar while a tall card is on screen (M12). */
@Composable
fun PinnedSendBar(content: @Composable () -> Unit) {
    val line = C.tint(C.glowBlue, 45)
    Box(
        Modifier.fillMaxWidth().background(C.mix(C.glowBlue, 6, C.bg))
            .drawBehind { drawLine(line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) { content() }
}

/** "Scroll to read the rest": the fade at the bottom of the list while a pinned card continues below. */
@Composable
fun ScrollHint(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier.fillMaxWidth().height(64.dp).drawBehind {
            drawRect(androidx.compose.ui.graphics.Brush.verticalGradient(0f to C.bg.copy(alpha = 0f), 0.75f to C.bg))
        }.padding(bottom = 10.dp),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Row(
            Modifier.clip(RoundedCornerShape(50)).background(C.surface2).border(1.dp, C.line, RoundedCornerShape(50))
                .clickable(onClick = onClick).padding(horizontal = 10.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Ic.chevronDown, null, tint = C.muted, modifier = Modifier.size(12.dp))
            Txt("Scroll to read the rest", ts(12, 16, color = C.muted))
        }
    }
}

/** "The hold is off" (M13 Needs you, M14 Crew). No toggle: only the PC can turn the hold back on. */
@Composable
fun HoldOffBanner(hold: HoldInfo, pcName: String, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().card(bg = C.mix(C.stuck, 13, C.surface), border = C.tint(C.stuck, 55)).padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(Ic.warning, null, tint = C.stuck, modifier = Modifier.padding(top = 1.dp).size(18.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Txt("The hold is off", ts(14, 19, FontWeight.SemiBold))
            Txt(
                "Claude's goals, replies and answers go straight to the crew, so they won't show up here for you to check. " +
                    "Only Muster on $pcName can turn the hold back on.",
                ts(13, 18, color = C.muted),
            )
            Txt(Held.holdLine(hold), ts(12, 16, color = C.faint, mono = true))
        }
    }
}

package com.obiwayne.muster.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.obiwayne.muster.MusterApp
import com.obiwayne.muster.SendOutcome
import com.obiwayne.muster.notify.Notifier
import com.obiwayne.muster.data.Ago
import com.obiwayne.muster.data.Kind
import com.obiwayne.muster.data.NeedItem
import kotlinx.coroutines.launch

/** Shows a short message at the bottom of the screen. */
val LocalSnack = compositionLocalOf<(String) -> Unit> { {} }

/** Items in the selected project (or all). */
fun filtered(items: List<NeedItem>, project: String?) = items.filter { project == null || it.projectId == project }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NeedsScreen(onOpenTask: (NeedItem) -> Unit, onOpenNote: (NeedItem) -> Unit) {
    val state = MusterApp.state
    val needs by state.needs.collectAsState()
    val offline by state.offline.collectAsState()
    val refreshing by state.refreshing.collectAsState()
    val selected by state.selectedProject.collectAsState()
    val ws by state.wsConnected.collectAsState()
    val demo by state.demo.collectAsState()
    val snack = LocalSnack.current
    val scope = rememberCoroutineScope()
    val busy = remember { mutableStateListOf<String>() }
    var blockedSheet by remember { mutableStateOf<NeedItem?>(null) }
    val expiredKept by state.expiredHeld.collectAsState()
    val heldErrors by state.heldErrors.collectAsState()
    val focus by state.focusHeld.collectAsState()
    val heldBusy = remember { mutableStateMapOf<String, String>() } // id -> "send" | "discard"
    val ctx = LocalContext.current
    val density = LocalDensity.current
    val listState = rememberLazyListState()
    var containerH by remember { mutableIntStateOf(0) }
    val bodyH = remember { mutableStateMapOf<String, Int>() }

    LaunchedEffect(Unit) { state.refreshNeeds() }

    val all = needs?.items.orEmpty().sortedByDescending { it.createdAt }
    val items = filtered(all, selected)
    val heldLive = items.filter { it.isHeld }
    val held = (heldLive + filtered(expiredKept, selected).filter { e -> heldLive.none { it.id == e.id } }).sortedByDescending { it.createdAt }
    val reviews = items.filter { it.isReview }
    val questions = items.filter { it.isQuestion || it.kind == Kind.STUCK && "answer" in it.actions }
    val other = items - reviews.toSet() - questions.toSet() - heldLive.toSet()
    val project = needs?.projects?.firstOrNull { it.id == selected }
    val pcName = state.pcName
    val hold = needs?.hold
    val holdOff = hold != null && !hold.on

    // A card taller than the list area gets its callout + Send/Discard pinned above the tab bar (M12). The body height
    // doesn't depend on where the actions are, so the choice can't flip back and forth.
    val actionsPx = with(density) { 190.dp.toPx() }
    fun isTall(id: String) = containerH > 0 && (bodyH[id] ?: 0) + actionsPx > containerH
    val pinnedId by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            info.visibleItemsInfo
                .filter { (it.key as? String)?.startsWith("held-") == true && isTall((it.key as String).removePrefix("held-")) }
                .maxByOrNull { minOf(it.offset + it.size, info.viewportEndOffset) - maxOf(it.offset, info.viewportStartOffset) }
                ?.let { (it.key as String).removePrefix("held-") }
        }
    }
    val pinned = held.firstOrNull { it.id == pinnedId }
    val moreBelow by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val it = info.visibleItemsInfo.firstOrNull { it.key == "held-$pinnedId" }
            it != null && it.offset + it.size > info.viewportEndOffset + 4
        }
    }

    fun send(item: NeedItem) {
        heldBusy[item.id] = "send"
        scope.launch {
            val out = state.sendHeld(item)
            heldBusy.remove(item.id)
            if (out is SendOutcome.Sent) {
                Notifier.cancel(ctx, item.id)
                snack(out.summary.ifBlank { "Sent ${item.remote?.pendingId ?: ""}".trim() })
            }
        }
    }

    fun discard(item: NeedItem) {
        heldBusy[item.id] = "discard"
        scope.launch {
            val ok = state.discardHeld(item) { snack(it) }
            heldBusy.remove(item.id)
            if (ok) {
                Notifier.cancel(ctx, item.id)
                snack("Discarded ${item.remote?.pendingId ?: ""} · nothing was sent".replace("  ", " "))
            }
        }
    }

    fun dismiss(item: NeedItem) {
        state.dismissHeld(item.id)
        Notifier.cancel(ctx, item.id)
    }

    // A notification tap on a held item: scroll to its card once it's loaded.
    LaunchedEffect(focus, held.map { it.id }) {
        val id = focus ?: return@LaunchedEffect
        val i = held.indexOfFirst { it.id == id }
        if (i < 0) return@LaunchedEffect
        // header, title, [offline], [empty], [hold banner], section label, then the held cards.
        val before = 2 + (if (offline) 1 else 0) + (if (needs != null && items.isEmpty() && !offline) 1 else 0) + (if (holdOff) 1 else 0) + 1
        listState.animateScrollToItem(before + i)
        state.focusHeld.value = null
    }

    fun approve(item: NeedItem) {
        val tid = item.taskId ?: return
        busy += item.id
        scope.launch {
            val ok = state.call({ snack(it) }) { approve(item.projectId, tid) } != null
            busy -= item.id
            if (ok) {
                state.removeNeed(item.id)
                snack("Approved $tid · the Captain merges it")
            }
        }
    }

    Column(Modifier.fillMaxSize().onSizeChanged { containerH = it.height }) {
        Box(Modifier.weight(1f)) {
            PullToRefreshBox(isRefreshing = refreshing, onRefresh = { scope.launch { state.refreshNeeds() } }, modifier = Modifier.fillMaxSize()) {
                LazyColumn(
                    Modifier.fillMaxSize(),
                    state = listState,
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    item("header") {
                        Row(Modifier.fillMaxWidth().height(40.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.weight(1f)) {
                                ProjectChip(needs?.projects.orEmpty(), selected, { state.projectChosen = true; state.selectedProject.value = it })
                            }
                            Txt("Muster", ts(13, 18, FontWeight.SemiBold, C.faint, spacing = 0.02.em))
                            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
                                PcPill(pcName, online = !offline && (ws || demo || needs != null))
                            }
                        }
                    }
                    item("title") {
                        Column(Modifier.padding(start = 4.dp, end = 4.dp, top = 8.dp, bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Txt("Needs you", ts(30, 36, FontWeight.SemiBold, spacing = (-0.02).em))
                            val running = project?.running ?: needs?.projects?.any { it.running } ?: false
                            val sub = when {
                                needs == null && offline -> "Offline"
                                needs == null -> "Loading…"
                                items.isEmpty() -> if (running) "All clear · crew working" else "All clear"
                                else -> "${items.size} waiting" + if (running) " · crew working" else " · crew stopped"
                            }
                            Txt(sub, ts(14, 20, color = C.muted))
                        }
                    }
                    if (offline) {
                        item("offline") { OfflineCard(pcName, needs != null) { scope.launch { state.refreshNeeds() } } }
                    }
                    if (needs != null && items.isEmpty() && !offline) {
                        item("empty") { EmptyState() }
                    }
                    if (holdOff && hold != null) {
                        item("hold-off") { HoldOffBanner(hold, pcName) }
                    }
                    if (held.isNotEmpty()) {
                        item("h-held") {
                            Box(Modifier.fillMaxWidth().padding(top = 2.dp), contentAlignment = Alignment.BottomStart) {
                                Txt("From Claude · waiting for your tap".uppercase(), Type.label.copy(color = C.glowBlue))
                            }
                        }
                        items(held, key = { "held-" + it.id }) { item ->
                            val phase = heldPhase(item, expiredKept.any { it.id == item.id }, heldBusy[item.id], heldErrors[item.id])
                            SendCard(
                                item, phase, rememberHeldQuestions(item),
                                showActions = !isTall(item.id),
                                onSend = { send(item) }, onDiscard = { discard(item) }, onDismiss = { dismiss(item) },
                                bodyModifier = Modifier.onSizeChanged { bodyH[item.id] = it.height },
                            )
                        }
                    }
                    if (reviews.isNotEmpty()) {
                        item("h-review") {
                            Row(Modifier.fillMaxWidth().height(32.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                SectionLabel("Ready for review", Modifier.weight(1f))
                                val approvable = reviews.filter { it.canApprove }
                                if (approvable.size >= 2) {
                                    Row(
                                        Modifier.height(30.dp).clip(RoundedCornerShape(15.dp)).background(C.tint(C.crew, 14))
                                            .border(1.dp, C.tint(C.crew, 35), RoundedCornerShape(15.dp))
                                            .clickable { approvable.forEach { approve(it) } }
                                            .padding(horizontal = 12.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        Icon(Ic.checkAll, null, tint = C.crew, modifier = Modifier.size(14.dp))
                                        Txt("Approve all ${approvable.size}", ts(13, 18, FontWeight.SemiBold, C.crew))
                                    }
                                }
                            }
                        }
                        items(reviews, key = { it.id }) { item ->
                            ReviewCard(item, busy = item.id in busy, onApprove = { approve(item) }, onOpen = { onOpenTask(item) })
                        }
                    }
                    if (questions.isNotEmpty()) {
                        item("h-q") { SubHeader("Questions") }
                        items(questions, key = { it.id }) { item -> QuestionCard(item) { onOpenNote(item) } }
                    }
                    if (other.isNotEmpty()) {
                        item("h-o") { SubHeader("Other") }
                        items(other, key = { it.id }) { item ->
                            when (item.kind) {
                                Kind.BLOCKED -> BlockedCard(item, pcName) { blockedSheet = item }
                                else -> InfoCard(item) {
                                    when {
                                        item.noteId != null && ("answer" in item.actions) -> onOpenNote(item)
                                        item.taskId != null -> onOpenTask(item)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (pinned != null && moreBelow) {
                ScrollHint(
                    onClick = { scope.launch { listState.animateScrollBy(containerH * 0.6f) } },
                    modifier = Modifier.align(Alignment.BottomCenter),
                )
            }
        }
        pinned?.let { item ->
            val phase = heldPhase(item, expiredKept.any { it.id == item.id }, heldBusy[item.id], heldErrors[item.id])
            PinnedSendBar(expired = phase == HeldPhase.Expired) {
                SendCardActions(item, phase, onSend = { send(item) }, onDiscard = { discard(item) }, onDismiss = { dismiss(item) })
            }
        }
    }

    blockedSheet?.let { item ->
        ModalBottomSheet(onDismissRequest = { blockedSheet = null }, containerColor = C.surface, dragHandle = null) {
            var working by remember { mutableStateOf<String?>(null) }
            Column(Modifier.padding(start = 24.dp, end = 24.dp, top = 24.dp, bottom = 36.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Txt("Merge blocked", ts(18, 24, FontWeight.SemiBold, C.warm))
                    Txt(
                        "${item.summary.ifBlank { "There are uncommitted files on $pcName" }}. Commit them so the Captain can merge, or stash them to set them aside.",
                        ts(14, 21, color = C.muted),
                    )
                }
                fun run(kind: String) {
                    working = kind
                    scope.launch {
                        val ok = state.call({ snack(it) }) { if (kind == "commit") commit(item.projectId) else stash(item.projectId) } != null
                        working = null
                        if (ok) {
                            state.removeNeed(item.id)
                            blockedSheet = null
                            snack(if (kind == "commit") "Committed · the merge goes ahead" else "Stashed · the merge goes ahead")
                        }
                    }
                }
                if ("commit" in item.actions || item.actions.isEmpty()) {
                    PrimaryButton("Commit & merge", Modifier.fillMaxWidth(), bg = C.warm, fg = C.onWarm, height = 52.dp, busy = working == "commit") { run("commit") }
                }
                if ("stash" in item.actions) {
                    OutlineButton("Stash the files and merge", Modifier.fillMaxWidth(), height = 52.dp, radius = 14.dp, textStyle = ts(15, 20, FontWeight.Medium), busy = working == "stash") { run("stash") }
                }
            }
        }
    }
}

@Composable
private fun SubHeader(text: String) {
    Box(Modifier.fillMaxWidth().height(24.dp).padding(start = 4.dp, end = 4.dp, bottom = 2.dp), contentAlignment = Alignment.BottomStart) {
        SectionLabel(text)
    }
}

@Composable
private fun CardHeader(item: NeedItem, middle: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        KindBadge(item.kind)
        Txt(middle, ts(12, 16, color = C.muted, mono = true), maxLines = 1)
        Spacer(Modifier.weight(1f))
        Txt(Ago.short(item.createdAt), ts(12, 16, color = C.faint, mono = true))
    }
}

@Composable
fun ReviewCard(item: NeedItem, busy: Boolean, onApprove: () -> Unit, onOpen: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().card().clickable(onClick = onOpen).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        CardHeader(item, item.taskId ?: "")
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Txt(item.title, ts(16, 22, FontWeight.SemiBold))
            if (item.summary.isNotBlank()) Txt(item.summary, ts(13, 18, color = C.muted), maxLines = 1)
        }
        val ev = item.evidence
        if (ev != null && ev.thumbs.isNotEmpty() && item.taskId != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                ev.thumbs.take(3).forEachIndexed { i, t ->
                    EvidenceThumb(item.projectId, item.taskId, ev.id, t, i, small = true, modifier = Modifier.weight(1f).height(38.dp))
                }
                repeat((3 - ev.thumbs.size).coerceAtLeast(0)) { Spacer(Modifier.weight(1f)) }
            }
        }
        Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (item.canApprove) {
                PrimaryButton(
                    "Approve", Modifier.weight(1f), bg = C.crew, fg = C.onCrew, height = 36.dp, radius = 12.dp,
                    textStyle = ts(14, 20, FontWeight.SemiBold), icon = Ic.checkBold, iconSize = 16.dp, gap = 6.dp, busy = busy, onClick = onApprove,
                )
                OutlineButton("Open", Modifier.width(96.dp), onClick = onOpen)
            } else {
                OutlineButton("Open", Modifier.weight(1f), onClick = onOpen)
            }
        }
    }
}

@Composable
fun QuestionCard(item: NeedItem, onAnswer: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().card().clickable(onClick = onAnswer).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        CardHeader(item, item.from)
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Txt(item.summary.ifBlank { item.title }, ts(14, 20, FontWeight.Medium), Modifier.weight(1f), maxLines = 4)
            PrimaryButton(
                "Answer", height = 34.dp, radius = 12.dp, textStyle = ts(14, 20, FontWeight.SemiBold),
                modifier = Modifier.width(78.dp), onClick = onAnswer,
            )
        }
    }
}

@Composable
fun BlockedCard(item: NeedItem, pcName: String, onAct: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().card(bg = C.mix(C.warm, 8, C.surface), border = C.tint(C.warm, 40)).clickable(onClick = onAct)
            .padding(start = 14.dp, end = 10.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Txt("Merge blocked", ts(14, 19, FontWeight.SemiBold, C.warm))
            Txt(item.summary.ifBlank { "Uncommitted files on $pcName" }, ts(12, 17, color = C.muted), maxLines = 2)
        }
        OutlineButton(
            if ("commit" in item.actions || item.actions.isEmpty()) "Commit & merge" else "Stash & merge",
            Modifier.padding(0.dp), height = 30.dp, radius = 10.dp, border = C.tint(C.warm, 45),
            textStyle = ts(12, 16, FontWeight.SemiBold, C.warm), onClick = onAct,
        )
    }
}

@Composable
private fun InfoCard(item: NeedItem, onOpen: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().card().clickable(onClick = onOpen).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        CardHeader(item, item.from)
        Txt(item.title, ts(14, 20, FontWeight.Medium))
        if (item.summary.isNotBlank() && item.summary != item.title) Txt(item.summary, ts(13, 18, color = C.muted), maxLines = 3)
    }
}

@Composable
fun EmptyState() {
    Column(
        Modifier.fillMaxWidth().padding(top = 72.dp, start = 24.dp, end = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Box(Modifier.size(64.dp).clip(CircleShape).background(C.tint(C.crew, 14)), contentAlignment = Alignment.Center) {
            Icon(Ic.checkBold, null, tint = C.crew, modifier = Modifier.size(28.dp))
        }
        Txt(
            "Nothing needs you right now.\nThe crew is handling it.",
            ts(16, 24, FontWeight.Medium, C.muted).copy(textAlign = TextAlign.Center),
        )
    }
}

@Composable
fun OfflineCard(pcName: String, compact: Boolean, onRetry: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(top = if (compact) 0.dp else 40.dp).card(bg = C.mix(C.stuck, 6, C.surface), border = C.tint(C.stuck, 35)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            IconBox(Ic.monitor, C.stuck, 36.dp, 18.dp, 10.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Txt("Can't reach $pcName", ts(15, 21, FontWeight.SemiBold))
                Txt(
                    "Check that the PC is on and Muster is running. Away from home, Tailscale has to be on for both.",
                    ts(13, 19, color = C.muted),
                )
            }
        }
        OutlineButton("Retry", Modifier.fillMaxWidth(), height = 40.dp, icon = Ic.refresh, onClick = onRetry)
    }
}

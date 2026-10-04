package com.obiwayne.muster.ui

import androidx.compose.foundation.Image
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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.obiwayne.muster.MusterApp
import com.obiwayne.muster.data.Ago
import com.obiwayne.muster.data.AnswerChoice
import com.obiwayne.muster.data.AskOption
import com.obiwayne.muster.data.AskText
import com.obiwayne.muster.data.EvidenceSet
import com.obiwayne.muster.data.Kind
import com.obiwayne.muster.data.Note
import com.obiwayne.muster.data.QuickAnswers
import com.obiwayne.muster.data.ReviewLine
import com.obiwayne.muster.data.ReviewText
import com.obiwayne.muster.data.TaskDetail
import kotlinx.coroutines.launch

private fun Modifier.topLine() = this.drawBehind { drawLine(C.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
private fun Modifier.bottomLine() = this.drawBehind { drawLine(C.line, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx()) }

@Composable
private fun Loading(error: String?, onRetry: () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        if (error == null) {
            CircularProgressIndicator(color = C.crew, strokeWidth = 2.5.dp, modifier = Modifier.size(28.dp))
        } else {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(32.dp)) {
                Txt(error, ts(15, 22, color = C.muted).copy(textAlign = TextAlign.Center))
                OutlineButton("Retry", Modifier.width(140.dp), height = 40.dp, icon = Ic.refresh, onClick = onRetry)
            }
        }
    }
}

// ---------------------------------------------------------------- M05 review

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReviewScreen(pid: String, tid: String, onBack: () -> Unit) {
    val state = MusterApp.state
    val needs by state.needs.collectAsState()
    val item = needs?.items?.firstOrNull { it.projectId == pid && it.taskId == tid && it.isReview }
    val snack = LocalSnack.current
    val scope = rememberCoroutineScope()
    var detail by remember { mutableStateOf<TaskDetail?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var approving by remember { mutableStateOf(false) }
    var sendBack by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var viewer by remember { mutableStateOf<Pair<String, String>?>(null) } // eid to file
    var evidenceSheet by remember { mutableStateOf(false) }

    suspend fun load() {
        error = null
        detail = state.call({ error = it }) { task(pid, tid) }
    }
    LaunchedEffect(pid, tid) { load() }
    LaunchedEffect(Unit) { if (state.needs.value == null) state.refreshNeeds() }

    Column(Modifier.fillMaxSize().background(C.bg).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            RoundIcon(Ic.arrowLeft, size = 44.dp, iconSize = 22.dp, onClick = onBack)
            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) { Txt(tid, ts(15, 20, FontWeight.Medium, mono = true)) }
            Box {
                RoundIcon(Ic.more, size = 44.dp, iconSize = 20.dp) { menu = true }
                DropdownMenu(menu, { menu = false }, containerColor = C.surface2) {
                    DropdownMenuItem(text = { Txt("Refresh", ts(14, 20)) }, onClick = { menu = false; scope.launch { load() } })
                    if (detail?.evidence?.isNotEmpty() == true) {
                        DropdownMenuItem(text = { Txt("All evidence", ts(14, 20)) }, onClick = { menu = false; evidenceSheet = true })
                    }
                }
            }
        }
        val d = detail
        if (d == null) {
            Box(Modifier.weight(1f)) { Loading(error) { scope.launch { load() } } }
        } else {
            Column(
                Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        KindBadge(item?.kind ?: Kind.REVIEW)
                        val at = d.review?.at?.ifBlank { null } ?: item?.createdAt.orEmpty()
                        val status = when (d.task.status) {
                            "ready_for_merge" -> "Ready for review"
                            "awaiting_approval" -> "Waiting for your approval"
                            "merged" -> "Merged"
                            "review" -> "With the Captain"
                            else -> d.task.status.replace('_', ' ').replaceFirstChar { it.uppercase() }
                        }
                        Txt(listOf(status, Ago.long(at).takeIf { at.isNotBlank() }).filterNotNull().joinToString(" · "), ts(13, 18, color = C.faint))
                    }
                    Txt(d.task.title, ts(24, 30, FontWeight.SemiBold, spacing = (-0.02).em))
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        d.task.branch?.let { br ->
                            Row(
                                Modifier.fillMaxWidth().height(28.dp).clip(RoundedCornerShape(8.dp)).background(C.surface2).padding(horizontal = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                Icon(Ic.branch, null, tint = C.muted, modifier = Modifier.size(14.dp))
                                Txt(br, ts(12, 16, color = C.muted, mono = true), Modifier.weight(1f), maxLines = 1)
                            }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (d.task.stations.isNotEmpty()) {
                                Txt(d.task.stations.joinToString(" → "), ts(12, 16, color = C.muted, mono = true))
                            }
                            val people = listOfNotNull(d.task.builderName) +
                                (if ("design" in d.task.stations && d.task.builderName != "design") listOf("design") else emptyList())
                            if (people.isNotEmpty()) {
                                if (d.task.stations.isNotEmpty()) Dot(C.faint, 3.dp)
                                Txt("by", ts(13, 18, color = C.faint))
                                people.forEach { who ->
                                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                                        Dot(agentColor(who))
                                        Txt(who, ts(13, 18))
                                    }
                                }
                            }
                        }
                    }
                }
                d.review?.let { r -> CaptainReview(r.text, passed = d.task.status == "ready_for_merge" || d.task.status == "merged") }
                val ev = d.evidence.lastOrNull()
                if (ev != null) EvidenceBlock(pid, tid, ev, onAll = { evidenceSheet = true }, onOpen = { viewer = ev.id to it })
                d.diffStat?.let { ds ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).border(1.dp, C.line, RoundedCornerShape(12.dp)).padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Txt("+${ds.added}", ts(13, 18, color = C.success, mono = true))
                        Txt("−${ds.removed}", ts(13, 18, color = C.stuck, mono = true))
                        Txt("· ${ds.files} files", ts(13, 18, color = C.muted, mono = true))
                        Spacer(Modifier.weight(1f))
                        Txt("View diff on PC", ts(12, 16, color = C.faint))
                    }
                }
            }
            val canApprove = item?.canApprove ?: false
            Column(
                Modifier.fillMaxWidth().background(C.surface).topLine().navigationBarsPadding().padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlineButton("Send back", Modifier.weight(1f), height = 52.dp, radius = 14.dp, textStyle = ts(15, 20, FontWeight.Medium)) { sendBack = true }
                    PrimaryButton(
                        if (item?.kind == Kind.APPROVAL) "Approve" else "Approve & merge", Modifier.weight(2f), bg = C.crew, fg = C.onCrew, height = 52.dp,
                        icon = Ic.merge, iconSize = 18.dp, gap = 8.dp, busy = approving, enabled = canApprove,
                    ) {
                        approving = true
                        scope.launch {
                            val ok = state.call({ snack(it) }) { approve(pid, tid) } != null
                            approving = false
                            if (ok) {
                                item?.let { state.removeNeed(it.id) }
                                snack("Approved $tid · the Captain merges it")
                                onBack()
                            }
                        }
                    }
                }
                Txt(
                    when {
                        item?.kind == Kind.APPROVAL -> "The task moves on to its next station."
                        canApprove -> "The Captain merges the reviewed commit and pushes to GitHub."
                        else -> "Nothing to approve right now."
                    },
                    ts(12, 16, color = C.faint).copy(textAlign = TextAlign.Center), Modifier.fillMaxWidth(),
                )
            }
        }
    }

    if (sendBack) {
        ModalBottomSheet(onDismissRequest = { sendBack = false }, containerColor = C.surface, dragHandle = null) {
            var text by remember { mutableStateOf("") }
            var busy by remember { mutableStateOf(false) }
            Column(Modifier.imePadding().padding(start = 24.dp, end = 24.dp, top = 24.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Txt("Send $tid back", ts(18, 24, FontWeight.SemiBold))
                    Txt("Tell the crew what to change. It goes back to the builder with your note.", ts(14, 21, color = C.muted))
                }
                Field(
                    text, { text = it }, "What should change?", Modifier.fillMaxWidth(), height = 120.dp, singleLine = false,
                    keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Default),
                )
                PrimaryButton("Send back", Modifier.fillMaxWidth(), height = 52.dp, busy = busy, enabled = text.isNotBlank()) {
                    busy = true
                    scope.launch {
                        val ok = state.call({ snack(it) }) { sendBack(pid, tid, text.trim()) } != null
                        busy = false
                        if (ok) {
                            sendBack = false
                            item?.let { state.removeNeed(it.id) }
                            snack("Sent $tid back to the crew")
                            onBack()
                        }
                    }
                }
            }
        }
    }

    if (evidenceSheet) {
        ModalBottomSheet(onDismissRequest = { evidenceSheet = false }, containerColor = C.surface) {
            Column(
                Modifier.verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 32.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                detail?.evidence?.reversed()?.forEach { set ->
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Txt(set.id, ts(12, 16, color = C.crew, mono = true))
                            Txt(set.summary, ts(14, 20, FontWeight.Medium), Modifier.weight(1f))
                        }
                        set.files.forEach { f ->
                            Row(
                                Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(C.surface2)
                                    .clickable(enabled = isImage(f.name)) { evidenceSheet = false; viewer = set.id to f.name }
                                    .padding(horizontal = 12.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Txt(f.name, ts(13, 18, mono = true), Modifier.weight(1f), maxLines = 1)
                                Txt(f.kind, ts(12, 16, color = C.faint))
                            }
                        }
                    }
                }
            }
        }
    }

    viewer?.let { (eid, file) ->
        Dialog(onDismissRequest = { viewer = null }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.92f)).clickable { viewer = null }, contentAlignment = Alignment.Center) {
                val bmp = rememberApiImage("$pid/$tid/$eid/$file") { evidenceFile(pid, tid, eid, file) }
                if (bmp != null) {
                    Image(bmp, file, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxWidth().padding(12.dp))
                } else {
                    Box(Modifier.fillMaxWidth().padding(24.dp).height(260.dp)) {
                        EvidenceThumb(pid, tid, eid, file, if (file.contains("perf")) 1 else 0, small = false, modifier = Modifier.fillMaxSize())
                    }
                }
                Txt(file, ts(13, 18, color = C.muted, mono = true), Modifier.align(Alignment.BottomCenter).padding(32.dp))
            }
        }
    }
}

@Composable
private fun CaptainReview(text: String, passed: Boolean) {
    Column(Modifier.fillMaxWidth().card().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Avatar("C", C.captain, 28.dp, border = true)
            Txt("Captain's review", ts(16, 22, FontWeight.SemiBold))
            Spacer(Modifier.weight(1f))
            if (passed) Txt("Passed", ts(12, 16, FontWeight.SemiBold, C.success))
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ReviewText.lines(text).forEach { l ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (l.style != ReviewLine.Style.TEXT) {
                        Box(Modifier.size(16.dp, 20.dp), contentAlignment = Alignment.Center) {
                            if (l.style == ReviewLine.Style.PASS) {
                                Icon(Ic.checkBold, null, tint = C.success, modifier = Modifier.size(14.dp))
                            } else {
                                Dot(C.captain)
                            }
                        }
                    }
                    Txt(
                        l.text,
                        ts(if (l.mono) 13 else 14, 20, color = if (l.style == ReviewLine.Style.NOTE) C.muted else C.text, mono = l.mono),
                        Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

@Composable
private fun EvidenceBlock(pid: String, tid: String, ev: EvidenceSet, onAll: () -> Unit, onOpen: (String) -> Unit) {
    val images = ev.files.filter { isImage(it.name) }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Evidence", Modifier.weight(1f))
            Row(Modifier.clickable(onClick = onAll), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Txt("${ev.id} · ${ev.files.size} files", ts(12, 16, color = C.crew, mono = true))
                Icon(Ic.chevronRight, null, tint = C.crew, modifier = Modifier.size(14.dp))
            }
        }
        if (images.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                images.take(2).forEachIndexed { i, f ->
                    Column(Modifier.weight(1f).clickable { onOpen(f.name) }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        EvidenceThumb(pid, tid, ev.id, f.name, i, small = false, modifier = Modifier.fillMaxWidth().height(113.dp))
                        Txt(f.name, ts(12, 16, color = C.muted, mono = true), maxLines = 1)
                    }
                }
                if (images.size == 1) Spacer(Modifier.weight(1f))
            }
        } else if (ev.summary.isNotBlank()) {
            Txt(ev.summary, ts(14, 20, color = C.muted))
        }
    }
}

// ---------------------------------------------------------------- M06 answer

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AnswerScreen(pid: String, nid: String, onBack: () -> Unit) {
    val state = MusterApp.state
    val needs by state.needs.collectAsState()
    val item = needs?.items?.firstOrNull { it.projectId == pid && it.noteId == nid }
    val projectName = needs?.projects?.firstOrNull { it.id == pid }?.name ?: item?.projectName.orEmpty()
    val snack = LocalSnack.current
    val scope = rememberCoroutineScope()
    var note by remember { mutableStateOf<Note?>(null) }
    var taskTitle by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var text by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        error = null
        val n = state.call({ error = it }) { note(pid, nid) } ?: return
        note = n
        n.taskId?.let { t -> taskTitle = state.call { task(pid, t) }?.task?.title }
    }
    LaunchedEffect(pid, nid) { load() }
    LaunchedEffect(Unit) { if (state.needs.value == null) state.refreshNeeds() }

    fun send(answer: String) {
        if (answer.isBlank() || sending != null) return
        sending = answer
        scope.launch {
            val ok = state.call({ snack(it) }) { reply(pid, nid, answer.trim()) } != null
            sending = null
            if (ok) {
                item?.let { state.removeNeed(it.id) }
                snack("Answer sent to the Captain")
                onBack()
            }
        }
    }

    fun submit(answers: List<AnswerChoice>) {
        if (sending != null) return
        sending = ASK_SUBMIT
        scope.launch {
            val updated = state.call({ snack(it) }) { answer(pid, nid, answers) }
            sending = null
            if (updated != null) {
                item?.let { state.removeNeed(it.id) }
                snack("Answer sent to the Captain")
                onBack()
            } else {
                load() // it may have been answered elsewhere (409): show it closed
            }
        }
    }

    Column(Modifier.fillMaxSize().background(C.bg).statusBarsPadding()) {
        val kind = note?.type ?: item?.kind ?: Kind.QUESTION
        Row(
            Modifier.fillMaxWidth().height(56.dp).bottomLine().padding(start = 8.dp, end = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            RoundIcon(Ic.chevronLeft, iconSize = 22.dp, onClick = onBack)
            Txt(nid, ts(15, 20, FontWeight.Medium, mono = true))
            KindBadge(kind)
            Spacer(Modifier.weight(1f))
            Txt(projectName, ts(13, 18, color = C.muted), maxLines = 1)
        }
        val n = note
        if (n == null) {
            Box(Modifier.weight(1f)) { Loading(error) { scope.launch { load() } } }
            return@Column
        }
        if (n.ask.isNotEmpty()) {
            AskContent(
                n, taskTitle, Modifier.weight(1f),
                submitting = sending == ASK_SUBMIT, replying = sending != null && sending != ASK_SUBMIT,
                reply = text, onReply = { text = it }, onSendReply = { send(text) }, onSubmit = ::submit,
            )
            return@Column
        }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            val fromColor = agentColor(n.from)
            Column(
                Modifier.fillMaxWidth().card(bg = C.surface, border = C.mix(C.captain, 30, C.line)).padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Avatar(n.from, fromColor)
                    Txt(n.from, ts(14, 20, FontWeight.SemiBold, fromColor))
                    Txt("· " + Ago.short(n.createdAt), ts(12, 16, color = C.faint, mono = true))
                }
                Txt(n.text, ts(18, 27, FontWeight.Medium, spacing = (-0.01).em))
                n.taskId?.let { t ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Txt("Context", ts(12, 16, color = C.faint))
                        Row(
                            Modifier.clip(RoundedCornerShape(14.dp)).background(C.surface2).padding(horizontal = 10.dp, vertical = 5.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Txt(t, ts(12, 16, color = C.muted, mono = true))
                            taskTitle?.let { Txt(it, ts(13, 16), maxLines = 1) }
                        }
                    }
                }
            }
            n.replies.forEach { r ->
                val who = if (r.from == "you") "You" else r.from
                val c = agentColor(r.from)
                Row(Modifier.padding(horizontal = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Avatar(who, c, bgPct = 16)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Txt(who, ts(14, 20, FontWeight.SemiBold, c))
                            Txt("· " + Ago.short(r.at), ts(12, 16, color = C.faint, mono = true))
                        }
                        Txt(r.text, ts(15, 22, color = C.muted))
                    }
                }
            }
        }
        val options = (n.options.ifEmpty { QuickAnswers.from(n.text) } + "Ask me on the PC").distinct()
        Column(
            Modifier.fillMaxWidth().background(C.surface).topLine().navigationBarsPadding().imePadding()
                .padding(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            SectionLabel("Tap to answer")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                options.forEachIndexed { i, o ->
                    val suggested = i == 0 && options.size > 1
                    val answer = if (o == "Ask me on the PC") "Let's talk about this on the PC." else o
                    Box(
                        Modifier.clip(RoundedCornerShape(18.dp))
                            .background(if (suggested) C.tint(C.captain, 8) else C.surface2)
                            .border(1.dp, if (suggested) C.mix(C.captain, 40, C.line) else C.line, RoundedCornerShape(18.dp))
                            .clickable(enabled = sending == null) { send(answer) }
                            .padding(horizontal = 14.dp, vertical = 9.dp),
                    ) {
                        Txt(o, ts(14, 18, color = if (sending == answer) C.muted else C.text))
                    }
                }
            }
            Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Field(
                        text, { text = it }, "Reply to the Captain…", Modifier.weight(1f), radius = 24.dp,
                        keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
                    )
                    Box(
                        Modifier.size(48.dp).clip(CircleShape).background(C.captain)
                            .clickable(enabled = text.isNotBlank() && sending == null) { send(text) },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (sending != null) {
                            CircularProgressIndicator(Modifier.size(18.dp), color = C.onCaptain, strokeWidth = 2.dp)
                        } else {
                            Icon(Ic.arrowUp, null, tint = C.onCaptain, modifier = Modifier.size(20.dp))
                        }
                    }
                }
                Txt("Your answer goes to ${recipients(n)}.", ts(12, 16, color = C.faint), Modifier.padding(start = 16.dp))
            }
        }
    }
}

private fun recipients(n: Note): String {
    val others = (listOf(n.from) + n.replies.map { it.from }).filter { it != "you" && it != "captain" && it != "muster" }.distinct()
    return (listOf("the Captain") + others).let { if (it.size == 1) it[0] else it.dropLast(1).joinToString(", ") + " and " + it.last() }
}

/** [AnswerScreen]'s `sending` value while the ask form is being submitted. */
private const val ASK_SUBMIT = "\u0000ask"

/** M06 for a Captain question note (ASK.md): option cards per question, one Submit, and the free-text reply below. */
@Composable
private fun AskContent(
    n: Note,
    taskTitle: String?,
    modifier: Modifier,
    submitting: Boolean,
    replying: Boolean,
    reply: String,
    onReply: (String) -> Unit,
    onSendReply: () -> Unit,
    onSubmit: (List<AnswerChoice>) -> Unit,
) {
    val picks = remember(n.id) { mutableStateListOf<Set<String>>().apply { repeat(n.ask.size) { add(emptySet()) } } }
    val others = remember(n.id) { mutableStateListOf<String>().apply { repeat(n.ask.size) { add("") } } }
    val closed = !n.open || n.answers.isNotEmpty()
    val ready = n.ask.indices.all { picks[it].isNotEmpty() || others[it].isNotBlank() }
    val busy = submitting || replying
    val answerReply = AskText.replyText(n.answers)

    Column(
        modifier.navigationBarsPadding().imePadding().verticalScroll(rememberScrollState())
            .padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        val fromColor = agentColor(n.from)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Avatar(n.from, fromColor)
            Txt(n.from, ts(14, 20, FontWeight.SemiBold, fromColor))
            Txt(if (closed) "asked you" else "asks you", ts(14, 20, color = C.muted))
            Txt("· " + Ago.short(n.createdAt), ts(12, 16, color = C.faint, mono = true))
        }
        n.taskId?.let { t ->
            Row(
                Modifier.clip(RoundedCornerShape(14.dp)).background(C.surface2).padding(horizontal = 10.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Txt(t, ts(12, 16, color = C.muted, mono = true))
                taskTitle?.let { Txt(it, ts(13, 16), maxLines = 1) }
            }
        }

        n.ask.forEachIndexed { i, q ->
            val answer = n.answers.getOrNull(i)
            val chosen = if (closed) answer?.choices.orEmpty().toSet() else picks[i]
            Column(
                Modifier.fillMaxWidth().card(bg = C.surface, border = if (closed) C.line else C.mix(C.captain, 30, C.line)).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (q.header.isNotBlank()) {
                        Box(Modifier.clip(RoundedCornerShape(6.dp)).background(C.tint(C.captain, 14)).padding(horizontal = 8.dp, vertical = 4.dp)) {
                            Txt(q.header, ts(12, 16, FontWeight.SemiBold, C.captain), maxLines = 1)
                        }
                    }
                    Spacer(Modifier.weight(1f))
                    val hint = listOfNotNull(
                        if (n.ask.size > 1) "${i + 1} of ${n.ask.size}" else null,
                        if (q.multiSelect && !closed) "pick any" else null,
                    ).joinToString(" · ")
                    if (hint.isNotEmpty()) Txt(hint, ts(12, 16, color = C.faint, mono = true))
                }
                Txt(q.question, ts(16, 24, FontWeight.Medium, spacing = (-0.01).em))
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    q.options.forEach { o ->
                        val selected = o.label in chosen
                        AskOptionCard(o, selected, q.multiSelect, enabled = !closed && !busy, dimmed = closed && !selected) {
                            picks[i] = when {
                                q.multiSelect -> if (selected) picks[i] - o.label else picks[i] + o.label
                                selected -> emptySet()
                                else -> setOf(o.label)
                            }
                        }
                    }
                }
                val other = answer?.other
                if (!closed) {
                    Field(
                        others[i], { others[i] = it }, "Type something", Modifier.fillMaxWidth(),
                        keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                    )
                } else if (!other.isNullOrBlank()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Txt(if (answer.choices.isEmpty()) "You wrote" else "Note", ts(13, 19, FontWeight.Medium, C.faint))
                        Txt(other, ts(14, 19), Modifier.weight(1f))
                    }
                }
            }
        }

        n.replies.filter { !(it.from == "you" && it.text.trim() == answerReply) }.forEach { r ->
            val who = if (r.from == "you") "You" else r.from
            val c = agentColor(r.from)
            Row(Modifier.padding(horizontal = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Avatar(who, c, bgPct = 16)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Txt(who, ts(14, 20, FontWeight.SemiBold, c))
                        Txt("· " + Ago.short(r.at), ts(12, 16, color = C.faint, mono = true))
                    }
                    Txt(r.text, ts(15, 22, color = C.muted))
                }
            }
        }

        if (closed) {
            Row(Modifier.padding(start = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Ic.check, null, tint = C.success, modifier = Modifier.size(16.dp))
                Txt(if (n.answers.isNotEmpty()) "Answered" else "Closed", ts(13, 18, FontWeight.Medium, C.success))
            }
            return@Column
        }

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton(
                if (n.ask.size > 1) "Submit answers" else "Submit", Modifier.fillMaxWidth(),
                bg = C.captain, fg = C.onCaptain, height = 52.dp, enabled = ready, busy = submitting,
            ) {
                onSubmit(n.ask.indices.map { i -> AnswerChoice(n.ask[i].options.map { it.label }.filter { it in picks[i] }, others[i].trim().ifEmpty { null }) })
            }
            if (!ready) {
                val msg = if (n.ask.size > 1) "Pick an option or type an answer for each question." else "Pick an option or type an answer."
                Txt(msg, ts(12, 16, color = C.faint).copy(textAlign = TextAlign.Center), Modifier.fillMaxWidth())
            }
        }

        Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SectionLabel("Or reply in your own words")
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Field(
                    reply, onReply, "Reply to the Captain…", Modifier.weight(1f), radius = 24.dp,
                    keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
                )
                Box(
                    Modifier.size(48.dp).clip(CircleShape).background(if (reply.isNotBlank()) C.captain else C.surface2)
                        .clickable(enabled = reply.isNotBlank() && !busy, onClick = onSendReply),
                    contentAlignment = Alignment.Center,
                ) {
                    if (replying) {
                        CircularProgressIndicator(Modifier.size(18.dp), color = C.onCaptain, strokeWidth = 2.dp)
                    } else {
                        Icon(Ic.arrowUp, null, tint = if (reply.isNotBlank()) C.onCaptain else C.faint, modifier = Modifier.size(20.dp))
                    }
                }
            }
            Txt("Goes to ${recipients(n)} and leaves the question open.", ts(12, 16, color = C.faint), Modifier.padding(start = 16.dp))
        }
    }
}

/** One option row: radio or checkbox, the label (with a "Recommended" tag) and its muted description. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AskOptionCard(o: AskOption, selected: Boolean, multi: Boolean, enabled: Boolean, dimmed: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    Row(
        Modifier.fillMaxWidth().dim(dimmed).clip(shape)
            .background(if (selected) C.tint(C.captain, 8) else C.surface2)
            .border(1.dp, if (selected) C.mix(C.captain, 55, C.line) else C.line, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.padding(top = 1.dp)) {
            if (multi) {
                Box(
                    Modifier.size(20.dp).clip(RoundedCornerShape(5.dp)).background(if (selected) C.captain else Color.Transparent)
                        .border(1.5.dp, if (selected) C.captain else C.faint, RoundedCornerShape(5.dp)),
                    contentAlignment = Alignment.Center,
                ) { if (selected) Icon(Ic.checkBold, null, tint = C.onCaptain, modifier = Modifier.size(14.dp)) }
            } else {
                Box(
                    Modifier.size(20.dp).clip(CircleShape).border(1.5.dp, if (selected) C.captain else C.faint, CircleShape),
                    contentAlignment = Alignment.Center,
                ) { if (selected) Box(Modifier.size(10.dp).clip(CircleShape).background(C.captain)) }
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Txt(o.shownLabel, ts(15, 21, FontWeight.Medium), Modifier.align(Alignment.CenterVertically))
                if (o.recommended) {
                    Box(Modifier.align(Alignment.CenterVertically).clip(RoundedCornerShape(5.dp)).background(C.tint(C.crew, 14)).padding(horizontal = 6.dp, vertical = 2.dp)) {
                        Txt("Recommended", ts(11, 14, FontWeight.SemiBold, C.crew))
                    }
                }
            }
            if (!o.description.isNullOrBlank()) Txt(o.description, ts(13, 18, color = C.muted))
        }
    }
}

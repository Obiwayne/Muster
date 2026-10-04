package com.obiwayne.muster.ui

import android.app.Activity
import android.app.TimePickerDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.media.RingtoneManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.core.content.IntentCompat
import com.obiwayne.muster.BuildConfig
import com.obiwayne.muster.MusterApp
import com.obiwayne.muster.data.Ago
import com.obiwayne.muster.data.CrewAgent
import com.obiwayne.muster.data.CrewResponse
import com.obiwayne.muster.data.CrewRoadmap
import com.obiwayne.muster.data.Prefs
import com.obiwayne.muster.data.QuietHours
import com.obiwayne.muster.notify.AlertPrefs
import com.obiwayne.muster.notify.AlertSound
import com.obiwayne.muster.notify.Notifier
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// ---------------------------------------------------------------- M07 crew

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CrewScreen() {
    val state = MusterApp.state
    val needs by state.needs.collectAsState()
    val selected by state.selectedProject.collectAsState()
    val snack = LocalSnack.current
    val scope = rememberCoroutineScope()
    val projects = needs?.projects.orEmpty()
    val pid = selected ?: projects.firstOrNull { it.running }?.id ?: projects.firstOrNull()?.id
    var crew by remember(pid) { mutableStateOf<CrewResponse?>(null) }
    var error by remember(pid) { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    var pausing by remember { mutableStateOf(false) }

    suspend fun load() {
        if (pid == null) return
        loading = true
        val r = state.call({ error = it }) { crew(pid) }
        if (r != null) { crew = r; error = null }
        loading = false
    }
    LaunchedEffect(Unit) { if (needs == null) state.refreshNeeds() }
    LaunchedEffect(pid) { load() }

    PullToRefreshBox(isRefreshing = loading, onRefresh = { scope.launch { load() } }, modifier = Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                ProjectChip(projects, pid, { state.projectChosen = true; state.selectedProject.value = it }, bordered = true, dotColor = C.crew, glow = false)
                Column(Modifier.padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Txt("Crew", ts(32, 38, FontWeight.SemiBold, spacing = (-0.02).em))
                    val c = crew
                    val sub = when {
                        pid == null -> "No projects yet"
                        c == null && error != null -> error!!
                        c == null -> "Loading…"
                        else -> {
                            val working = c.agents.count { it.status == "working" || it.status == "starting" }
                            val stuck = c.agents.count { it.status == "stuck" }
                            "${c.agents.size} agents · $working working" + (if (stuck > 0) " · $stuck stuck" else "") + if (c.paused) " · paused" else ""
                        }
                    }
                    Txt(sub, ts(14, 20, color = C.muted))
                }
            }
            crew?.let { c ->
                c.roadmap?.let { WhereWeAre(it) }
                Column(Modifier.fillMaxWidth().card().padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    UsageRow("5-hour", c.usage?.fiveHour?.pct, Ago.resets(c.usage?.fiveHour?.resetsAt))
                    UsageRow("Weekly", c.usage?.weekly?.pct, Ago.resets(c.usage?.weekly?.resetsAt))
                }
                if (c.agents.isNotEmpty()) {
                    Column(Modifier.fillMaxWidth().card()) {
                        c.agents.forEachIndexed { i, a ->
                            AgentRow(a, last = i == c.agents.lastIndex)
                        }
                    }
                }
                // "Pause the crew" (M07) waits for a pause route on the gateway; see docs/PHONE.md.
            }
        }
    }
}

/** Overall roadmap %, the current goal and the Captain's last roadmap_status line (posted after every merge). */
@Composable
private fun WhereWeAre(r: CrewRoadmap) {
    Column(Modifier.fillMaxWidth().card().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Txt("WHERE WE ARE", ts(11, 14, FontWeight.SemiBold, C.faint, mono = true, spacing = 0.08.em))
            Spacer(Modifier.weight(1f))
            Txt(r.pct?.let { "${it.toInt()}%" } ?: "–", ts(13, 16, FontWeight.Medium, mono = true))
        }
        Progress(((r.pct ?: 0.0) / 100.0).toFloat().coerceIn(0f, 1f), 4.dp, C.surface2, C.crew)
        r.current?.let { g ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Txt(g.id, ts(12, 16, FontWeight.Medium, C.crew, mono = true))
                Txt(g.title, ts(14, 20, FontWeight.Medium), maxLines = 1)
            }
        }
        r.status?.let { st ->
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Txt(st.text, ts(14, 20, color = C.muted))
                Txt("Captain · ${Ago.long(st.at)}", ts(12, 16, color = C.faint, mono = true))
            }
        }
    }
}

@Composable
private fun UsageRow(label: String, pct: Double?, resets: String) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Txt(label.uppercase(), ts(11, 14, FontWeight.SemiBold, C.faint, mono = true, spacing = 0.08.em), Modifier.width(64.dp))
            Txt(pct?.let { "${it.toInt()}%" } ?: "–", ts(13, 16, FontWeight.Medium, mono = true))
            Spacer(Modifier.weight(1f))
            Txt(if (pct == null) "no report yet" else resets, ts(12, 16, color = C.muted, mono = true))
        }
        val frac = ((pct ?: 0.0) / 100.0).toFloat()
        val color = when {
            (pct ?: 0.0) >= 90 -> C.stuck
            (pct ?: 0.0) >= 75 -> C.captain
            else -> C.crew
        }
        Progress(frac, 6.dp, C.surface2, color)
    }
}

/** Right-hand status text for an agent row. */
fun agentLabel(a: CrewAgent): String = when (a.status) {
    "stuck" -> if (a.taskId != null) "stuck on ${a.taskId}" else "stuck"
    "working" -> when {
        a.role == "captain" && a.taskId != null -> "reviewing"
        a.taskId != null -> "working on ${a.taskId}"
        else -> "working"
    }
    "waiting" -> if (a.taskId != null) "waiting · ${a.taskId}" else "waiting"
    else -> a.status
}

@Composable
private fun AgentRow(a: CrewAgent, last: Boolean) {
    val stuck = a.status == "stuck"
    val quiet = a.status in setOf("idle", "done", "stopped")
    Row(
        Modifier.fillMaxWidth().background(if (stuck) C.tint(C.stuck, 7) else androidx.compose.ui.graphics.Color.Transparent)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.width(10.dp), contentAlignment = Alignment.Center) {
            Dot(agentColor(a.id, a.role), 9.dp, Modifier.alpha(if (quiet) 0.45f else 1f))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Txt(a.id, ts(15, 20, FontWeight.SemiBold))
            val sub = when {
                a.taskId == null -> "no task · waiting for work"
                a.role == "captain" -> listOfNotNull(a.branch, a.taskId).joinToString(" · ")
                else -> a.branch ?: a.taskId
            }
            Txt(sub, ts(12, 16, color = C.faint, mono = true), maxLines = 1)
        }
        Txt(
            agentLabel(a),
            ts(13, 18, if (stuck) FontWeight.SemiBold else FontWeight.Normal, if (stuck) C.stuck else if (quiet) C.faint else C.muted)
                .copy(textAlign = TextAlign.End),
            Modifier.widthIn(max = 150.dp), maxLines = 1,
        )
    }
    if (!last) Box(Modifier.fillMaxWidth().height(1.dp).background(C.line))
}

// ---------------------------------------------------------------- M09 settings

@Composable
fun SettingsScreen(onUnlinked: () -> Unit) {
    val ctx = LocalContext.current
    val state = MusterApp.state
    val prefs by state.prefs.collectAsState()
    val needs by state.needs.collectAsState()
    val lastSync by state.lastSync.collectAsState()
    val offline by state.offline.collectAsState()
    val ws by state.wsConnected.collectAsState()
    val demo by state.demo.collectAsState()
    val snack = LocalSnack.current
    val scope = rememberCoroutineScope()
    var confirmUnlink by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        state.loadPrefs()
        if (needs == null) state.refreshNeeds()
    }
    val p = prefs ?: Prefs()
    fun save(n: Prefs) = scope.launch { state.savePrefs(n) { snack("Couldn't save: $it") } }
    val link = state.currentLink()
    val host = state.store.workingHost?.takeIf { !demo } ?: link?.hosts?.lastOrNull()

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Txt("Settings", ts(32, 38, FontWeight.SemiBold, spacing = (-0.02).em), Modifier.padding(horizontal = 4.dp))

        Group("Linked PC") {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                IconBox(Ic.monitor, C.crew, 36.dp, 18.dp, 9.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Txt(state.pcName, ts(15, 20, FontWeight.Medium, mono = true))
                    val via = when {
                        offline -> "Can't reach it right now"
                        host == null -> "Linked"
                        isTailscale(host) -> "Connected via Tailscale"
                        else -> "Connected on Wi-Fi"
                    }
                    Txt(via, ts(13, 18, color = if (offline) C.stuck else C.muted))
                }
                Txt(
                    if (lastSync == 0L) "not synced" else "synced\n" + Ago.long(java.time.Instant.ofEpochMilli(lastSync).toString()),
                    ts(12, 16, color = C.faint).copy(textAlign = TextAlign.End),
                )
            }
            Divider()
            Txt(
                "Unlink this phone", ts(14, 20, FontWeight.Medium, C.stuck),
                Modifier.fillMaxWidth().clickable { confirmUnlink = true }.padding(horizontal = 16.dp, vertical = 13.dp),
            )
        }

        Group("Notify me about") {
            val n = p.notify
            ToggleRow("Approvals and reviews", n.review) { save(p.copy(notify = n.copy(review = it))) }
            Divider()
            ToggleRow("Captain questions", n.question) { save(p.copy(notify = n.copy(question = it))) }
            Divider()
            ToggleRow("Blocked merges", n.blocked) { save(p.copy(notify = n.copy(blocked = it))) }
            Divider()
            ToggleRow("Usage alerts", n.usage) { save(p.copy(notify = n.copy(usage = it))) }
            Divider()
            ToggleRow("Agent stuck", n.stuck) { save(p.copy(notify = n.copy(stuck = it))) }
        }

        AlertSoundGroup()

        Group("Quiet hours") {
            Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Row {
                        Txt(p.quiet.from, ts(15, 20, mono = true), Modifier.clickable { pickTime(ctx, p.quiet.from) { save(p.copy(quiet = p.quiet.copy(from = it))) } })
                        Txt(" – ", ts(15, 20, mono = true))
                        Txt(p.quiet.to, ts(15, 20, mono = true), Modifier.clickable { pickTime(ctx, p.quiet.to) { save(p.copy(quiet = p.quiet.copy(to = it))) } })
                    }
                    Txt("Only blocked merges get through", ts(12, 16, color = C.faint))
                }
                Toggle(p.quiet.on, { save(p.copy(quiet = p.quiet.copy(on = it))) })
            }
        }

        val projects = needs?.projects.orEmpty()
        if (projects.isNotEmpty()) {
            Group("Projects") {
                projects.forEachIndexed { i, pr ->
                    val on = p.projects[pr.id] ?: true
                    Row(Modifier.fillMaxWidth().height(44.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Box(Modifier.width(8.dp), contentAlignment = Alignment.Center) { Dot(if (pr.running) C.crew else C.faint, 7.dp) }
                        Txt(pr.name, ts(15, 20, color = if (pr.running) C.text else C.muted), Modifier.weight(1f), maxLines = 1)
                        Toggle(on, { save(p.copy(projects = p.projects + (pr.id to it))) })
                    }
                    if (i < projects.lastIndex) Divider()
                }
            }
        }

        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Txt(if (demo) "Muster for Android · demo" else "Muster for Android", ts(13, 18, color = C.faint), Modifier.weight(1f))
            Txt(BuildConfig.VERSION_NAME, ts(12, 16, color = C.faint, mono = true))
        }
        if (!demo && !ws && !offline && state.link.value != null) {
            Txt("Live updates reconnecting…", ts(12, 16, color = C.faint), Modifier.padding(horizontal = 4.dp))
        }
    }

    if (confirmUnlink) {
        AlertDialog(
            onDismissRequest = { confirmUnlink = false },
            containerColor = C.surface,
            title = { Txt(if (demo) "Leave demo mode?" else "Unlink this phone?", ts(18, 24, FontWeight.SemiBold)) },
            text = {
                Txt(
                    if (demo) "You'll go back to the welcome screen." else "${state.pcName} stops sending to this phone. To link again, scan a new code on the PC.",
                    ts(14, 21, color = C.muted),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmUnlink = false
                    scope.launch {
                        state.unlink()
                        onUnlinked()
                    }
                }) { Txt(if (demo) "Leave" else "Unlink", ts(14, 20, FontWeight.SemiBold, C.stuck)) }
            },
            dismissButton = { TextButton(onClick = { confirmUnlink = false }) { Txt("Cancel", ts(14, 20, FontWeight.Medium)) } },
        )
    }
}

/** Phone-local alert sound (not gateway prefs). Changing it rebuilds the alert channels; see [AlertSound]. */
@Composable
private fun AlertSoundGroup() {
    val ctx = LocalContext.current
    val snack = LocalSnack.current
    val scope = rememberCoroutineScope()
    val s by AlertSound.prefs.collectAsState()
    LaunchedEffect(Unit) { withContext(Dispatchers.IO) { AlertSound.load(ctx) } }
    val title by produceState("…", s.uri) { value = withContext(Dispatchers.IO) { AlertSound.title(ctx, s) } }
    fun update(n: AlertPrefs) = scope.launch { withContext(Dispatchers.IO) { AlertSound.update(ctx.applicationContext, n) } }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val data = r.data
        if (r.resultCode == Activity.RESULT_OK && data != null && data.hasExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI)) {
            val picked = IntentCompat.getParcelableExtra(data, RingtoneManager.EXTRA_RINGTONE_PICKED_URI, Uri::class.java)
            if (picked != null) update(s.copy(uri = AlertSound.normalize(picked)))
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Group("Alert sound") {
            ToggleRow("Play a sound", s.play) { update(s.copy(play = it)) }
            Divider()
            Row(
                Modifier.fillMaxWidth().height(52.dp).dim(!s.play)
                    .clickable(enabled = s.play) {
                        val i = Intent(RingtoneManager.ACTION_RINGTONE_PICKER)
                            .putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_NOTIFICATION)
                            .putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, "Alert sound")
                            .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true)
                            .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false)
                            .putExtra(RingtoneManager.EXTRA_RINGTONE_DEFAULT_URI, Settings.System.DEFAULT_NOTIFICATION_URI)
                            .putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, s.uri ?: Settings.System.DEFAULT_NOTIFICATION_URI)
                        // Go straight to the phone's own picker instead of a chooser that also lists file managers.
                        ctx.packageManager.queryIntentActivities(i, 0)
                            .firstOrNull { it.activityInfo.applicationInfo.flags and ApplicationInfo.FLAG_SYSTEM != 0 }
                            ?.let { i.setClassName(it.activityInfo.packageName, it.activityInfo.name) }
                        try {
                            picker.launch(i)
                        } catch (_: ActivityNotFoundException) {
                            snack("This phone has no sound picker")
                        }
                    }
                    .padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Txt("Sound", ts(15, 20), Modifier.weight(1f))
                Txt(title, ts(14, 20, color = C.muted).copy(textAlign = TextAlign.End), Modifier.widthIn(max = 190.dp), maxLines = 1)
                Icon(Ic.chevronRight, null, tint = C.faint, modifier = Modifier.size(16.dp))
            }
            Divider()
            ToggleRow("Vibrate", s.vibrate) { update(s.copy(vibrate = it)) }
            Divider()
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Txt("Hear a sample alert", ts(15, 20, color = C.muted), Modifier.weight(1f))
                OutlineButton("Test", Modifier.width(72.dp)) {
                    if (!Notifier.testAlert(ctx)) snack("Notifications are off for Muster")
                }
            }
        }
        Txt("Applies to every Muster alert. Quiet hours still apply.", ts(12, 16, color = C.faint), Modifier.padding(horizontal = 4.dp))
    }
}

private fun pickTime(ctx: android.content.Context, current: String, onPick: (String) -> Unit) {
    val m = QuietHours.parse(current) ?: 0
    TimePickerDialog(ctx, { _, h, min -> onPick(QuietHours.format(h * 60 + min)) }, m / 60, m % 60, true).show()
}

@Composable
private fun Group(label: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel(label, Modifier.padding(horizontal = 4.dp))
        Column(Modifier.fillMaxWidth().card()) { content() }
    }
}

@Composable
private fun Divider() = Box(Modifier.fillMaxWidth().height(1.dp).background(C.line))

@Composable
private fun ToggleRow(label: String, on: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(44.dp).clickable { onChange(!on) }.padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Txt(label, ts(15, 20), Modifier.weight(1f))
        Toggle(on, onChange)
    }
}


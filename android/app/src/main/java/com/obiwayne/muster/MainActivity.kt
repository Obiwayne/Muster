package com.obiwayne.muster

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.obiwayne.muster.data.Kind
import com.obiwayne.muster.notify.Notifier
import com.obiwayne.muster.ui.AnswerScreen
import com.obiwayne.muster.ui.BottomNav
import com.obiwayne.muster.ui.C
import com.obiwayne.muster.ui.CrewScreen
import com.obiwayne.muster.ui.LinkedScreen
import com.obiwayne.muster.ui.LocalSnack
import com.obiwayne.muster.ui.MusterTheme
import com.obiwayne.muster.ui.NeedsScreen
import com.obiwayne.muster.ui.ReviewScreen
import com.obiwayne.muster.ui.ScanScreen
import com.obiwayne.muster.ui.SettingsScreen
import com.obiwayne.muster.ui.Tab
import com.obiwayne.muster.ui.Txt
import com.obiwayne.muster.ui.WelcomeScreen
import com.obiwayne.muster.ui.filtered
import com.obiwayne.muster.ui.ts
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private var startScreen: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        handleIntent(intent)
        val state = MusterApp.state
        if (state.link.value != null) state.startListening()
        setContent {
            MusterTheme { Root(startScreen) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val state = MusterApp.state
        // Debug builds: `adb shell am start -n com.obiwayne.muster/.MainActivity --ez demo true --es screen review`
        // (screens: needs, crew, settings, review, answer, ask, held; `--ez notify true [--es screen ask|held]` posts demo
        // notifications). Held writes from Claude (M10–M12): `--es screen held` adds goal, reply and answer cards, or pick
        // with `--es held goal,reply,answer,expired`; `--ez sendfail true` makes Send fail (409); `--ez holdoff true`
        // shows the "hold is off" banner (M13/M14) on Needs you and Crew.
        if (BuildConfig.DEBUG && intent.hasExtra("notify") && !intent.getBooleanExtra("notify", false)) {
            Notifier.cancelAll(this)
            return
        }
        if (BuildConfig.DEBUG && intent.getBooleanExtra("notify", false)) {
            // Debug: post the two M08 notifications from the demo data.
            lifecycleScope.launch {
                val items = com.obiwayne.muster.data.DemoBackend().needs().items
                val now = java.time.Instant.now().toString()
                items.filter { it.taskId == "T58" || it.noteId == "N142" }.reversed().forEach { Notifier.postNeed(this@MainActivity, it.copy(createdAt = now), "WAYNE-PC") }
                if (intent.getStringExtra("screen") == "ask") {
                    // The two-question ask, and a one-question copy that gets one-tap answer actions.
                    val ask = items.first { it.noteId == "N144" }
                    Notifier.postNeed(this@MainActivity, ask.copy(createdAt = now), "WAYNE-PC")
                    Notifier.postNeed(this@MainActivity, ask.copy(id = ask.id + ":1", ask = ask.ask.take(1), createdAt = now), "WAYNE-PC")
                }
                if (intent.getStringExtra("screen") == "held") {
                    com.obiwayne.muster.data.DemoBackend(setOf("goal")).needs().items.filter { it.isHeld }
                        .forEach { Notifier.postNeed(this@MainActivity, it, "WAYNE-PC") }
                }
            }
            return
        }
        if (BuildConfig.DEBUG && intent.hasExtra("pair")) {
            // Debug: `--es pair "muster://pair?..."` behaves like scanning that QR code.
            state.exitDemo()
            state.debugPairUri.value = intent.getStringExtra("pair")
            state.openTarget.value = OpenTarget("screen:scan", "", null, null)
            return
        }
        if (BuildConfig.DEBUG && intent.hasExtra("demo")) {
            startScreen = intent.getStringExtra("screen") ?: "needs"
            if (intent.getBooleanExtra("demo", false)) {
                val held = intent.getStringExtra("held")?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }?.toSet()
                    ?: if (startScreen == "held") setOf("goal", "reply", "answer") else emptySet()
                state.enterDemo(held, intent.getBooleanExtra("holdoff", false), intent.getBooleanExtra("sendfail", false))
            } else {
                state.exitDemo()
            }
            state.openTarget.value = OpenTarget("screen:$startScreen", "", null, null)
            return
        }
        val pid = intent.getStringExtra(Notifier.EXTRA_PROJECT) ?: return
        state.openTarget.value = OpenTarget(
            intent.getStringExtra(Notifier.EXTRA_KIND) ?: "",
            pid,
            intent.getStringExtra(Notifier.EXTRA_TASK),
            intent.getStringExtra(Notifier.EXTRA_NOTE),
            intent.getStringExtra(Notifier.EXTRA_ITEM),
        )
    }
}

private object R2 {
    const val WELCOME = "welcome"
    const val SCAN = "scan"
    const val LINKED = "linked"
    const val HOME = "home"
}

@Composable
private fun Root(@Suppress("UNUSED_PARAMETER") initial: String?) {
    val state = MusterApp.state
    val nav = rememberNavController()
    val link by state.link.collectAsState()
    val demo by state.demo.collectAsState()
    val target by state.openTarget.collectAsState()
    val snackHost = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val snack: (String) -> Unit = { msg -> scope.launch { snackHost.currentSnackbarData?.dismiss(); snackHost.showSnackbar(msg) } }
    val linked = link != null || demo

    // Unlinked (here, on the PC, or by a 401): back to M01.
    LaunchedEffect(linked) {
        if (!linked && nav.currentDestination?.route !in setOf(R2.WELCOME, R2.SCAN, null)) {
            nav.navigate(R2.WELCOME) { popUpTo(0) }
        }
    }

    LaunchedEffect(target, linked) {
        val t = target ?: return@LaunchedEffect
        if (t.kind.startsWith("screen:")) {
            state.openTarget.value = null
            openDebugScreen(nav, t.kind.removePrefix("screen:"))
            return@LaunchedEffect
        }
        if (!linked) return@LaunchedEffect
        state.openTarget.value = null
        when {
            // A held write from Claude: open Needs you on its Send card (the full text is only shown there).
            t.kind == Kind.REMOTE_WRITE -> {
                if (state.needs.value?.projects?.any { it.id == t.projectId } != false) state.selectedProject.value = t.projectId
                state.focusHeld.value = t.itemId
                state.homeTab.value = "needs"
                nav.navigate(R2.HOME) { popUpTo(0) }
            }
            (t.kind == Kind.REVIEW || t.kind == Kind.APPROVAL) && t.taskId != null -> nav.navigate("review/${t.projectId}/${t.taskId}")
            t.noteId != null && t.kind != Kind.BLOCKED -> nav.navigate("note/${t.projectId}/${t.noteId}")
            else -> {
                state.homeTab.value = "needs"
                nav.navigate(R2.HOME) { popUpTo(0) }
            }
        }
    }

    CompositionLocalProvider(LocalSnack provides snack) {
        Box(Modifier.fillMaxSize().background(C.bg)) {
            // Chosen once: changing a NavHost's start destination later would reset the back stack (and skip M03).
            val start = remember { if (linked) R2.HOME else R2.WELCOME }
            NavHost(nav, startDestination = start) {
                composable(R2.WELCOME) {
                    WelcomeScreen(
                        onScan = { nav.navigate(R2.SCAN) },
                        onDemo = {
                            state.enterDemo()
                            nav.navigate(R2.HOME) { popUpTo(0) }
                        },
                    )
                }
                composable(R2.SCAN) {
                    ScanScreen(
                        onClose = { nav.popBackStack() },
                        onLinked = { nav.navigate(R2.LINKED) { popUpTo(0) } },
                    )
                }
                composable(R2.LINKED) {
                    LinkedScreen(onContinue = { nav.navigate(R2.HOME) { popUpTo(0) } })
                }
                composable(R2.HOME) {
                    Home(
                        onOpenTask = { pid, tid -> nav.navigate("review/$pid/$tid") },
                        onOpenNote = { pid, nid -> nav.navigate("note/$pid/$nid") },
                        onUnlinked = { nav.navigate(R2.WELCOME) { popUpTo(0) } },
                    )
                }
                composable("review/{pid}/{tid}") { e ->
                    ReviewScreen(e.arguments?.getString("pid")!!, e.arguments?.getString("tid")!!) { nav.popBackStack() }
                }
                composable("note/{pid}/{nid}") { e ->
                    AnswerScreen(e.arguments?.getString("pid")!!, e.arguments?.getString("nid")!!) { nav.popBackStack() }
                }
            }
            SnackbarHost(snackHost, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 96.dp, start = 16.dp, end = 16.dp)) { data ->
                Snackbar(containerColor = C.surface2, contentColor = C.text, shape = RoundedCornerShape(12.dp)) {
                    Txt(data.visuals.message, ts(14, 20))
                }
            }
        }
    }
}

private fun openDebugScreen(nav: NavHostController, screen: String) {
    val state = MusterApp.state
    when (screen) {
        "welcome" -> nav.navigate(R2.WELCOME) { popUpTo(0) }
        "scan" -> nav.navigate(R2.SCAN) { popUpTo(0) }
        "linked" -> nav.navigate(R2.LINKED) { popUpTo(0) }
        "review" -> {
            nav.navigate(R2.HOME) { popUpTo(0) }
            nav.navigate("review/starcut/T58")
        }
        "answer" -> {
            nav.navigate(R2.HOME) { popUpTo(0) }
            nav.navigate("note/starcut/N142")
        }
        "ask" -> {
            nav.navigate(R2.HOME) { popUpTo(0) }
            nav.navigate("note/starcut/N144")
        }
        else -> {
            state.homeTab.value = screen.takeIf { it in setOf("needs", "crew", "settings") } ?: "needs"
            nav.navigate(R2.HOME) { popUpTo(0) }
        }
    }
}

@Composable
private fun Home(onOpenTask: (String, String) -> Unit, onOpenNote: (String, String) -> Unit, onUnlinked: () -> Unit) {
    val state = MusterApp.state
    val tabName by state.homeTab.collectAsState()
    val needs by state.needs.collectAsState()
    val selected by state.selectedProject.collectAsState()
    val tab = when (tabName) {
        "crew" -> Tab.CREW
        "settings" -> Tab.SETTINGS
        else -> Tab.NEEDS
    }
    val count = filtered(needs?.items.orEmpty(), selected).size
    Column(Modifier.fillMaxSize().background(C.bg)) {
        Box(Modifier.weight(1f).statusBarsPadding()) {
            when (tab) {
                Tab.NEEDS -> NeedsScreen(
                    // An approval with no task (e.g. the roadmap) opens as a note instead.
                    onOpenTask = { item ->
                        when {
                            item.taskId != null -> onOpenTask(item.projectId, item.taskId)
                            item.noteId != null -> onOpenNote(item.projectId, item.noteId)
                        }
                    },
                    onOpenNote = { item -> if (item.noteId != null) onOpenNote(item.projectId, item.noteId) },
                )
                Tab.CREW -> CrewScreen()
                Tab.SETTINGS -> SettingsScreen(onUnlinked)
            }
        }
        Box(Modifier.background(C.surface).navigationBarsPadding()) {
            BottomNav(tab, count) { state.homeTab.value = it.name.lowercase() }
        }
    }
}

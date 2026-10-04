package com.obiwayne.muster.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.core.content.ContextCompat
import com.obiwayne.muster.BuildConfig
import com.obiwayne.muster.MusterApp
import com.obiwayne.muster.R
import com.obiwayne.muster.data.ApiException
import com.obiwayne.muster.data.CertPin
import com.obiwayne.muster.data.OfflineException
import com.obiwayne.muster.data.PairInfo
import com.obiwayne.muster.data.PairUri
import com.obiwayne.muster.data.Pairing
import com.obiwayne.muster.notify.Notifier
import kotlinx.coroutines.launch
import kotlin.random.Random

// ---------------------------------------------------------------- M01 welcome

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun WelcomeScreen(onScan: () -> Unit, onDemo: () -> Unit) {
    Box(
        Modifier.fillMaxSize().background(C.bg).drawBehind {
            // radial glow: 420dp circle at (120, -180) on the 412×915 artboard (40dp status bar included)
            val center = Offset(size.width - 82.dp.toPx(), 30.dp.toPx())
            drawCircle(
                Brush.radialGradient(
                    0f to C.glowViolet.copy(alpha = 0.34f),
                    0.45f to C.glowBlue.copy(alpha = 0.12f),
                    0.70f to Color.Transparent,
                    center = center,
                    radius = 210.dp.toPx(),
                ),
                radius = 210.dp.toPx(),
                center = center,
            )
        },
    ) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            Column(
                Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 28.dp, end = 28.dp, top = 72.dp),
                verticalArrangement = Arrangement.spacedBy(28.dp),
            ) {
                Row(
                    Modifier.height(40.dp).combinedClickable(
                        interactionSource = null,
                        indication = null,
                        onClick = {},
                        onLongClick = { if (BuildConfig.DEBUG) onDemo() },
                    ),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Image(painterResource(R.drawable.ic_muster_logo), null, Modifier.size(36.dp, 18.dp))
                    Txt("Muster", ts(20, 24, FontWeight.SemiBold, spacing = (-0.01).em))
                }
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Txt("Your crew,\nin your pocket.", ts(34, 40, FontWeight.SemiBold, spacing = (-0.02).em))
                    Txt(
                        "Get a buzz when the Captain needs you. Approve a merge, answer a question or send work back without walking to your PC.",
                        ts(16, 24, color = C.muted),
                    )
                }
                Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    Feature(Ic.check, C.crew, "Approve reviewed work", "Read the Captain's review and evidence, then approve. The Captain merges and pushes.")
                    Feature(Ic.message, C.captain, "Answer the Captain", "Product calls and escalations, answered in a line.")
                    Feature(Ic.users, C.design, "Glance at the crew", "Who's working, who's stuck, and how much usage is left.")
                }
            }
            Column(Modifier.padding(start = 28.dp, end = 28.dp, bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                PrimaryButton("Scan the code on your PC", Modifier.fillMaxWidth(), icon = Ic.scan, onClick = onScan)
                Txt("On your PC, open Muster → Settings → Phone", ts(13, 19, color = C.faint).copy(textAlign = TextAlign.Center), Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable
private fun Feature(icon: androidx.compose.ui.graphics.vector.ImageVector, color: Color, title: String, body: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        IconBox(icon, color, 32.dp, 16.dp, 8.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Txt(title, ts(15, 22, FontWeight.Medium))
            Txt(body, ts(14, 20, color = C.muted))
        }
    }
}

// ---------------------------------------------------------------- M02 scan

private sealed interface ScanStep {
    data object Scanning : ScanStep
    data object Manual : ScanStep
    data class Confirm(val info: PairInfo, val fingerprint: String) : ScanStep
    data class Linking(val pcName: String) : ScanStep
}

@Composable
fun ScanScreen(onClose: () -> Unit, onLinked: () -> Unit) {
    val ctx = LocalContext.current
    val state = MusterApp.state
    val demo by state.demo.collectAsState()
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf<ScanStep>(ScanStep.Scanning) }
    var error by remember { mutableStateOf<String?>(null) }
    var torch by remember { mutableStateOf(false) }
    var hasCamera by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    var asked by remember { mutableStateOf(false) }
    val camPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { hasCamera = it; asked = true }
    LaunchedEffect(Unit) { if (!hasCamera && !demo && state.debugPairUri.value == null) camPerm.launch(Manifest.permission.CAMERA) }

    val deviceName = remember {
        Settings.Global.getString(ctx.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() } ?: Build.MODEL
    }

    fun pair(info: PairInfo) {
        step = ScanStep.Linking(info.pcName)
        error = null
        scope.launch {
            try {
                val (link, host) = Pairing.pair(info, deviceName)
                state.completePairing(link, host)
                onLinked()
            } catch (e: ApiException) {
                error = e.message
                step = ScanStep.Scanning
            } catch (e: OfflineException) {
                error = "Can't reach ${e.pcName}. Is the phone on the same Wi-Fi (or Tailscale)?"
                step = ScanStep.Scanning
            } catch (e: Exception) {
                error = e.message ?: "Linking failed"
                step = ScanStep.Scanning
            }
        }
    }

    val debugUri by state.debugPairUri.collectAsState()
    LaunchedEffect(debugUri) {
        val uri = debugUri ?: return@LaunchedEffect
        state.debugPairUri.value = null
        PairUri.parse(uri)?.let { pair(it) } ?: run { error = "Not a Muster pairing code" }
    }

    Column(Modifier.fillMaxSize().background(Color(0xFF060607)).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            RoundIcon(Ic.close, bg = Color.White.copy(alpha = 0.08f), onClick = onClose)
            Txt("Link to your PC", ts(17, 24, FontWeight.SemiBold), Modifier.weight(1f))
            RoundIcon(Ic.bolt, bg = if (torch) C.tint(C.captain, 30) else Color.White.copy(alpha = 0.08f), tint = if (torch) C.captain else C.text) { torch = !torch }
        }
        Box(
            Modifier.weight(1f).fillMaxWidth().background(
                Brush.radialGradient(
                    0f to Color(0xFF1B2030), 0.55f to Color(0xFF0D0F16), 1f to Color(0xFF060607),
                ),
            ),
            contentAlignment = Alignment.Center,
        ) {
            val scanning = step == ScanStep.Scanning
            when {
                demo -> DemoQrCard()
                hasCamera -> QrCamera(torch = torch, active = scanning) { raw ->
                    val info = PairUri.parse(raw)
                    if (info == null) {
                        if (raw.startsWith("muster://", ignoreCase = true)) error = "That code is from a different Muster version. Update Muster on your PC."
                    } else if (step == ScanStep.Scanning) {
                        pair(info)
                    }
                }
                else -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(32.dp)) {
                    Txt("Camera access is off", ts(16, 22, FontWeight.SemiBold))
                    Txt("Muster needs the camera to read the code on your PC. You can type the code instead.", ts(14, 20, color = C.muted).copy(textAlign = TextAlign.Center))
                    if (asked) OutlineButton("Allow camera", Modifier.padding(top = 4.dp).width(160.dp)) { camPerm.launch(Manifest.permission.CAMERA) }
                }
            }
            if (demo || hasCamera) ScanFrame()
        }
        Box(Modifier.imePadding()) {
            Sheet {
                when (val s = step) {
                    ScanStep.Scanning -> {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Txt("Point at the code on your PC", ts(18, 24, FontWeight.SemiBold))
                            Txt(
                                "In Muster on your PC, open Settings → Phone → Link a phone. The code changes every 2 minutes and only works once.",
                                ts(14, 21, color = C.muted),
                            )
                            error?.let { Txt(it, ts(14, 20, FontWeight.Medium, C.stuck), Modifier.padding(top = 4.dp)) }
                        }
                        LinkRow("Can't scan? Type the 6-letter code") { error = null; step = ScanStep.Manual }
                    }
                    ScanStep.Manual -> ManualEntry(
                        error = error,
                        onBack = { error = null; step = ScanStep.Scanning },
                        onContinue = { code, host, port ->
                            error = null
                            scope.launch {
                                try {
                                    val fp = Pairing.probeFingerprint(host, port)
                                    step = ScanStep.Confirm(PairInfo(code, port, null, host, listOf(host)), fp)
                                } catch (e: Exception) {
                                    error = "Can't reach $host:$port. Check the address shown next to the code on your PC."
                                }
                            }
                        },
                    )
                    is ScanStep.Confirm -> {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Txt("Check it's your PC", ts(18, 24, FontWeight.SemiBold))
                            Txt(
                                "Without the QR code Muster can't check the PC by itself. Compare these characters with the ones shown under the code in Settings → Phone.",
                                ts(14, 21, color = C.muted),
                            )
                        }
                        Box(Modifier.fillMaxWidth().card(12.dp, C.surface2).padding(vertical = 16.dp), contentAlignment = Alignment.Center) {
                            Txt(CertPin.shortForm(s.fingerprint), ts(26, 32, FontWeight.Medium, mono = true, spacing = 0.06.em))
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            OutlineButton("Cancel", Modifier.weight(1f), height = 52.dp, radius = 14.dp, textStyle = ts(15, 20, FontWeight.Medium)) {
                                step = ScanStep.Scanning
                            }
                            PrimaryButton(
                                "They match", Modifier.weight(2f), bg = C.crew, fg = C.onCrew, height = 52.dp,
                                onClick = { pair(s.info.copy(fingerprint = s.fingerprint)) },
                            )
                        }
                    }
                    is ScanStep.Linking -> {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            CircularProgressIndicator(Modifier.size(22.dp), color = C.crew, strokeWidth = 2.5.dp)
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Txt("Linking to ${s.pcName}…", ts(18, 24, FontWeight.SemiBold))
                                Txt("Checking the PC's certificate and saving a key on this phone.", ts(14, 21, color = C.muted))
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun LinkRow(text: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(48.dp).clip(RoundedCornerShape(12.dp)).border(1.dp, C.line, RoundedCornerShape(12.dp))
            .clickable(onClick = onClick).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Txt(text, ts(14, 20), Modifier.weight(1f))
        Icon(Ic.chevronRight, null, tint = C.muted, modifier = Modifier.size(16.dp))
    }
}

@Composable
fun Field(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
    height: Dp = 48.dp,
    radius: Dp = 12.dp,
    keyboard: KeyboardOptions = KeyboardOptions.Default,
    singleLine: Boolean = true,
) {
    val style = ts(15, 20, mono = mono)
    BasicTextField(
        value, onChange,
        modifier = modifier,
        textStyle = style,
        singleLine = singleLine,
        keyboardOptions = keyboard,
        cursorBrush = SolidColor(C.crew),
        decorationBox = { inner ->
            Box(
                Modifier.fillMaxWidth().then(if (singleLine) Modifier.height(height) else Modifier.height(height))
                    .clip(RoundedCornerShape(radius)).background(C.surface2).border(1.dp, C.line, RoundedCornerShape(radius))
                    .padding(horizontal = 16.dp, vertical = if (singleLine) 0.dp else 12.dp),
                contentAlignment = if (singleLine) Alignment.CenterStart else Alignment.TopStart,
            ) {
                if (value.isEmpty()) Txt(placeholder, style.copy(color = C.faint, fontFamily = Geist))
                inner()
            }
        },
    )
}

@Composable
private fun ManualEntry(error: String?, onBack: () -> Unit, onContinue: (String, String, Int) -> Unit) {
    var code by remember { mutableStateOf("") }
    var address by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(error) { busy = false }
    val normalized = PairUri.normalizeCode(code)
    val addr = PairUri.parseAddress(address)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Txt("Type the code", ts(18, 24, FontWeight.SemiBold))
        Txt("Enter the 6-letter code and the PC address shown under the QR code in Settings → Phone.", ts(14, 21, color = C.muted))
    }
    Field(
        code,
        { v ->
            val raw = v.uppercase().filter { it.isLetterOrDigit() }.take(6)
            code = if (raw.length > 3) raw.take(3) + "-" + raw.drop(3) else raw
        },
        "K7M-4QX",
        Modifier.fillMaxWidth(),
        mono = true,
        keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Next, autoCorrectEnabled = false),
    )
    Field(
        address, { address = it.trim() }, "PC address, e.g. 192.168.1.20", Modifier.fillMaxWidth(), mono = true,
        keyboard = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done, autoCorrectEnabled = false),
    )
    error?.let { Txt(it, ts(14, 20, FontWeight.Medium, C.stuck)) }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlineButton("Back", Modifier.weight(1f), height = 52.dp, radius = 14.dp, textStyle = ts(15, 20, FontWeight.Medium), onClick = onBack)
        PrimaryButton(
            "Continue", Modifier.weight(2f), height = 52.dp, busy = busy, enabled = normalized != null && addr != null,
            onClick = {
                if (normalized != null && addr != null) {
                    busy = true
                    onContinue(normalized, addr.first, addr.second)
                }
            },
        )
    }
}

/** Corner brackets + sweeping scan line (264×264). */
@Composable
private fun ScanFrame() {
    val t = rememberInfiniteTransition(label = "scan")
    val y by t.animateFloat(0.15f, 0.85f, infiniteRepeatable(tween(1800, easing = LinearEasing), RepeatMode.Reverse), label = "y")
    Canvas(Modifier.size(264.dp)) {
        val s = 4.dp.toPx()
        val k = 44.dp.toPx()
        val r = 11.dp.toPx()
        val i = 3.dp.toPx() / 44.dp.toPx() * k
        fun corner(x0: Float, y0: Float, sx: Float, sy: Float) {
            val p = androidx.compose.ui.graphics.Path().apply {
                moveTo(x0 + sx * i, y0 + sy * (k - i))
                lineTo(x0 + sx * i, y0 + sy * (i + r))
                quadraticTo(x0 + sx * i, y0 + sy * i, x0 + sx * (i + r), y0 + sy * i)
                lineTo(x0 + sx * (k - i), y0 + sy * i)
            }
            drawPath(p, C.crew, style = androidx.compose.ui.graphics.drawscope.Stroke(s, cap = StrokeCap.Round))
        }
        corner(0f, 0f, 1f, 1f)
        corner(size.width, 0f, -1f, 1f)
        corner(0f, size.height, 1f, -1f)
        corner(size.width, size.height, -1f, -1f)
        val ly = size.height * y
        val x0 = 18.dp.toPx()
        val x1 = size.width - 18.dp.toPx()
        drawRect(
            Brush.horizontalGradient(listOf(Color.Transparent, C.crew.copy(alpha = 0.25f), Color.Transparent), x0, x1),
            Offset(x0, ly - 8.dp.toPx()), androidx.compose.ui.geometry.Size(x1 - x0, 16.dp.toPx()),
        )
        drawRect(
            Brush.horizontalGradient(listOf(Color.Transparent, C.crew, Color.Transparent), x0, x1),
            Offset(x0, ly - 1.dp.toPx()), androidx.compose.ui.geometry.Size(x1 - x0, 2.dp.toPx()),
        )
    }
}

/** The PC-screen-with-QR illustration from M02 (demo mode stands in for the camera). */
@Composable
private fun DemoQrCard() {
    Box(
        Modifier.size(300.dp, 230.dp).rotate(-3f).shadow(40.dp, RoundedCornerShape(10.dp), ambientColor = C.glowBlue, spotColor = C.glowBlue)
            .clip(RoundedCornerShape(10.dp))
            .background(Brush.linearGradient(listOf(Color(0xFF1A1A1F), Color(0xFF141418))))
            .border(1.dp, Color(0xFF2A2A30), RoundedCornerShape(10.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(196.dp).clip(RoundedCornerShape(12.dp)).background(Color.White), contentAlignment = Alignment.Center) {
            val modules = remember {
                val rnd = Random(42)
                Array(25) { y -> BooleanArray(25) { x -> rnd.nextFloat() < 0.47f } }.also { m ->
                    fun finder(ox: Int, oy: Int) {
                        for (y in -1..7) for (x in -1..7) {
                            val xx = ox + x
                            val yy = oy + y
                            if (xx !in 0..24 || yy !in 0..24) continue
                            val ring = x in 0..6 && y in 0..6 && (x == 0 || x == 6 || y == 0 || y == 6)
                            val core = x in 2..4 && y in 2..4
                            m[yy][xx] = ring || core
                        }
                    }
                    finder(0, 0); finder(18, 0); finder(0, 18)
                }
            }
            Canvas(Modifier.size(168.dp)) {
                val cell = size.width / 25f
                for (y in 0 until 25) for (x in 0 until 25) if (modules[y][x]) {
                    drawRect(Color(0xFF111113), Offset(x * cell, y * cell), androidx.compose.ui.geometry.Size(cell + 0.5f, cell + 0.5f))
                }
            }
        }
    }
}

// ---------------------------------------------------------------- M03 linked

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LinkedScreen(onContinue: () -> Unit) {
    val ctx = LocalContext.current
    val state = MusterApp.state
    val needs by state.needs.collectAsState()
    val demo by state.demo.collectAsState()
    val link = state.currentLink()
    LaunchedEffect(Unit) { state.refreshNeeds() }
    var granted by remember { mutableStateOf(Notifier.canPost(ctx)) }
    val perm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    val pcName = needs?.pcName?.ifBlank { null } ?: link?.pcName ?: "your PC"

    Column(Modifier.fillMaxSize().background(C.bg).statusBarsPadding().navigationBarsPadding()) {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 28.dp, end = 28.dp, top = 64.dp),
            verticalArrangement = Arrangement.spacedBy(28.dp),
        ) {
            Box(
                Modifier.size(64.dp).drawBehind {
                    drawCircle(Brush.radialGradient(listOf(C.crew.copy(alpha = 0.25f), Color.Transparent), radius = 56.dp.toPx()), radius = 56.dp.toPx())
                }.clip(CircleShape).background(C.tint(C.crew, 16)).border(1.dp, C.tint(C.crew, 40), CircleShape),
                contentAlignment = Alignment.Center,
            ) { Icon(Ic.checkBold, null, tint = C.crew, modifier = Modifier.size(28.dp)) }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Txt("Linked to $pcName", ts(30, 36, FontWeight.SemiBold, spacing = (-0.02).em))
                Txt("This phone now hears from Muster. You can unlink it any time, here or on your PC.", ts(16, 24, color = C.muted))
            }
            Column(Modifier.fillMaxWidth().card()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionLabel("Projects")
                    val projects = needs?.projects.orEmpty()
                    if (projects.isEmpty()) {
                        Txt(if (needs == null) "Loading…" else "No projects yet. Open one in Muster on your PC.", ts(13, 18, color = C.muted))
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        projects.forEach { p ->
                            Row(
                                Modifier.height(28.dp).clip(RoundedCornerShape(14.dp)).background(C.surface2).padding(horizontal = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                Dot(if (p.running) C.crew else C.faint)
                                Txt(p.name, ts(13, 18, color = if (p.running) C.text else C.muted))
                            }
                        }
                    }
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(C.line))
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionLabel("Reaches your PC")
                    reachRows(link?.hosts.orEmpty()).forEach { (label, value) ->
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Txt(label, ts(14, 20), Modifier.weight(1f))
                            Txt(value, ts(13, 18, color = C.muted, mono = true))
                        }
                    }
                }
            }
            Row(
                Modifier.fillMaxWidth().card(bg = C.mix(C.warm, 8, C.surface), border = C.tint(C.warm, 40)).padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                IconBox(Ic.bell, C.warm, 36.dp, 18.dp, 10.dp, bgPct = 18)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Txt(if (granted) "Notifications are on" else "Allow notifications", ts(15, 21, FontWeight.Medium))
                    Txt("So you hear about approvals and questions straight away.", ts(13, 19, color = C.muted))
                }
                if (granted) {
                    Icon(Ic.checkBold, null, tint = C.crew, modifier = Modifier.size(20.dp))
                } else {
                    PrimaryButton(
                        "Allow", height = 34.dp, radius = 10.dp, textStyle = ts(14, 20, FontWeight.SemiBold),
                        modifier = Modifier.width(66.dp),
                        onClick = { if (!demo) perm.launch(Manifest.permission.POST_NOTIFICATIONS) },
                    )
                }
            }
        }
        Column(Modifier.padding(start = 28.dp, end = 28.dp, bottom = 40.dp, top = 12.dp)) {
            PrimaryButton("Show what needs me", Modifier.fillMaxWidth(), bg = C.crew, fg = C.onCrew, onClick = {
                state.startListening()
                onContinue()
            })
        }
    }
}

/** "At home · Wi-Fi · 192.168.1.20" / "Out and about · Tailscale · wayne-pc" from the paired hosts. */
fun reachRows(hosts: List<String>): List<Pair<String, String>> {
    val ts = hosts.filter { isTailscale(it) }
    val lan = hosts.filterNot { isTailscale(it) }
    val rows = mutableListOf<Pair<String, String>>()
    lan.firstOrNull()?.let { rows += "At home" to "Wi-Fi · $it" }
    if (ts.isNotEmpty()) {
        val name = ts.firstOrNull { it.any(Char::isLetter) }?.substringBefore('.') ?: ts.first()
        rows += "Out and about" to "Tailscale · $name"
    }
    return rows
}

fun isTailscale(host: String): Boolean {
    if (host.endsWith(".ts.net", ignoreCase = true)) return true
    val p = host.split('.').mapNotNull { it.toIntOrNull() }
    return p.size == 4 && p[0] == 100 && p[1] in 64..127
}


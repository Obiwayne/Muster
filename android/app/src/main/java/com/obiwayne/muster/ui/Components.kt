package com.obiwayne.muster.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.obiwayne.muster.MusterApp
import com.obiwayne.muster.data.Kind
import com.obiwayne.muster.data.Project
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
fun Txt(
    text: String,
    style: TextStyle,
    modifier: Modifier = Modifier,
    maxLines: Int = Int.MAX_VALUE,
    color: Color = Color.Unspecified,
) = Text(
    text,
    modifier = modifier,
    style = if (color != Color.Unspecified) style.copy(color = color) else style,
    maxLines = maxLines,
    overflow = if (maxLines == Int.MAX_VALUE) TextOverflow.Clip else TextOverflow.Ellipsis,
)

/** Click without the grey Material ripple background bleeding past rounded shapes. */
fun Modifier.tap(enabled: Boolean = true, onClick: () -> Unit): Modifier = this.clickable(enabled = enabled, onClick = onClick)

fun Modifier.card(radius: Dp = 14.dp, bg: Color = C.surface, border: Color = C.line): Modifier =
    this.clip(RoundedCornerShape(radius)).background(bg).border(1.dp, border, RoundedCornerShape(radius))

@Composable
fun Dot(color: Color, size: Dp = 6.dp, modifier: Modifier = Modifier) =
    Box(modifier.size(size).clip(CircleShape).background(color))

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) = Txt(text.uppercase(), Type.label, modifier)

/** REVIEW / QUESTION / … tag. */
@Composable
fun KindBadge(kind: String) {
    val (label, color) = when (kind) {
        Kind.REVIEW -> "REVIEW" to C.crew
        Kind.APPROVAL -> "APPROVAL" to C.crew
        Kind.QUESTION -> "QUESTION" to C.captain
        Kind.ESCALATION -> "DECISION" to C.captain
        Kind.BLOCKED -> "BLOCKED" to C.warm
        Kind.USAGE -> "USAGE" to C.muted
        Kind.STUCK -> "STUCK" to C.stuck
        else -> kind.uppercase() to C.muted
    }
    Box(Modifier.clip(RoundedCornerShape(5.dp)).background(C.tint(color, 14)).padding(horizontal = 7.dp, vertical = 3.dp)) {
        Txt(label, ts(11, 14, FontWeight.SemiBold, color, spacing = Type.label.letterSpacing))
    }
}

@Composable
fun IconBox(icon: ImageVector, tint: Color, box: Dp, iconSize: Dp, radius: Dp, bgPct: Int = 14, modifier: Modifier = Modifier) {
    Box(
        modifier.size(box).clip(RoundedCornerShape(radius)).background(C.tint(tint, bgPct)),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, tint = tint, modifier = Modifier.size(iconSize)) }
}

@Composable
fun Avatar(name: String, color: Color, size: Dp = 32.dp, bgPct: Int = 18, border: Boolean = false) {
    Box(
        Modifier.size(size).clip(CircleShape).background(C.tint(color, bgPct))
            .then(if (border) Modifier.border(1.dp, C.tint(color, 45), CircleShape) else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Txt(name.take(1).uppercase(), ts(if (size < 30.dp) 13 else 14, 16, if (border) FontWeight.Bold else FontWeight.SemiBold, color))
    }
}

fun agentColor(id: String, role: String? = null): Color = when {
    id == "captain" || role == "captain" -> C.captain
    id == "design" || role == "design" -> C.design
    id == "you" || role == "human" -> C.text
    id == "muster" -> C.muted
    else -> C.crew
}

@Composable
fun PrimaryButton(
    text: String,
    modifier: Modifier = Modifier,
    bg: Color = C.primaryBtn,
    fg: Color = C.onPrimary,
    height: Dp = 56.dp,
    radius: Dp = 14.dp,
    textStyle: TextStyle = ts(16, 22, FontWeight.SemiBold),
    icon: ImageVector? = null,
    iconSize: Dp = 20.dp,
    gap: Dp = 10.dp,
    busy: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Row(
        modifier.height(height).clip(RoundedCornerShape(radius)).background(if (enabled) bg else bg.copy(alpha = 0.5f))
            .clickable(enabled = enabled && !busy, onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), color = fg, strokeWidth = 2.dp)
        } else {
            if (icon != null) {
                Icon(icon, null, tint = fg, modifier = Modifier.size(iconSize))
                Spacer(Modifier.width(gap))
            }
            Txt(text, textStyle.copy(color = fg))
        }
    }
}

@Composable
fun OutlineButton(
    text: String,
    modifier: Modifier = Modifier,
    height: Dp = 36.dp,
    radius: Dp = 12.dp,
    textStyle: TextStyle = ts(14, 20, FontWeight.Medium),
    border: Color = C.line,
    icon: ImageVector? = null,
    busy: Boolean = false,
    onClick: () -> Unit,
) {
    Row(
        modifier.height(height).clip(RoundedCornerShape(radius)).border(1.dp, border, RoundedCornerShape(radius))
            .clickable(enabled = !busy, onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(16.dp), color = textStyle.color, strokeWidth = 2.dp)
        } else {
            if (icon != null) {
                Icon(icon, null, tint = textStyle.color, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
            }
            Txt(text, textStyle)
        }
    }
}

/** The 40×24 switch from M09. */
@Composable
fun Toggle(on: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier.size(40.dp, 24.dp).clip(RoundedCornerShape(12.dp))
            .background(if (on) C.crew else C.surface2)
            .then(if (on) Modifier else Modifier.border(1.dp, C.line, RoundedCornerShape(12.dp)))
            .clickable { onChange(!on) }
            .padding(horizontal = 3.dp),
        contentAlignment = if (on) Alignment.CenterEnd else Alignment.CenterStart,
    ) {
        Box(Modifier.size(18.dp).clip(CircleShape).background(if (on) C.onCrew else C.muted))
    }
}

/** Project switcher chip with its menu. [selected] null = all projects. */
@Composable
fun ProjectChip(
    projects: List<Project>,
    selected: String?,
    onSelect: (String?) -> Unit,
    bordered: Boolean = false,
    dotColor: Color = C.success,
    glow: Boolean = true,
) {
    var open by remember { mutableStateOf(false) }
    val p = projects.firstOrNull { it.id == selected }
    Box {
        Row(
            Modifier.height(32.dp).clip(RoundedCornerShape(16.dp)).background(C.surface2)
                .then(if (bordered) Modifier.border(1.dp, C.line, RoundedCornerShape(16.dp)) else Modifier)
                .clickable { open = true }
                .padding(start = 12.dp, end = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val running = p?.running ?: projects.any { it.running }
            val c = if (running) dotColor else C.faint
            Box(
                Modifier.size(7.dp).then(
                    if (glow && running) Modifier.drawBehind {
                        drawCircle(c.copy(alpha = 0.25f), radius = size.minDimension * 1.1f)
                    } else Modifier,
                ).clip(CircleShape).background(c),
            )
            Txt(p?.name ?: "All projects", ts(14, if (bordered) 18 else 20, FontWeight.SemiBold), maxLines = 1, modifier = Modifier.widthIn(max = 180.dp))
            Icon(Ic.chevronDown, null, tint = C.muted, modifier = Modifier.size(16.dp))
        }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            containerColor = C.surface2,
            shape = RoundedCornerShape(12.dp),
        ) {
            DropdownMenuItem(
                text = { Txt("All projects", ts(14, 20, if (selected == null) FontWeight.SemiBold else FontWeight.Normal)) },
                onClick = { open = false; onSelect(null) },
            )
            projects.forEach { pr ->
                DropdownMenuItem(
                    leadingIcon = { Dot(if (pr.running) C.crew else C.faint, 7.dp) },
                    text = {
                        Txt(
                            pr.name,
                            ts(14, 20, if (pr.id == selected) FontWeight.SemiBold else FontWeight.Normal, if (pr.running) C.text else C.muted),
                        )
                    },
                    onClick = { open = false; onSelect(pr.id) },
                )
            }
        }
    }
}

@Composable
fun PcPill(name: String, online: Boolean) {
    Row(
        Modifier.height(28.dp).clip(RoundedCornerShape(14.dp)).border(1.dp, C.line, RoundedCornerShape(14.dp)).padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Dot(if (online) C.crew else C.stuck, 6.dp)
        Txt(name, ts(12, 16, color = C.muted, mono = true))
    }
}

/** A circular 40dp icon button (M02's close/flash, M05's back/more). */
@Composable
fun RoundIcon(icon: ImageVector, size: Dp = 40.dp, iconSize: Dp = 18.dp, bg: Color = Color.Transparent, tint: Color = C.text, onClick: () -> Unit) {
    Box(
        Modifier.size(size).clip(CircleShape).background(bg).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, tint = tint, modifier = Modifier.size(iconSize)) }
}

// ---------------------------------------------------------------- evidence thumbnails

/** Loads image bytes through the API (pinned TLS + bearer); null while loading, on error, or in demo mode. */
@Composable
fun rememberApiImage(key: String, load: suspend com.obiwayne.muster.data.Backend.() -> ByteArray?): ImageBitmap? {
    var bmp by remember(key) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(key) {
        val bytes = MusterApp.state.call { load() } ?: return@LaunchedEffect
        bmp = withContext(Dispatchers.Default) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= 720) sample *= 2
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
        }
    }
    return bmp
}

fun isImage(name: String) = name.substringAfterLast('.').lowercase() in setOf("png", "jpg", "jpeg", "webp", "gif")

/**
 * An evidence thumbnail. [source] is either a gateway path (NeedItem.evidence.thumbs) or a file name inside
 * evidence [eid] of task [tid]. Falls back to the schematic mock (demo mode, loading, non-images).
 */
@Composable
fun EvidenceThumb(
    pid: String,
    tid: String,
    eid: String,
    source: String,
    variant: Int,
    small: Boolean,
    modifier: Modifier = Modifier,
) {
    val name = source.substringAfterLast('/')
    val bmp = if (isImage(name)) {
        rememberApiImage("$pid/$tid/$eid/$source") {
            if (source.startsWith("/")) fetchPath(source) else evidenceFile(pid, tid, eid, source)
        }
    } else null
    val shape = RoundedCornerShape(if (small) 7.dp else 10.dp)
    Box(
        modifier.clip(shape).background(if (small) Color(0xFF26262B) else Color(0xFF1E1E22)).border(1.dp, C.line, shape),
    ) {
        if (bmp != null) {
            Image(bmp, name, contentScale = ContentScale.Crop, alignment = Alignment.TopCenter, modifier = Modifier.fillMaxSize())
        } else if (small) {
            MockThumbSmall(variant)
        } else {
            MockThumbLarge(variant)
        }
    }
}

@Composable
private fun Bar(w: Dp?, h: Dp, color: Color, radius: Dp = 2.dp, modifier: Modifier = Modifier) =
    Box((if (w != null) modifier.width(w) else modifier.fillMaxWidth()).height(h).clip(RoundedCornerShape(radius)).background(color))

/** The schematic thumbnails from M04 (used in demo mode and while a real image loads). */
@Composable
fun MockThumbSmall(variant: Int) {
    Column(Modifier.fillMaxSize().padding(horizontal = 8.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(if (variant == 2) 5.dp else 4.dp)) {
        when (variant % 3) {
            0 -> {
                Bar(28.dp, 4.dp, Color(0xFF3A3A41))
                Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Box(Modifier.width(14.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(Color(0xFF303036)))
                    Box(
                        Modifier.weight(1f).fillMaxHeight().drawBehind {
                            drawRoundRect(
                                Color(0xFF44444C), cornerRadius = CornerRadius(3.dp.toPx()),
                                style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4f, 3f))),
                            )
                        },
                    )
                }
            }
            1 -> {
                Bar(36.dp, 4.dp, Color(0xFF3A3A41))
                Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(Color(0xFF303036)))
                    Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(Color(0xFF303036)))
                    Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(C.mix(C.crew, 30, Color(0xFF303036))))
                }
            }
            else -> {
                Bar(24.dp, 4.dp, Color(0xFF3A3A41))
                Progress(0.62f, 5.dp, Color(0xFF303036), C.mix(C.design, 55, Color(0xFF303036)))
                Progress(0.38f, 5.dp, Color(0xFF303036), Color(0xFF4A4A52))
            }
        }
    }
}

@Composable
fun Progress(frac: Float, h: Dp, track: Color, fill: Color, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(h).clip(RoundedCornerShape(h / 2)).background(track)) {
        Box(Modifier.fillMaxWidth(frac.coerceIn(0f, 1f)).fillMaxHeight().clip(RoundedCornerShape(h / 2)).background(fill))
    }
}

@Composable
fun MockThumbLarge(variant: Int) {
    Row(Modifier.fillMaxSize()) {
        Column(Modifier.width(30.dp).fillMaxHeight().background(Color(0xFF26262B)).padding(horizontal = 7.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Bar(null, 4.dp, Color(0xFF3A3A41))
            Bar(null, 4.dp, Color(0xFF33333A))
            Bar(null, 4.dp, Color(0xFF33333A))
        }
        if (variant % 2 == 0) {
            Column(
                Modifier.weight(1f).fillMaxHeight().padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Box(
                    Modifier.size(30.dp).drawBehind {
                        drawRoundRect(
                            Color(0xFF4A4A52), cornerRadius = CornerRadius(9.dp.toPx()),
                            style = Stroke(1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(5f, 4f))),
                        )
                    },
                )
                Bar(64.dp, 5.dp, Color(0xFF3A3A41), 3.dp)
                Bar(44.dp, 4.dp, Color(0xFF2E2E34))
                Bar(46.dp, 12.dp, C.mix(C.crew, 45, Color(0xFF26262B)), 4.dp)
            }
        } else {
            Column(Modifier.weight(1f).fillMaxHeight().padding(10.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Bar(50.dp, 5.dp, Color(0xFF3A3A41), 3.dp)
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    repeat(3) { Box(Modifier.weight(1f).height(28.dp).clip(RoundedCornerShape(5.dp)).background(Color(0xFF26262B))) }
                }
                Bar(30.dp, 4.dp, Color(0xFF2E2E34))
                Progress(0.68f, 7.dp, Color(0xFF2A2A30), C.mix(C.design, 60, Color(0xFF2A2A30)))
                Progress(0.34f, 7.dp, Color(0xFF2A2A30), C.mix(C.crew, 50, Color(0xFF2A2A30)))
            }
        }
    }
}

// ---------------------------------------------------------------- bottom nav

enum class Tab(val label: String) { NEEDS("Needs you"), CREW("Crew"), SETTINGS("Settings") }

@Composable
fun BottomNav(current: Tab, badge: Int, onSelect: (Tab) -> Unit) {
    Column(
        Modifier.fillMaxWidth().background(C.surface).drawBehind {
            drawLine(C.line, androidx.compose.ui.geometry.Offset(0f, 0f), androidx.compose.ui.geometry.Offset(size.width, 0f), 1.dp.toPx())
        }.padding(bottom = 16.dp),
    ) {
        Row(Modifier.fillMaxWidth().height(64.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Tab.entries.forEach { tab ->
                val active = tab == current
                Column(
                    Modifier.weight(1f).clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = ripple(bounded = false, radius = 40.dp),
                    ) { onSelect(tab) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Box(Modifier.size(60.dp, 30.dp)) {
                        Box(
                            Modifier.matchParentSize().clip(RoundedCornerShape(15.dp)).background(if (active) C.surface2 else Color.Transparent),
                            contentAlignment = Alignment.Center,
                        ) {
                            val icon = when (tab) {
                                Tab.NEEDS -> Ic.inbox
                                Tab.CREW -> Ic.crew
                                Tab.SETTINGS -> Ic.settings
                            }
                            Icon(icon, null, tint = if (active) C.text else C.muted, modifier = Modifier.size(20.dp))
                        }
                        if (tab == Tab.NEEDS && badge > 0) {
                            Box(
                                Modifier.offset(x = 36.dp, y = (-3).dp).height(18.dp).widthIn(min = 18.dp)
                                    .clip(RoundedCornerShape(9.dp)).background(C.surface).padding(2.dp)
                                    .clip(RoundedCornerShape(7.dp)).background(C.warm).padding(horizontal = 3.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Txt(if (badge > 99) "99+" else badge.toString(), ts(10, 12, FontWeight.Bold, C.onWarm))
                            }
                        }
                    }
                    Txt(tab.label, ts(12, 16, if (active) FontWeight.SemiBold else FontWeight.Medium, if (active) C.text else C.muted))
                }
            }
        }
    }
}

@Composable
fun Sheet(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)).background(C.surface)
            .border(1.dp, C.line, RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp))
            .navigationBarsPadding()
            .padding(PaddingValues(start = 24.dp, end = 24.dp, top = 24.dp, bottom = 36.dp)),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        content = content,
    )
}

@Composable
fun RowScope.Fill() = Spacer(Modifier.weight(1f))

fun Modifier.dim(on: Boolean) = if (on) this.alpha(0.45f) else this

@Suppress("unused")
val Pill: Shape = RoundedCornerShape(50)

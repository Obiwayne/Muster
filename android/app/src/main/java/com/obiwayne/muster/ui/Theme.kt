package com.obiwayne.muster.ui

import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.obiwayne.muster.R

/** Design tokens from the Vellum "Muster" file. */
object C {
    val bg = Color(0xFF111113)
    val term = Color(0xFF0C0C0E)
    val surface = Color(0xFF19191C)
    val surface2 = Color(0xFF222226)
    val line = Color(0xFF2D2D32)
    val text = Color(0xFFF4F4F5)
    val muted = Color(0xFF9B9BA4)
    val faint = Color(0xFF62626B)
    val captain = Color(0xFFF5A524)
    val crew = Color(0xFF2DD4BF)
    val onCrew = Color(0xFF06231F)
    val design = Color(0xFFA78BFA)
    val stuck = Color(0xFFF2555A)
    val warm = Color(0xFFFF8A3D)
    val success = Color(0xFF34C77B)
    val glowBlue = Color(0xFF4F7BFF)
    val glowViolet = Color(0xFF8B5CF6)

    /** Text on the blue "held" tints (M10–M12). */
    val heldInk = Color(0xFF8FA9FF)
    val primaryBtn = Color(0xFFF4F4F5)
    val onPrimary = Color(0xFF111113)
    val onCaptain = Color(0xFF2A1A02)
    val onWarm = Color(0xFF2A1305)

    /** CSS `color-mix(in oklab, c p%, transparent)`: the colour at p alpha. */
    fun tint(c: Color, pct: Int) = c.copy(alpha = pct / 100f)

    /** CSS `color-mix(in oklab, a p%, b)`. */
    fun mix(a: Color, pct: Int, b: Color) = lerp(b, a, pct / 100f)
}

val Geist = FontFamily(
    Font(R.font.geist_light, FontWeight.Light),
    Font(R.font.geist_regular, FontWeight.Normal),
    Font(R.font.geist_medium, FontWeight.Medium),
    Font(R.font.geist_semibold, FontWeight.SemiBold),
    Font(R.font.geist_bold, FontWeight.Bold),
)

val GeistMono = FontFamily(
    Font(R.font.geist_mono_regular, FontWeight.Normal),
    Font(R.font.geist_mono_medium, FontWeight.Medium),
    Font(R.font.geist_mono_semibold, FontWeight.SemiBold),
)

/** A text style with CSS-like line height (centred, no font padding). */
fun ts(
    size: Int,
    lh: Int,
    weight: FontWeight = FontWeight.Normal,
    color: Color = C.text,
    mono: Boolean = false,
    spacing: TextUnit = TextUnit.Unspecified,
) = TextStyle(
    fontFamily = if (mono) GeistMono else Geist,
    fontSize = size.sp,
    lineHeight = lh.sp,
    fontWeight = weight,
    color = color,
    letterSpacing = spacing,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
    lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
)

object Type {
    val label = ts(11, 14, FontWeight.SemiBold, C.faint, spacing = 0.08.em)
}

@Composable
fun MusterTheme(content: @Composable () -> Unit) {
    val scheme = darkColorScheme(
        primary = C.crew,
        onPrimary = C.onCrew,
        secondary = C.captain,
        background = C.bg,
        onBackground = C.text,
        surface = C.surface,
        onSurface = C.text,
        surfaceVariant = C.surface2,
        onSurfaceVariant = C.muted,
        surfaceContainer = C.surface,
        surfaceContainerHigh = C.surface2,
        surfaceContainerHighest = C.surface2,
        surfaceContainerLow = C.surface,
        outline = C.line,
        outlineVariant = C.line,
        error = C.stuck,
    )
    MaterialTheme(colorScheme = scheme, typography = MaterialTheme.typography) {
        CompositionLocalProvider(LocalTextSelectionColors provides TextSelectionColors(C.crew, C.tint(C.crew, 35))) {
            content()
        }
    }
}

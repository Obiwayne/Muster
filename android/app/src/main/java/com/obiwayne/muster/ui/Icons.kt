package com.obiwayne.muster.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/** Lucide-style stroke icons from the designs' inline SVG (24×24, round caps). Tint with Icon(tint = …). */
object Ic {
    private fun circle(cx: Float, cy: Float, r: Float) = "M${cx - r} ${cy}a$r $r 0 1 0 ${2 * r} 0a$r $r 0 1 0 ${-2 * r} 0"

    private fun icon(vararg d: String, w: Float = 2f): ImageVector =
        ImageVector.Builder(defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f).apply {
            d.forEach {
                addPath(
                    pathData = addPathNodes(it),
                    fill = null,
                    stroke = SolidColor(Color.White),
                    strokeLineWidth = w,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()

    val check by lazy { icon("M20 6 9 17l-5-5", w = 2.2f) }
    val checkBold by lazy { icon("M20 6 9 17l-5-5", w = 2.4f) }
    val checkAll by lazy { icon("M18 6 7 17l-5-5", "m22 10-7.5 7.5L13 16", w = 2.4f) }
    val message by lazy { icon("M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", w = 2.2f) }
    val users by lazy {
        icon("M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2", circle(9f, 7f, 4f), "M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8", w = 2.2f)
    }
    val crew by lazy {
        icon("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", circle(9f, 7f, 4f), "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75")
    }
    val scan by lazy { icon("M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2", "M7 12h10") }
    val close by lazy { icon("M18 6 6 18M6 6l12 12") }
    val bolt by lazy { icon("M13 2 3 14h9l-1 8 10-12h-9l1-8z") }
    val chevronRight by lazy { icon("m9 18 6-6-6-6") }
    val chevronDown by lazy { icon("m6 9 6 6 6-6") }
    val chevronLeft by lazy { icon("M15 18l-6-6 6-6") }
    val bell by lazy { icon("M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.9 1.9 0 0 0 3.4 0") }
    val inbox by lazy {
        icon(
            "M22 12h-6l-2 3h-4l-2-3H2",
            "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
        )
    }
    val settings by lazy {
        icon(
            "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
            circle(12f, 12f, 3f),
        )
    }
    val arrowLeft by lazy { icon("m12 19-7-7 7-7", "M19 12H5") }
    val arrowUp by lazy { icon("M12 19V5", "M5 12l7-7 7 7") }
    val more by lazy { icon(circle(12f, 5f, 1f), circle(12f, 12f, 1f), circle(12f, 19f, 1f)) }
    val branch by lazy { icon("M6 3v12", circle(18f, 6f, 3f), circle(6f, 18f, 3f), "M18 9a9 9 0 0 1-9 9") }
    val merge by lazy { icon(circle(18f, 18f, 3f), circle(6f, 6f, 3f), "M6 21V9a9 9 0 0 0 9 9", w = 2.4f) }
    val pause by lazy {
        icon(
            "M7 4h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
            "M15 4h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
        )
    }
    val play by lazy { icon("M6 4l14 8-14 8z") }
    val monitor by lazy { icon("M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M8 21h8", "M12 17v4") }
    val refresh by lazy { icon("M21 12a9 9 0 1 1-3-6.7L21 8", "M21 3v5h-5") }
    val keyboard by lazy {
        icon("M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", "M6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 13h.01M12 13h.01M16 13h.01M7 16h10")
    }
    val alert by lazy { icon(circle(12f, 12f, 10f), "M12 8v4", "M12 16h.01") }
}

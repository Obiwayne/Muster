package com.obiwayne.muster.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

class TextRulesTest {
    @Test fun quickAnswersFromAnOrQuestion() {
        assertEquals(
            listOf("Friendly 'link expired' page", "Plain 404"),
            QuickAnswers.from("Should a revoked invite link show a friendly 'link expired' page or a plain 404? bea needs this for T4."),
        )
        assertEquals(listOf("Tabs", "Spaces"), QuickAnswers.from("Do we use tabs or spaces?"))
        assertTrue(QuickAnswers.from("What colour should the button be?").isEmpty())
        assertTrue(QuickAnswers.from("Ship it or not").isEmpty()) // not a question
    }

    @Test fun reviewLines() {
        val lines = ReviewText.lines("Passed.\n- S24 matches\n- `tsc clean · 2076 tests passed`\n- Minor: chip spacing 2px off, logged as T63")
        assertEquals(3, lines.size)
        assertEquals(ReviewLine.Style.PASS, lines[0].style)
        assertTrue(lines[1].mono)
        assertEquals("tsc clean · 2076 tests passed", lines[1].text)
        assertEquals(ReviewLine.Style.NOTE, lines[2].style)
        val prose = ReviewText.lines("Looks good, merging is safe.")
        assertEquals(ReviewLine.Style.TEXT, prose.single().style)
    }

    @Test fun relativeTimes() {
        val now = Instant.parse("2026-10-04T10:00:00Z")
        assertEquals("now", Ago.short("2026-10-04T09:59:30Z", now))
        assertEquals("4m", Ago.short("2026-10-04T09:56:00Z", now))
        assertEquals("2h", Ago.short("2026-10-04T08:00:00Z", now))
        assertEquals("", Ago.short("garbage", now))
        assertEquals("resets 2h 10m", Ago.resets("2026-10-04T12:10:00Z", now, ZoneOffset.UTC))
        assertEquals("resets 45m", Ago.resets("2026-10-04T10:45:00Z", now, ZoneOffset.UTC))
        assertEquals("resets Mon", Ago.resets("2026-10-05T09:00:00Z", now, ZoneOffset.UTC).replace("Mon.", "Mon"))
    }
}

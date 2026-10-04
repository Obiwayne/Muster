package com.obiwayne.muster.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QuietHoursTest {
    private fun m(h: Int, min: Int = 0) = h * 60 + min
    private val night = QuietPrefs(true, "22:00", "07:00")

    @Test fun parseAndFormat() {
        assertEquals(1320, QuietHours.parse("22:00"))
        assertEquals(7 * 60 + 5, QuietHours.parse("07:05"))
        assertNull(QuietHours.parse("24:00"))
        assertNull(QuietHours.parse("7pm"))
        assertEquals("07:05", QuietHours.format(425))
    }

    @Test fun wrapsPastMidnight() {
        assertTrue(QuietHours.isQuiet(night, m(22)))
        assertTrue(QuietHours.isQuiet(night, m(23, 59)))
        assertTrue(QuietHours.isQuiet(night, m(3)))
        assertTrue(QuietHours.isQuiet(night, m(6, 59)))
        assertFalse(QuietHours.isQuiet(night, m(7)))
        assertFalse(QuietHours.isQuiet(night, m(12)))
        assertFalse(QuietHours.isQuiet(night, m(21, 59)))
    }

    @Test fun sameDayWindowOffAndEqualEnds() {
        val lunch = QuietPrefs(true, "12:00", "13:30")
        assertTrue(QuietHours.isQuiet(lunch, m(12, 45)))
        assertFalse(QuietHours.isQuiet(lunch, m(13, 30)))
        assertFalse(QuietHours.isQuiet(night.copy(on = false), m(23)))
        assertFalse(QuietHours.isQuiet(QuietPrefs(true, "09:00", "09:00"), m(9)))
    }

    private fun item(kind: String, project: String = "p1") = NeedItem(id = "$project:N1", projectId = project, kind = kind)

    @Test fun onlyBlockedGetsThroughQuietHours() {
        val prefs = Prefs()
        assertTrue(QuietHours.shouldNotify(item(Kind.REVIEW), prefs, m(12)))
        assertFalse(QuietHours.shouldNotify(item(Kind.REVIEW), prefs, m(23)))
        assertTrue(QuietHours.shouldNotify(item(Kind.BLOCKED), prefs, m(23)))
        assertFalse(QuietHours.shouldNotify(item(Kind.QUESTION), prefs, m(2)))
    }

    @Test fun respectsSwitchesAndProjects() {
        val prefs = Prefs()
        assertFalse(QuietHours.shouldNotify(item(Kind.USAGE), prefs, m(12))) // off by default
        assertFalse(QuietHours.shouldNotify(item(Kind.STUCK), prefs, m(12)))
        assertTrue(QuietHours.shouldNotify(item(Kind.APPROVAL), prefs, m(12))) // review switch covers approval
        assertTrue(QuietHours.shouldNotify(item(Kind.ESCALATION), prefs, m(12))) // question switch covers escalation
        val noReviews = prefs.copy(notify = prefs.notify.copy(review = false))
        assertFalse(QuietHours.shouldNotify(item(Kind.APPROVAL), noReviews, m(12)))
        val projectOff = prefs.copy(projects = mapOf("p1" to false))
        assertFalse(QuietHours.shouldNotify(item(Kind.BLOCKED), projectOff, m(12)))
        assertTrue(QuietHours.shouldNotify(item(Kind.BLOCKED, "p2"), projectOff, m(12)))
    }
}

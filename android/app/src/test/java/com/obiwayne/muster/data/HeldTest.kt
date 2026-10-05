package com.obiwayne.muster.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

class HeldTest {
    private val json = """
        {
          "pcName": "WAYNE-PC",
          "projects": [{ "id": "a1b2", "name": "StarCut", "running": true }],
          "hold": { "on": false, "offSince": "2026-10-05T14:40:00.000Z", "sentWithoutTap": 3 },
          "items": [
            { "id": "a1b2:P8", "projectId": "a1b2", "projectName": "StarCut", "kind": "remote_write", "noteId": "N12",
              "title": "Claude wants to reply on N12", "summary": "Go with 7 days", "from": "Claude",
              "createdAt": "2026-10-05T14:00:00.000Z", "actions": ["send", "discard"],
              "remote": { "pendingId": "P8", "kind": "reply", "projectName": "StarCut", "client": "Claude",
                "text": "Go with 7 days,\n\nand the friendly page.", "replyTo": { "id": "N12", "from": "ada", "type": "question", "text": "7 or 30?" },
                "createdAt": "2026-10-05T14:00:00.000Z", "expiresAt": "2026-10-05T14:15:00.000Z", "digest": "abc123", "future": 1 } },
            { "id": "a1b2:P11", "projectId": "a1b2", "kind": "remote_write", "noteId": "N15", "createdAt": "2026-10-05T14:01:00Z",
              "actions": ["send", "discard"],
              "remote": { "pendingId": "P11", "kind": "answer", "client": "Claude",
                "answers": [{ "choices": ["MP4 (H.264)", "WebM"] }, { "other": "Line one\nLine two" }],
                "replyTo": { "id": "N15", "from": "captain", "type": "escalation", "text": "Formats? Anything else?",
                  "questions": [
                    { "header": "Formats", "question": "Export formats: which should the dialog offer?", "multiSelect": true, "options": ["MP4 (H.264)", "WebM"] },
                    { "header": "Anything else", "question": "Anything else?", "multiSelect": false, "options": ["No"] }
                  ] },
                "createdAt": "2026-10-05T14:01:00Z", "expiresAt": "2026-10-05T14:16:00Z", "digest": "def456" } }
          ]
        }
    """.trimIndent()

    private val at = Instant.parse("2026-10-05T14:12:42Z")

    @Test fun parsesHeldItemsAndHold() {
        val r = Parse.needs(json)
        assertFalse(r.hold!!.on)
        assertEquals(3, r.hold!!.sentWithoutTap)
        val reply = r.items[0]
        assertTrue(reply.isHeld)
        assertFalse(reply.isQuestion)
        assertEquals("abc123", reply.remote!!.digest)
        assertEquals("Go with 7 days,\n\nand the friendly page.", reply.remote!!.text)
        assertEquals("ada", reply.remote!!.replyTo!!.from)
        assertEquals("question", reply.remote!!.replyTo!!.type)
        assertTrue(reply.remote!!.replyTo!!.questions.isEmpty())
        val answer = r.items[1].remote!!
        val qs = answer.replyTo!!.questions
        assertEquals(2, qs.size) // same order as answers
        assertEquals("Export formats: which should the dialog offer?", qs[0].question)
        assertTrue(qs[0].multiSelect)
        assertEquals(listOf("MP4 (H.264)", "WebM"), qs[0].options)
        assertEquals("escalation", answer.replyTo!!.type)
        assertEquals(listOf("MP4 (H.264)", "WebM"), answer.answers[0].choices)
        assertEquals(emptyList<String>(), answer.answers[1].choices)
        assertEquals("Line one\nLine two", answer.answers[1].other)
    }

    @Test fun oldGatewayHasNoHold() {
        assertNull(Parse.needs("""{ "items": [] }""").hold)
    }

    @Test fun digestGoesBackUnchanged() {
        assertEquals("""{"digest":"abc123"}""", Parse.digestBody("abc123"))
    }

    @Test fun countdownAndExpiry() {
        val r = Parse.needs(json).items[0].remote!!
        assertEquals("2:18 left", Held.countdown(r, at))
        assertEquals(138L, Held.secondsLeft(r, at))
        assertTrue(Held.secondsLeft(r, at)!! < Held.WARN_SECONDS)
        assertFalse(Held.isExpired(r, at))
        assertTrue(Held.isExpired(r, Instant.parse("2026-10-05T14:15:00Z")))
        assertEquals("0:00 left", Held.countdown(r, Instant.parse("2026-10-05T14:20:00Z")))
    }

    @Test fun titlesRoutesAndText() {
        val items = Parse.needs(json).items
        val reply = items[0]
        val answer = items[1]
        assertEquals("Claude wants to reply on N12", Held.title(reply, reply.remote!!))
        assertEquals("Claude wanted to reply on N12", Held.title(reply, reply.remote!!, expired = true))
        assertEquals("StarCut · note N12", Held.route(reply, reply.remote!!))
        assertEquals("HELD · REPLY", Held.chip(reply.remote!!))
        assertEquals("Locked. It reaches ada and the Captain, as yours via Claude, only when you tap Send.", Held.lockText(reply.remote!!))
        assertEquals("asked 12 min ago in the Claude app", Held.asked(reply.remote!!, at))
        assertEquals("Claude wants to answer the Captain's 2 questions on N15", Held.title(answer, answer.remote!!))
        val goal = RemoteWrite("P7", WriteKind.GOAL, "StarCut", "Claude", text = "x")
        val goalItem = NeedItem("a1b2:P7", "a1b2", "StarCut", Kind.REMOTE_WRITE, remote = goal)
        assertEquals("Claude wants to give the Captain a goal", Held.title(goalItem, goal))
        assertEquals("StarCut · Captain", Held.route(goalItem, goal))
    }

    @Test fun holdLine() {
        val h = HoldInfo(false, "2026-10-05T14:40:00Z", 3)
        assertEquals("off since 14:40 · 3 sent without your tap", Held.holdLine(h, ZoneOffset.UTC))
        assertEquals("1 sent without your tap", Held.holdLine(HoldInfo(false, null, 1), ZoneOffset.UTC))
    }

    @Test fun heldWritesNotifyAsQuestionsEvenInQuietHours() {
        val item = NeedItem("p1:P1", "p1", kind = Kind.REMOTE_WRITE)
        val quiet = Prefs(quiet = QuietPrefs(true, "22:00", "07:00"))
        assertEquals("question", QuietHours.category(Kind.REMOTE_WRITE))
        assertTrue(QuietHours.shouldNotify(item, quiet, 23 * 60))
        assertFalse(QuietHours.shouldNotify(item, quiet.copy(notify = NotifyPrefs(question = false)), 12 * 60))
    }
}

package com.obiwayne.muster.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ParseTest {
    private val needsJson = """
        {
          "pcName": "Obi",
          "projects": [{ "id": "a1b2", "name": "StarCut", "running": true }, { "id": "c3d4", "name": "wall-education", "running": false }],
          "items": [
            { "id": "a1b2:N140", "projectId": "a1b2", "projectName": "StarCut", "kind": "review", "noteId": "N140", "taskId": "T58",
              "title": "S24 Empty/loading/first-use", "summary": "matches the artboards", "from": "captain", "createdAt": "2026-10-04T09:00:00.000Z",
              "evidence": { "id": "E2", "files": 8, "thumbs": ["/api/projects/a1b2/tasks/T58/evidence/E2/s24-empty.png"] },
              "actions": ["approve", "open"], "extraField": 42 },
            { "id": "a1b2:N141", "projectId": "a1b2", "kind": "approval", "taskId": "G3", "title": "Roadmap", "createdAt": "2026-10-04T09:01:00Z", "actions": ["open"] },
            { "id": "a1b2:N142", "projectId": "a1b2", "kind": "question", "noteId": "N142", "title": "Question from ada", "summary": "A or B?",
              "from": "ada", "createdAt": "2026-10-04T09:02:00Z", "evidence": null, "actions": ["answer", "open"] }
          ]
        }
    """.trimIndent()

    @Test fun needsResponse() {
        val r = Parse.needs(needsJson)
        assertEquals("Obi", r.pcName)
        assertEquals(2, r.projects.size)
        assertFalse(r.projects[1].running)
        assertEquals(3, r.items.size)
        val review = r.items[0]
        assertTrue(review.isReview)
        assertTrue(review.canApprove)
        assertEquals("E2", review.evidence!!.id)
        assertEquals(1, review.evidence!!.thumbs.size)
        val approval = r.items[1]
        assertTrue(approval.isReview)
        assertFalse(approval.canApprove) // no 'approve' action: Open only
        assertEquals("", approval.projectName)
        val q = r.items[2]
        assertTrue(q.isQuestion)
        assertNull(q.evidence)
    }

    @Test fun taskDetailWithNulls() {
        val d = Parse.task(
            """{"task":{"id":"T58","title":"x","branch":null,"status":"ready_for_merge","stations":["design","review"],"builder":"iris","reviewedSha":null},
               "review":null,"evidence":[{"id":"E1","summary":"s","files":[{"name":"a.png","kind":"image"}]}],"diffStat":null}""",
        )
        assertEquals("iris", d.task.builderName)
        assertNull(d.task.branch)
        assertNull(d.review)
        assertEquals("a.png", d.evidence[0].files[0].name)
        assertNull(Parse.task("""{"task":{"id":"T1","builder":null}}""").task.builderName)
    }

    @Test fun noteBareOrWrapped() {
        val bare = Parse.note(
            """{"id":"N142","type":"question","from":"captain","text":"Q?","createdAt":"t","open":true,"replies":[{"at":"t","from":"bea","text":"hi"}]}""",
        )
        assertEquals("bea", bare.replies[0].from)
        assertEquals("N9", Parse.note("""{"note":{"id":"N9","text":"x"}}""").id)
    }

    @Test fun crewWithNullUsage() {
        val c = Parse.crew(
            """{"agents":[{"id":"captain","role":"captain","status":"working","taskId":null,"branch":"main","detail":""}],
               "usage":{"fiveHour":null,"weekly":{"pct":41,"resetsAt":"2026-10-05T09:00:00Z"}},"paused":false}""",
        )
        assertNull(c.usage!!.fiveHour)
        assertEquals(41.0, c.usage!!.weekly!!.pct, 0.0)
        assertNull(c.roadmap)
    }

    @Test fun crewWithRoadmap() {
        val c = Parse.crew(
            """{"agents":[],"usage":null,"paused":false,
               "roadmap":{"pct":62,"current":{"id":"G9","title":"Empty states"},"status":{"text":"M4 is 62%.","at":"2026-10-04T10:00:00Z"}}}""",
        )
        assertEquals(62.0, c.roadmap!!.pct!!, 0.0)
        assertEquals("G9", c.roadmap!!.current!!.id)
        assertEquals("M4 is 62%.", c.roadmap!!.status!!.text)
        val bare = Parse.crew("""{"agents":[],"roadmap":{"pct":null,"current":null,"status":null}}""")
        assertNull(bare.roadmap!!.pct)
        assertNull(bare.roadmap!!.status)
    }

    @Test fun events() {
        val need = Parse.event(
            """{"type":"need","item":{"id":"p:N1","projectId":"p","kind":"blocked","title":"A merge is blocked","createdAt":"t","actions":["commit","stash"]}}""",
        )
        assertTrue(need is ServerEvent.Need)
        assertEquals(listOf("commit", "stash"), (need as ServerEvent.Need).item.actions)
        assertTrue(need.notify)
        val silent = Parse.event("""{"type":"need_silent","item":{"id":"p:N2","projectId":"p","kind":"question","title":"Q","createdAt":"t"}}""")
        assertEquals("p:N2", (silent as ServerEvent.Need).item.id)
        assertEquals(false, silent.notify)
        assertEquals(ServerEvent.Resolved("p:N1"), Parse.event("""{"type":"resolved","id":"p:N1"}"""))
        assertEquals(ServerEvent.Ping, Parse.event("""{"type":"ping"}"""))
        assertEquals(ServerEvent.Test, Parse.event("""{"type":"test"}"""))
        assertNull(Parse.event("not json"))
    }

    @Test fun prefsAndErrors() {
        val p = Parse.prefs("""{"notify":{"review":false},"quiet":{"on":true,"from":"23:00","to":"06:30"},"projects":{"a1b2":false}}""")
        assertFalse(p.notify.review)
        assertTrue(p.notify.question) // missing keys keep defaults
        assertEquals("06:30", p.quiet.to)
        assertEquals(false, p.projects["a1b2"])
        assertEquals("bad code", Parse.error("""{"error":"bad code"}"""))
        assertNull(Parse.error("<html>"))
    }
}

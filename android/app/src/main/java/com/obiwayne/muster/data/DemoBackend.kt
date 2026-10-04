package com.obiwayne.muster.data

import kotlinx.coroutines.delay
import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.time.temporal.TemporalAdjusters

/** Debug-only sample data that mirrors the Vellum designs (M03–M09), so the UI can be checked without a PC. */
class DemoBackend : Backend {
    override val isDemo = true

    private fun ago(minutes: Long) = Instant.now().minus(minutes, ChronoUnit.MINUTES).toString()
    private fun ahead(minutes: Long) = Instant.now().plus(minutes, ChronoUnit.MINUTES).toString()

    val link = Link("demo", "demo", "WAYNE-PC", listOf("192.168.1.20", "100.101.12.7", "wayne-pc.tail1234.ts.net"), PairUri.DEFAULT_PORT, "0".repeat(64))

    private val projects = listOf(
        Project("starcut", "StarCut", true),
        Project("muster", "Muster", true),
        Project("wall-education", "wall-education", false),
    )

    private val items = mutableListOf(
        NeedItem(
            id = "starcut:review:T58", projectId = "starcut", projectName = "StarCut", kind = Kind.REVIEW, noteId = "N140", taskId = "T58",
            title = "S24 Empty/loading/first-use + S25 Performance", summary = "Captain: matches the artboards, 2076 tests pass",
            from = "captain", createdAt = ago(4), evidence = EvidenceRef("E2", 8, listOf("s24-empty.png", "s23-tabs.png", "s25-performance.png")),
            actions = listOf("approve", "open"),
        ),
        NeedItem(
            id = "starcut:review:T60", projectId = "starcut", projectName = "StarCut", kind = Kind.REVIEW, noteId = "N141", taskId = "T60",
            title = "S26 Post kit: rebuild to the S26 layout", summary = "Captain: layout matches, one spacing nit logged",
            from = "captain", createdAt = ago(12), actions = listOf("approve", "open"),
        ),
        NeedItem(
            id = "starcut:question:N142", projectId = "starcut", projectName = "StarCut", kind = Kind.QUESTION, noteId = "N142", taskId = "T4",
            title = "Should a revoked invite link show a friendly 'link expired' page or a plain 404?",
            summary = "Should a revoked invite link show a friendly 'link expired' page or a plain 404?",
            from = "captain", createdAt = ago(6), actions = listOf("answer", "open"),
        ),
        NeedItem(
            id = "starcut:blocked:N143", projectId = "starcut", projectName = "StarCut", kind = Kind.BLOCKED, noteId = "N143",
            title = "Merge blocked", summary = "15 uncommitted files on WAYNE-PC", from = "muster", createdAt = ago(2),
            actions = listOf("commit", "stash"),
        ),
        NeedItem(
            id = "muster:review:T212", projectId = "muster", projectName = "Muster", kind = Kind.REVIEW, noteId = "N388", taskId = "T212",
            title = "Phone gateway: pairing codes and QR", summary = "Captain: pairing flow works end to end, 41 new tests",
            from = "captain", createdAt = ago(18), actions = listOf("approve", "open"),
        ),
    )

    private var prefs = Prefs(projects = mapOf("starcut" to true, "muster" to true, "wall-education" to false))
    private var paused = false

    override suspend fun needs(): NeedsResponse {
        delay(250)
        return NeedsResponse("WAYNE-PC", projects, items.toList())
    }

    override suspend fun task(pid: String, tid: String): TaskDetail {
        delay(150)
        return when (tid) {
            "T58" -> TaskDetail(
                TaskInfo(
                    "T58", "S24 Empty/loading/first-use + S25 Performance: rebuild to the artboards",
                    "design/s24-empty-loading-first-use-s25-performa-2", "ready_for_merge", listOf("design", "review"),
                    kotlinx.serialization.json.JsonPrimitive("iris"), "9f3c2e1",
                ),
                ReviewNote(
                    "captain",
                    "Passed.\n- S24 empty state matches the artboard\n- S25 performance tiles use the VRAM bar\n" +
                        "- `tsc clean · 118 files, 2076 tests passed`\n- Minor: chip spacing 2px off in S25, logged as T63",
                    ago(4),
                ),
                listOf(
                    EvidenceSet("E1", "First pass", listOf(EvidenceFile("s24-first.png", "image"))),
                    EvidenceSet(
                        "E2", "Screens after the rebuild",
                        listOf(
                            EvidenceFile("s24-empty.png", "image"), EvidenceFile("s25-performance.png", "image"),
                            EvidenceFile("s24-loading.png", "image"), EvidenceFile("s24-first-use.png", "image"),
                            EvidenceFile("s25-vram.png", "image"), EvidenceFile("s25-tiles.png", "image"),
                            EvidenceFile("tests.txt", "text"), EvidenceFile("tsc.txt", "text"),
                        ),
                    ),
                ),
                DiffStat(412, 97, 14),
            )
            "T4" -> TaskDetail(TaskInfo("T4", "Share dialog UI", "crew/t4-share-dialog-ui", "in_progress", listOf("build", "review")))
            else -> {
                val item = items.firstOrNull { it.taskId == tid }
                TaskDetail(
                    TaskInfo(tid, item?.title ?: tid, "design/${tid.lowercase()}", "ready_for_merge", listOf("design", "review"), kotlinx.serialization.json.JsonPrimitive("iris")),
                    ReviewNote("captain", "Passed.\n- Layout matches the artboard\n- Minor: one spacing nit, logged", ago(12)),
                    emptyList(),
                    DiffStat(88, 21, 5),
                )
            }
        }
    }

    override suspend fun evidenceFile(pid: String, tid: String, eid: String, file: String): ByteArray? = null
    override suspend fun fetchPath(path: String): ByteArray? = null

    override suspend fun approve(pid: String, tid: String) {
        delay(400)
        items.removeAll { it.projectId == pid && it.taskId == tid && it.isReview }
    }

    override suspend fun sendBack(pid: String, tid: String, text: String) = approve(pid, tid)

    override suspend fun note(pid: String, nid: String): Note {
        delay(150)
        val item = items.firstOrNull { it.noteId == nid }
        return if (nid == "N142") {
            Note(
                "N142", "question", "captain", taskId = "T4",
                text = "Should a revoked invite link show a friendly 'link expired' page or a plain 404? bea needs this for T4.",
                createdAt = ago(6), replies = listOf(NoteReply(ago(4), "bea", "I'd go with a friendly page; I can reuse the S16 system-state layout.")),
            )
        } else {
            Note(nid, item?.kind ?: "question", item?.from ?: "captain", text = item?.summary ?: "", createdAt = item?.createdAt ?: ago(1))
        }
    }

    override suspend fun reply(pid: String, nid: String, text: String) {
        delay(400)
        items.removeAll { it.noteId == nid && it.isQuestion }
    }

    override suspend fun commit(pid: String) {
        delay(400)
        items.removeAll { it.projectId == pid && it.kind == Kind.BLOCKED }
    }

    override suspend fun stash(pid: String) = commit(pid)

    override suspend fun crew(pid: String): CrewResponse {
        delay(150)
        val monday = Instant.now().atZone(ZoneId.systemDefault()).with(TemporalAdjusters.next(DayOfWeek.MONDAY))
            .withHour(9).withMinute(0).toInstant().toString()
        return CrewResponse(
            listOf(
                CrewAgent("captain", "captain", "working", "T58", "main", "S24 Empty/loading/first-use + S25 Performance"),
                CrewAgent("bea", "crew", "stuck", "T4", "crew/t4-share-dialog-ui", "Share dialog UI"),
                CrewAgent("iris", "crew", "working", "T63", "crew/t63-screens-polish", "Screens polish"),
                CrewAgent("faye", "crew", "working", "T64", "crew/t64-fix-chip-leak", "Fix chip leak"),
                CrewAgent("design", "design", "working", "T60", "design/s26-post-kit-rebuild", "S26 Post kit: rebuild to the S26 layout"),
                CrewAgent("gus", "crew", "idle", null, null, ""),
            ),
            Usage(UsageWindow(23.0, ahead(130)), UsageWindow(41.0, monday)),
            paused,
        )
    }

    override suspend fun setPaused(pid: String, paused: Boolean) {
        delay(300)
        this.paused = paused
    }

    override suspend fun prefs(): Prefs = prefs
    override suspend fun putPrefs(prefs: Prefs): Prefs {
        this.prefs = prefs
        return prefs
    }

    override suspend fun unlink() {}
}

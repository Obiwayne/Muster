package com.obiwayne.muster.data

import kotlinx.coroutines.delay
import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.time.temporal.TemporalAdjusters

/**
 * Debug-only sample data that mirrors the Vellum designs (M03–M14), so the UI can be checked without a PC.
 * [held] picks the held remote writes to show (`goal`, `reply`, `answer`, `overdue`: M10–M12 and a card past its 15
 * minutes, still held; `expired` is an old name for `overdue`);
 * [holdOff] turns the server-side hold off (M13/M14 banner); [sendFails] makes Send answer 409 (the failed state).
 */
class DemoBackend(
    private val held: Set<String> = emptySet(),
    private val holdOff: Boolean = false,
    private val sendFails: Boolean = false,
) : Backend {
    override val isDemo = true

    private fun ago(minutes: Long) = Instant.now().minus(minutes, ChronoUnit.MINUTES).toString()
    private fun ahead(minutes: Long) = Instant.now().plus(minutes, ChronoUnit.MINUTES).toString()
    private fun agoSec(seconds: Long) = Instant.now().minusSeconds(seconds)

    val link = Link("demo", "demo", "WAYNE-PC", listOf("192.168.1.20", "100.101.12.7", "wayne-pc.tail1234.ts.net"), PairUri.DEFAULT_PORT, "0".repeat(64))

    private val projects = listOf(
        Project("starcut", "StarCut", true),
        Project("muster", "Muster", true),
        Project("wall-education", "wall-education", false),
    )

    /** The Captain's two-question ask (ASK.md), on note N144. */
    private val artAsk = listOf(
        AskQuestion(
            "Art model",
            "Juno ran your clip with Art on Opus and on Sonnet. Both passed QA and looked nearly the same. Sonnet's Art runs " +
                "cost about a fifth as much, but when asked for bigger captions (which StarCut can't do yet), Opus said so " +
                "honestly while Sonnet logged 'large size' and changed nothing. Which model should Art use?",
            false,
            listOf(
                AskOption(
                    "Sonnet + honesty check (Recommended)",
                    "Run Art on Sonnet and have QA flag any request it logged but didn't carry out. Keeps most of the savings.",
                ),
                AskOption("Keep Opus", "Stay on Opus. About five times the cost, but it says plainly when it can't do something."),
                AskOption("Switch to Sonnet", "Sonnet as is. Cheapest, but it may quietly skip requests StarCut can't do yet."),
            ),
        ),
        AskQuestion(
            "Caption size",
            "StarCut can't make captions bigger yet. What should happen when you ask for it?",
            false,
            listOf(
                AskOption("Add a size setting (Recommended)", "Small, medium and large captions, so the request just works. About a day of work."),
                AskOption("Say it's not supported", "Art tells you it can't change the size and leaves the captions as they are."),
                AskOption("Leave it for now", "No change. Revisit when captions get their next update."),
            ),
        ),
    )

    /** Notes answered in this demo session. */
    private val answered = mutableMapOf<String, Note>()

    private val items = mutableListOf(
        NeedItem(
            id = "starcut:N144", projectId = "starcut", projectName = "StarCut", kind = Kind.ESCALATION, noteId = "N144",
            title = "The Captain asks you", summary = artAsk[0].question, from = "captain", createdAt = ago(1),
            actions = listOf("answer", "open"), ask = artAsk,
        ),
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
            id = "starcut:N145", projectId = "starcut", projectName = "StarCut", kind = Kind.APPROVAL, noteId = "N145",
            title = "Roadmap needs your approval", summary = "Captain drafted stages M1–M4 for StarCut. Approve to start goal G1.",
            from = "captain", createdAt = ago(3), actions = listOf("open"),
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

    /** The Captain's three questions on N15, answered by the held P11. */
    private val exportAsk = listOf(
        AskQuestion(
            "Export formats", "Export formats: which should the Export dialog offer?", true,
            listOf(AskOption("MP4 (H.264)"), AskOption("WebM"), AskOption("MOV (ProRes)")),
        ),
        AskQuestion("Resolution", "Default resolution for a new export?", false, listOf(AskOption("720p"), AskOption("1080p"), AskOption("4K"))),
        AskQuestion("Anything else", "Anything else the crew should know before building the presets?", false, listOf(AskOption("No, go ahead"))),
    )

    private fun heldItem(
        id: String, kind: String, ageSec: Long, title: String, noteId: String? = null, text: String? = null,
        answers: List<AnswerChoice> = emptyList(), replyTo: RemoteReplyTo? = null,
    ): NeedItem {
        val created = agoSec(ageSec)
        val remote = RemoteWrite(
            pendingId = id, kind = kind, projectName = "StarCut", client = "Claude", text = text, answers = answers,
            replyTo = replyTo, createdAt = created.toString(), expiresAt = created.plus(15, ChronoUnit.MINUTES).toString(),
            digest = (id + kind + (text ?: "") + answers).hashCode().toUInt().toString(16).padStart(8, '0').repeat(8),
        )
        val summary = text ?: answers.joinToString(" | ") { (it.choices + listOfNotNull(it.other)).joinToString(", ") }
        return NeedItem(
            id = "starcut:$id", projectId = "starcut", projectName = "StarCut", kind = Kind.REMOTE_WRITE, noteId = noteId,
            title = title, summary = summary.replace(Regex("\\s+"), " ").take(140), from = "Claude", createdAt = remote.createdAt,
            actions = listOf("send", "discard"), remote = remote,
        )
    }

    init {
        val extra = mutableListOf<NeedItem>()
        if ("goal" in held) {
            extra += heldItem(
                "P7", WriteKind.GOAL, 2 * 60 + 19, "Claude wants to set a goal",
                text = "Add an export preset for YouTube Shorts: 1080×1920, 30 fps, H.264 at 12 Mbps, AAC 192k. Put it at the top of " +
                    "the preset list on the Export dialog and make it the default when the timeline is vertical.\n\n" +
                    "Keep the existing presets as they are. Add a test that a vertical timeline opens the dialog with Shorts selected.",
            )
        }
        if ("reply" in held) {
            extra += heldItem(
                "P8", WriteKind.REPLY, 12 * 60 + 42, "Claude wants to reply on N12", noteId = "N12",
                text = "Go with 7 days, and show the friendly 'link expired' page with a button to ask for a new link.",
                replyTo = RemoteReplyTo(
                    "N12", "ada", "question",
                    "Should invite links expire after 7 days or 30? And should a revoked link show a friendly 'link expired' page or a plain 404?",
                ),
            )
        }
        if ("answer" in held) {
            extra += heldItem(
                "P11", WriteKind.ANSWER, 4 * 60 + 8, "Claude wants to answer N15", noteId = "N15",
                answers = listOf(
                    AnswerChoice(listOf("MP4 (H.264)", "WebM")),
                    AnswerChoice(listOf("1080p")),
                    AnswerChoice(
                        emptyList(),
                        "Yes, a few things. Name the presets after where the video goes, not the codec: \"YouTube\", \"YouTube Shorts\", " +
                            "\"Instagram Reel\", \"Archive\". Archive is the only one that keeps the original frame rate and uses a high " +
                            "bitrate; the others cap at 30 fps.\n\n" +
                            "Keep the last preset the user picked per project, not globally, because I switch between a landscape channel " +
                            "and a Shorts channel all day.\n\n" +
                            "When a preset can't be met (say the source is 720p and the preset is 1080p), export at the source size and say " +
                            "so in the export log rather than upscaling quietly.\n\n" +
                            "Last thing: put the file size estimate next to each preset, even if it's rough. That's what I look at first.",
                    ),
                ),
                replyTo = RemoteReplyTo(
                    "N15", "captain", "escalation", exportAsk.joinToString("\n\n") { it.question },
                    exportAsk.map { q -> RemoteQuestion(q.header, q.question, q.multiSelect, q.options.map { it.label }) },
                ),
            )
        }
        if ("overdue" in held || "expired" in held) {
            extra += heldItem(
                "P6", WriteKind.REPLY, 15 * 60 + 40, "Claude wants to reply on N12", noteId = "N12",
                text = "Go with 30 days, and a plain 404 is fine for revoked links.",
                replyTo = RemoteReplyTo("N12", "ada", "question", "Should invite links expire after 7 days or 30? And should a revoked link show a friendly 'link expired' page or a plain 404?"),
            )
        }
        items.addAll(0, extra)
    }

    private val hold: HoldInfo = if (holdOff) {
        val since = Instant.now().atZone(ZoneId.systemDefault()).withHour(14).withMinute(40).withSecond(0).withNano(0)
            .let { if (it.toInstant().isAfter(Instant.now())) it.minusDays(1) else it }
        HoldInfo(on = false, offSince = since.toInstant().toString(), sentWithoutTap = 3)
    } else {
        HoldInfo(on = true)
    }

    private var prefs = Prefs(projects = mapOf("starcut" to true, "muster" to true, "wall-education" to false))
    private var paused = false

    override suspend fun needs(): NeedsResponse {
        delay(250)
        return NeedsResponse("WAYNE-PC", projects, items.toList(), hold)
    }

    override suspend fun sendPending(pid: String, pendingId: String, digest: String): String {
        delay(500)
        val item = items.firstOrNull { it.projectId == pid && it.remote?.pendingId == pendingId } ?: throw ApiException(404, "$pendingId is gone")
        val r = item.remote!!
        if (digest != r.digest) throw ApiException(409, "$pendingId is not what your screen showed; reload and check it again. Nothing was sent.")
        if (sendFails) {
            throw ApiException(409, "StarCut's Captain isn't running (Muster said: captain is not running). It's still held, unchanged. Start the Captain and try again, or discard it.")
        }
        items.remove(item)
        return when (r.kind) {
            WriteKind.GOAL -> "Goal sent to the Captain"
            WriteKind.REPLY -> "Reply sent on ${r.replyTo?.id ?: item.noteId}"
            WriteKind.ANSWER -> "Answers sent on ${item.noteId}"
            else -> "Sent"
        }
    }

    override suspend fun discardPending(pid: String, pendingId: String) {
        delay(300)
        if (!items.removeAll { it.projectId == pid && it.remote?.pendingId == pendingId }) throw ApiException(404, "$pendingId is gone")
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
        answered[nid]?.let { return it }
        val item = items.firstOrNull { it.noteId == nid }
        return if (nid == "N144") {
            Note(
                "N144", Kind.ESCALATION, "captain", to = "you", text = artAsk.joinToString("\n\n") { it.question },
                createdAt = ago(1), ask = artAsk,
            )
        } else if (nid == "N15") {
            Note("N15", Kind.ESCALATION, "captain", to = "you", text = exportAsk.joinToString("\n\n") { it.question }, createdAt = ago(20), ask = exportAsk)
        } else if (nid == "N12") {
            Note(
                "N12", "question", "ada", to = "you",
                text = "Should invite links expire after 7 days or 30? And should a revoked link show a friendly 'link expired' page or a plain 404?",
                createdAt = ago(25),
            )
        } else if (nid == "N142") {
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

    override suspend fun answer(pid: String, nid: String, answers: List<AnswerChoice>): Note {
        delay(400)
        val n = note(pid, nid)
        if (!n.open) throw ApiException(409, "This question was already answered")
        val stored = n.ask.mapIndexed { i, q ->
            val a = answers.getOrNull(i) ?: AnswerChoice()
            AskAnswer(q.header, a.choices, a.other?.trim()?.ifEmpty { null })
        }
        val reply = NoteReply(Instant.now().toString(), "you", AskText.replyText(stored))
        answered[nid] = n.copy(open = false, answers = stored, replies = n.replies + reply)
        items.removeAll { it.noteId == nid }
        return answered.getValue(nid)
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
            CrewRoadmap(
                62.0,
                RoadmapGoalRef("G9", "Empty, loading and first-use states"),
                RoadmapStatusLine("M4 Polish is 62%: G8 screens polish merged, G9 empty states is next. Launch on 15 Nov still holds.", ago(9)),
            ),
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

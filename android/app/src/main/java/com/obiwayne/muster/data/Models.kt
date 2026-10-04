package com.obiwayne.muster.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Lenient JSON: the gateway may add fields; missing optional ones fall back to defaults. */
val MusterJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    isLenient = true
    encodeDefaults = true
}

@Serializable
data class Project(val id: String, val name: String = id, val running: Boolean = false)

@Serializable
data class EvidenceRef(val id: String, val files: Int = 0, val thumbs: List<String> = emptyList())

/** One "needs you" item (PHONE.md, GET /api/needs). */
@Serializable
data class NeedItem(
    val id: String,
    val projectId: String,
    val projectName: String = "",
    val kind: String,
    val noteId: String? = null,
    val taskId: String? = null,
    val title: String = "",
    val summary: String = "",
    val from: String = "",
    val createdAt: String = "",
    val evidence: EvidenceRef? = null,
    val actions: List<String> = emptyList(),
    /** Set on escalation items made from a Captain question (ASK.md). */
    val ask: List<AskQuestion> = emptyList(),
) {
    val isReview get() = kind == Kind.REVIEW || kind == Kind.APPROVAL
    val isQuestion get() = kind == Kind.QUESTION || kind == Kind.ESCALATION
    val canApprove get() = "approve" in actions && taskId != null
}

object Kind {
    const val REVIEW = "review"
    const val APPROVAL = "approval"
    const val QUESTION = "question"
    const val ESCALATION = "escalation"
    const val BLOCKED = "blocked"
    const val USAGE = "usage"
    const val STUCK = "stuck"
}

@Serializable
data class NeedsResponse(
    val pcName: String = "",
    val projects: List<Project> = emptyList(),
    val items: List<NeedItem> = emptyList(),
)

@Serializable
data class TaskInfo(
    val id: String,
    val title: String = "",
    val branch: String? = null,
    val status: String = "",
    val stations: List<String> = emptyList(),
    val builder: JsonElement? = null,
    val reviewedSha: String? = null,
) {
    /** `builder` is an agent id in practice; tolerate an object with an `id`. */
    val builderName: String?
        get() = when (val b = builder) {
            is JsonPrimitive -> b.contentOrNull
            is JsonObject -> b["id"]?.jsonPrimitive?.contentOrNull
            else -> null
        }
}

@Serializable
data class ReviewNote(val from: String = "captain", val text: String = "", val at: String = "")

@Serializable
data class EvidenceFile(val name: String, val kind: String = "other")

@Serializable
data class EvidenceSet(val id: String, val summary: String = "", val files: List<EvidenceFile> = emptyList())

@Serializable
data class DiffStat(val added: Int = 0, val removed: Int = 0, val files: Int = 0)

@Serializable
data class TaskDetail(
    val task: TaskInfo,
    val review: ReviewNote? = null,
    val evidence: List<EvidenceSet> = emptyList(),
    val diffStat: DiffStat? = null,
)

@Serializable
data class NoteReply(val at: String = "", val from: String = "", val text: String = "")

@Serializable
data class Note(
    val id: String,
    val type: String = "",
    val from: String = "",
    val to: String? = null,
    val taskId: String? = null,
    val text: String = "",
    val createdAt: String = "",
    val open: Boolean = true,
    val topic: String? = null,
    val replies: List<NoteReply> = emptyList(),
    /** Optional quick answers, if the gateway ever provides them. */
    val options: List<String> = emptyList(),
    /** The Captain's multiple-choice questions (ASK.md), when the note came from `POST /api/ask`. */
    val ask: List<AskQuestion> = emptyList(),
    /** Set once the questions were answered. */
    val answers: List<AskAnswer> = emptyList(),
)

@Serializable
data class AskOption(val label: String, val description: String? = null) {
    /** The label without a trailing "(Recommended)", which shows as a tag instead. */
    val shownLabel get() = label.trimEnd().removeSuffix(RECOMMENDED).trimEnd().ifEmpty { label }
    val recommended get() = label.trimEnd().endsWith(RECOMMENDED)
}

private const val RECOMMENDED = "(Recommended)"

@Serializable
data class AskQuestion(
    val header: String = "",
    val question: String = "",
    val multiSelect: Boolean = false,
    val options: List<AskOption> = emptyList(),
)

@Serializable
data class AskAnswer(val header: String = "", val choices: List<String> = emptyList(), val other: String? = null)

object AskText {
    /** The orchestrator's reply line per question (ASK.md): `<header or Qn>: <choices>` plus ` (note: <other>)`. */
    fun replyText(answers: List<AskAnswer>): String = answers.mapIndexed { i, a ->
        val head = a.header.ifBlank { "Q${i + 1}" }
        val other = a.other?.trim().orEmpty()
        val body = when {
            a.choices.isEmpty() -> other
            other.isEmpty() -> a.choices.joinToString(", ")
            else -> a.choices.joinToString(", ") + " (note: $other)"
        }
        "$head: $body"
    }.joinToString("\n")

    /** Notification text: each question and its option labels. */
    fun summary(ask: List<AskQuestion>): String = ask.joinToString("\n\n") { q ->
        q.question + "\n" + q.options.joinToString(" · ") { it.shownLabel }
    }
}

/** One answer per question, by index (`POST .../notes/:nid/answer`). */
@Serializable
data class AnswerChoice(val choices: List<String> = emptyList(), val other: String? = null)

@Serializable
data class AnswerBody(val answers: List<AnswerChoice>)

@Serializable
data class CrewAgent(
    val id: String,
    val role: String = "crew",
    val status: String = "idle",
    val taskId: String? = null,
    val branch: String? = null,
    val detail: String? = null,
)

@Serializable
data class UsageWindow(val pct: Double = 0.0, val resetsAt: String? = null)

@Serializable
data class Usage(val fiveHour: UsageWindow? = null, val weekly: UsageWindow? = null)

@Serializable
data class RoadmapGoalRef(val id: String, val title: String = "")

@Serializable
data class RoadmapStatusLine(val text: String, val at: String = "")

/** "Where we are" on the Crew tab: overall %, the current goal, the Captain's last roadmap_status line. */
@Serializable
data class CrewRoadmap(val pct: Double? = null, val current: RoadmapGoalRef? = null, val status: RoadmapStatusLine? = null)

@Serializable
data class CrewResponse(
    val agents: List<CrewAgent> = emptyList(),
    val usage: Usage? = null,
    val paused: Boolean = false,
    val roadmap: CrewRoadmap? = null, // null: the project has no roadmap
)

@Serializable
data class NotifyPrefs(
    val review: Boolean = true,
    val question: Boolean = true,
    val blocked: Boolean = true,
    val usage: Boolean = false,
    val stuck: Boolean = false,
)

@Serializable
data class QuietPrefs(val on: Boolean = true, val from: String = "22:00", val to: String = "07:00")

@Serializable
data class Prefs(
    val notify: NotifyPrefs = NotifyPrefs(),
    val quiet: QuietPrefs = QuietPrefs(),
    val projects: Map<String, Boolean> = emptyMap(),
)

@Serializable
data class PairRequest(val code: String, val deviceName: String)

@Serializable
data class PairResponse(val deviceId: String, val key: String, val pcName: String = "", val hosts: List<String> = emptyList())

@Serializable
data class TextBody(val text: String)

@Serializable
data class ErrorBody(val error: String = "")

/** Messages on GET /api/events. */
sealed interface ServerEvent {
    data class Need(val item: NeedItem) : ServerEvent
    data class Resolved(val id: String) : ServerEvent
    data object Ping : ServerEvent
    data object Test : ServerEvent
    data class Unknown(val type: String) : ServerEvent
}

object Parse {
    fun needs(json: String): NeedsResponse = MusterJson.decodeFromString(NeedsResponse.serializer(), json)

    fun task(json: String): TaskDetail = MusterJson.decodeFromString(TaskDetail.serializer(), json)

    /** The note endpoint may answer `{ note: {...} }` or the bare note. */
    fun note(json: String): Note {
        val el = MusterJson.parseToJsonElement(json).jsonObject
        val obj = (el["note"] as? JsonObject) ?: el
        return MusterJson.decodeFromJsonElement(Note.serializer(), obj)
    }

    fun crew(json: String): CrewResponse = MusterJson.decodeFromString(CrewResponse.serializer(), json)

    fun prefs(json: String): Prefs {
        val el = MusterJson.parseToJsonElement(json).jsonObject
        val obj = (el["prefs"] as? JsonObject) ?: el
        return MusterJson.decodeFromJsonElement(Prefs.serializer(), obj)
    }

    fun pair(json: String): PairResponse = MusterJson.decodeFromString(PairResponse.serializer(), json)

    fun error(json: String?): String? = try {
        json?.let { MusterJson.decodeFromString(ErrorBody.serializer(), it).error.ifBlank { null } }
    } catch (_: Exception) {
        null
    }

    fun event(text: String): ServerEvent? = try {
        val obj = MusterJson.parseToJsonElement(text).jsonObject
        when (val type = obj["type"]?.jsonPrimitive?.contentOrNull) {
            "need" -> obj["item"]?.let { ServerEvent.Need(MusterJson.decodeFromJsonElement(NeedItem.serializer(), it)) }
            "resolved" -> obj["id"]?.jsonPrimitive?.contentOrNull?.let { ServerEvent.Resolved(it) }
            "ping" -> ServerEvent.Ping
            "test" -> ServerEvent.Test
            null -> null
            else -> ServerEvent.Unknown(type)
        }
    } catch (_: Exception) {
        null
    }
}

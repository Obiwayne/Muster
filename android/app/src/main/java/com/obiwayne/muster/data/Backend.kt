package com.obiwayne.muster.data

/** What the screens need from the PC. [RemoteBackend] talks to the gateway; [DemoBackend] is the debug demo. */
interface Backend {
    val isDemo: Boolean
    suspend fun needs(): NeedsResponse
    suspend fun task(pid: String, tid: String): TaskDetail
    suspend fun evidenceFile(pid: String, tid: String, eid: String, file: String): ByteArray?

    /** A gateway path such as a NeedItem thumb (`/api/projects/:pid/tasks/:tid/evidence/:eid/:file`). */
    suspend fun fetchPath(path: String): ByteArray?
    suspend fun approve(pid: String, tid: String)
    suspend fun sendBack(pid: String, tid: String, text: String)
    suspend fun note(pid: String, nid: String): Note
    suspend fun reply(pid: String, nid: String, text: String)

    /** Answers a Captain question note (ASK.md); returns the closed note. */
    suspend fun answer(pid: String, nid: String, answers: List<AnswerChoice>): Note
    suspend fun commit(pid: String)
    suspend fun stash(pid: String)

    /**
     * Sends a held remote write (`POST /api/projects/:pid/pending/:id/send` with the card's digest, unchanged). Returns
     * the gateway's summary. 409 = not what the card showed, or the send failed (still held); 404 = gone (expired).
     */
    suspend fun sendPending(pid: String, pendingId: String, digest: String): String

    /** Drops a held remote write. 404 = already gone. */
    suspend fun discardPending(pid: String, pendingId: String)
    suspend fun crew(pid: String): CrewResponse
    suspend fun setPaused(pid: String, paused: Boolean)
    suspend fun prefs(): Prefs
    suspend fun putPrefs(prefs: Prefs): Prefs
    suspend fun unlink()
}

class RemoteBackend(val api: Api) : Backend {
    override val isDemo = false
    private fun body(text: String) = MusterJson.encodeToString(TextBody.serializer(), TextBody(text))

    override suspend fun needs() = Parse.needs(String(api.get("api", "needs")))
    override suspend fun task(pid: String, tid: String) = Parse.task(String(api.get("api", "projects", pid, "tasks", tid)))
    override suspend fun evidenceFile(pid: String, tid: String, eid: String, file: String): ByteArray =
        api.get("api", "projects", pid, "tasks", tid, "evidence", eid, file)

    override suspend fun fetchPath(path: String): ByteArray {
        val segs = path.substringBefore('?').split('/').filter { it.isNotEmpty() }.map { java.net.URLDecoder.decode(it, "UTF-8") }
        return api.call("GET", segs, null)
    }

    override suspend fun approve(pid: String, tid: String) {
        api.post("api", "projects", pid, "tasks", tid, "approve")
    }

    override suspend fun sendBack(pid: String, tid: String, text: String) {
        api.post("api", "projects", pid, "tasks", tid, "send-back", json = body(text))
    }

    override suspend fun note(pid: String, nid: String) = Parse.note(String(api.get("api", "projects", pid, "notes", nid)))
    override suspend fun reply(pid: String, nid: String, text: String) {
        api.post("api", "projects", pid, "notes", nid, "reply", json = body(text))
    }

    override suspend fun answer(pid: String, nid: String, answers: List<AnswerChoice>): Note {
        val json = MusterJson.encodeToString(AnswerBody.serializer(), AnswerBody(answers))
        return Parse.note(String(api.post("api", "projects", pid, "notes", nid, "answer", json = json)))
    }

    override suspend fun commit(pid: String) {
        api.post("api", "projects", pid, "checkout", "commit")
    }

    override suspend fun stash(pid: String) {
        api.post("api", "projects", pid, "checkout", "stash")
    }

    override suspend fun sendPending(pid: String, pendingId: String, digest: String): String {
        val out = api.post("api", "projects", pid, "pending", pendingId, "send", json = Parse.digestBody(digest))
        return runCatching { Parse.sendResult(String(out)).summary }.getOrDefault("")
    }

    override suspend fun discardPending(pid: String, pendingId: String) {
        api.post("api", "projects", pid, "pending", pendingId, "discard")
    }

    override suspend fun crew(pid: String) = Parse.crew(String(api.get("api", "projects", pid, "crew")))

    /** Not in PHONE.md: assumed `POST /api/projects/:pid/pause` and `/resume`. */
    override suspend fun setPaused(pid: String, paused: Boolean) {
        api.post("api", "projects", pid, if (paused) "pause" else "resume")
    }

    override suspend fun prefs() = Parse.prefs(String(api.get("api", "prefs")))
    override suspend fun putPrefs(prefs: Prefs): Prefs {
        val out = api.put("api", "prefs", json = MusterJson.encodeToString(Prefs.serializer(), prefs))
        return runCatching { Parse.prefs(String(out)) }.getOrDefault(prefs)
    }

    override suspend fun unlink() {
        api.delete("api", "device")
    }
}

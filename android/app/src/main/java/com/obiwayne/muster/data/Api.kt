package com.obiwayne.muster.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext

/** 401 from the gateway: this phone was unlinked (here or on the PC). */
class UnlinkedException : IOException("This phone is no longer linked")

/** The gateway answered with an error. */
class ApiException(val code: Int, message: String) : IOException(message)

/** None of the PC's addresses answered. */
class OfflineException(val pcName: String, cause: Throwable?) : IOException("Can't reach $pcName", cause)

object Http {
    private val JSON = "application/json; charset=utf-8".toMediaType()

    fun client(tm: PinnedTrustManager, verifier: HostnameVerifier): OkHttpClient {
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), SecureRandom()) }
        return OkHttpClient.Builder()
            .sslSocketFactory(ssl.socketFactory, tm)
            .hostnameVerifier(verifier)
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .pingInterval(30, TimeUnit.SECONDS) // WebSocket keepalive; a missing pong fails the socket
            .build()
    }

    fun url(host: String, port: Int, segments: List<String>, scheme: String = "https"): HttpUrl =
        HttpUrl.Builder().scheme(scheme).host(host).port(port).apply { segments.forEach { addPathSegment(it) } }.build()

    fun body(json: String?) = (json ?: "").toRequestBody(JSON)
}

/** Pairing calls, made before there is a key. */
object Pairing {
    /** Connects once without trusting anything, to read the certificate fingerprint for the manual-entry check. */
    suspend fun probeFingerprint(host: String, port: Int): String = withContext(Dispatchers.IO) {
        val tm = PinnedTrustManager(null)
        val client = Http.client(tm) { _, _ -> false }
        try {
            client.newCall(Request.Builder().url(Http.url(host, port, listOf("api", "health"))).build()).execute().close()
        } catch (_: IOException) {
            // expected: the handshake is refused once the certificate has been seen
        }
        tm.seen ?: throw OfflineException(host, null)
    }

    /** POST /pair on each host in order, pinning [PairInfo.fingerprint]. */
    suspend fun pair(info: PairInfo, deviceName: String): Pair<Link, String> = withContext(Dispatchers.IO) {
        val fp = info.fingerprint ?: throw IllegalStateException("No fingerprint to pin")
        val client = Http.client(PinnedTrustManager(fp), PinnedHostnameVerifier(fp))
        val body = MusterJson.encodeToString(PairRequest.serializer(), PairRequest(info.code, deviceName))
        var last: IOException? = null
        for (host in info.hosts) {
            val req = Request.Builder().url(Http.url(host, info.port, listOf("pair"))).post(Http.body(body)).build()
            try {
                client.newCall(req).execute().use { r ->
                    val text = r.body.string()
                    when {
                        r.code == 401 -> throw ApiException(401, Parse.error(text) ?: "That code is wrong or has expired. Make a new one on your PC.")
                        r.code == 429 -> throw ApiException(429, "Too many tries. Wait a minute, then scan a fresh code.")
                        !r.isSuccessful -> throw ApiException(r.code, Parse.error(text) ?: "The PC said no (HTTP ${r.code}).")
                    }
                    val res = Parse.pair(text)
                    val hosts = (res.hosts.ifEmpty { info.hosts }).distinct()
                    val link = Link(res.deviceId, res.key, res.pcName.ifBlank { info.pcName }, hosts, info.port, fp)
                    return@withContext link to host
                }
            } catch (e: ApiException) {
                throw e
            } catch (e: IOException) {
                last = e
            }
        }
        throw OfflineException(info.pcName, last)
    }
}

/** The phone API (PHONE.md) for one link. Tries the hosts in order, starting with the one that last worked. */
class Api(val link: Link, private val store: SecureStore) {
    private val tm = PinnedTrustManager(link.fingerprint)
    val client: OkHttpClient = Http.client(tm, PinnedHostnameVerifier(link.fingerprint))

    fun orderedHosts(): List<String> {
        val w = store.workingHost
        return if (w != null && w in link.hosts) listOf(w) + (link.hosts - w) else link.hosts
    }

    suspend fun get(vararg seg: String): ByteArray = call("GET", seg.toList(), null)
    suspend fun post(vararg seg: String, json: String? = null): ByteArray = call("POST", seg.toList(), json)
    suspend fun put(vararg seg: String, json: String): ByteArray = call("PUT", seg.toList(), json)
    suspend fun delete(vararg seg: String): ByteArray = call("DELETE", seg.toList(), null)

    suspend fun call(method: String, segments: List<String>, json: String?): ByteArray = withContext(Dispatchers.IO) {
        var last: IOException? = null
        for (host in orderedHosts()) {
            val body = if (method == "GET" || method == "DELETE") null else Http.body(json ?: "{}")
            val req = Request.Builder()
                .url(Http.url(host, link.port, segments))
                .header("Authorization", "Bearer ${link.key}")
                .method(method, body)
                .build()
            try {
                client.newCall(req).execute().use { r ->
                    if (r.code == 401) throw UnlinkedException()
                    val bytes = r.body.bytes()
                    if (!r.isSuccessful) throw ApiException(r.code, Parse.error(String(bytes)) ?: "HTTP ${r.code}")
                    if (store.workingHost != host) store.workingHost = host
                    return@withContext bytes
                }
            } catch (e: UnlinkedException) {
                throw e
            } catch (e: ApiException) {
                throw e
            } catch (e: IOException) {
                last = e
            }
        }
        throw OfflineException(link.pcName, last)
    }

    fun openEvents(host: String, listener: WebSocketListener): WebSocket {
        val url = Http.url(host, link.port, listOf("api", "events"))
        val req = Request.Builder().url(url).header("Authorization", "Bearer ${link.key}").build()
        return client.newWebSocket(req, listener)
    }
}

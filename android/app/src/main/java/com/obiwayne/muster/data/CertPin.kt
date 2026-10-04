package com.obiwayne.muster.data

import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLSession
import javax.net.ssl.X509TrustManager

/** SHA-256 fingerprint pinning of the gateway's self-signed certificate. */
object CertPin {
    fun sha256Hex(der: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }

    /** Lower-case hex only ("AB:CD:..." and "abcd..." both become "abcd..."). */
    fun normalize(fp: String): String = fp.lowercase().filter { it in '0'..'9' || it in 'a'..'f' }

    fun matches(der: ByteArray, pinned: String?): Boolean {
        val want = pinned?.let(::normalize) ?: return false
        if (want.length != 64) return false
        return MessageDigest.isEqual(sha256Hex(der).toByteArray(), want.toByteArray())
    }

    /** The first 8 hex characters, shown for the manual-entry check: "3F9A 21C0". */
    fun shortForm(fp: String): String = normalize(fp).take(8).uppercase().chunked(4).joinToString(" ")
}

/**
 * Accepts exactly one certificate: the leaf whose SHA-256 matches [pinned]. With [pinned] null it trusts nothing but
 * records the leaf it saw in [seen] (used once, to show the fingerprint for manual pairing).
 */
class PinnedTrustManager(private val pinned: String?) : X509TrustManager {
    @Volatile
    var seen: String? = null
        private set

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("No certificate")
        val der = leaf.encoded
        seen = CertPin.sha256Hex(der)
        if (!CertPin.matches(der, pinned)) throw CertificateException("Certificate does not match the paired PC")
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
        throw CertificateException("Client certificates are not used")

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/**
 * The certificate only names pcName/localhost/127.0.0.1 and the phone connects by IP or MagicDNS name, so normal
 * hostname verification is replaced by "the peer presented the pinned certificate", whatever host we dialled.
 */
class PinnedHostnameVerifier(private val pinned: String) : HostnameVerifier {
    override fun verify(hostname: String?, session: SSLSession?): Boolean {
        if (session == null) return false
        val leaf = try {
            session.peerCertificates.firstOrNull()
        } catch (_: Exception) {
            null
        } ?: return false
        return CertPin.matches(leaf.encoded, pinned)
    }
}

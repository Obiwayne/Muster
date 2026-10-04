package com.obiwayne.muster.data

import java.net.URLDecoder

/** What the pairing QR code carries (PHONE.md, "Pairing"). [fingerprint] is null for manual entry until confirmed. */
data class PairInfo(
    val code: String,
    val port: Int,
    val fingerprint: String?,
    val pcName: String,
    val hosts: List<String>,
)

object PairUri {
    const val DEFAULT_PORT = 47910
    const val CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    private const val PREFIX = "muster://pair?"

    /** "k7m-4qx" -> "K7M4QX"; null unless it is exactly 6 characters from the code alphabet. */
    fun normalizeCode(input: String): String? {
        val c = input.uppercase().filter { it.isLetterOrDigit() }
        return if (c.length == 6 && c.all { it in CODE_ALPHABET }) c else null
    }

    /** "K7M4QX" -> "K7M-4QX". */
    fun displayCode(code: String): String = if (code.length == 6) code.take(3) + "-" + code.drop(3) else code

    /** Parses `muster://pair?c=..&p=..&f=..&n=..&h=a,b`. Returns null for anything else or when a field is invalid. */
    fun parse(text: String): PairInfo? {
        val t = text.trim()
        if (!t.regionMatches(0, PREFIX, 0, PREFIX.length, ignoreCase = true)) return null
        val params = HashMap<String, String>()
        for (part in t.substring(PREFIX.length).split('&')) {
            if (part.isEmpty()) continue
            val eq = part.indexOf('=')
            val k = if (eq < 0) part else part.substring(0, eq)
            val v = if (eq < 0) "" else part.substring(eq + 1)
            params[decode(k)] = decode(v)
        }
        val code = normalizeCode(params["c"] ?: return null) ?: return null
        val port = params["p"]?.takeIf { it.isNotBlank() }?.let { it.toIntOrNull() ?: return null } ?: DEFAULT_PORT
        if (port !in 1..65535) return null
        val fp = CertPin.normalize(params["f"] ?: return null)
        if (fp.length != 64) return null
        val hosts = (params["h"] ?: "").split(',').map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        if (hosts.isEmpty()) return null
        val name = params["n"]?.trim().orEmpty().ifEmpty { "your PC" }
        return PairInfo(code, port, fp, name, hosts)
    }

    /** "192.168.1.20" or "192.168.1.20:47910" -> host and port, for manual entry. */
    fun parseAddress(input: String): Pair<String, Int>? {
        val s = input.trim().removePrefix("https://").removePrefix("http://").trimEnd('/')
        if (s.isEmpty() || s.any { it.isWhitespace() }) return null
        if (s.startsWith("[")) { // [ipv6]:port
            val end = s.indexOf(']')
            if (end < 0) return null
            val host = s.substring(1, end)
            val rest = s.substring(end + 1)
            val port = if (rest.startsWith(":")) rest.drop(1).toIntOrNull() ?: return null else DEFAULT_PORT
            return host to port
        }
        val colon = s.lastIndexOf(':')
        if (colon > 0 && s.count { it == ':' } == 1) {
            val port = s.substring(colon + 1).toIntOrNull() ?: return null
            if (port !in 1..65535) return null
            return s.substring(0, colon) to port
        }
        return s to DEFAULT_PORT
    }

    private fun decode(s: String) = try {
        URLDecoder.decode(s, "UTF-8")
    } catch (_: IllegalArgumentException) {
        s
    }
}

package com.obiwayne.muster.data

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Everything needed to talk to the paired PC. */
data class Link(
    val deviceId: String,
    val key: String,
    val pcName: String,
    val hosts: List<String>,
    val port: Int,
    val fingerprint: String,
)

/**
 * The link secrets live in EncryptedSharedPreferences (PHONE.md). Small non-secret bits (notified ids, cached prefs)
 * live in a plain prefs file.
 */
@Suppress("DEPRECATION") // security-crypto 1.1.0 deprecates the API but it is still the documented choice here.
class SecureStore(context: Context) {
    private val secure: SharedPreferences = run {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        try {
            open(context, key)
        } catch (_: Exception) {
            // A keystore reset (or restore onto a new device) leaves an unreadable file: start over.
            context.deleteSharedPreferences(SECURE_FILE)
            open(context, key)
        }
    }
    private val plain: SharedPreferences = context.getSharedPreferences("muster", Context.MODE_PRIVATE)

    private fun open(context: Context, key: MasterKey) = EncryptedSharedPreferences.create(
        context,
        SECURE_FILE,
        key,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun load(): Link? {
        val id = secure.getString("deviceId", null) ?: return null
        val key = secure.getString("key", null) ?: return null
        val fp = secure.getString("fingerprint", null) ?: return null
        val hosts = secure.getString("hosts", null)?.split(',')?.filter { it.isNotBlank() }.orEmpty()
        if (hosts.isEmpty()) return null
        return Link(id, key, secure.getString("pcName", null) ?: "your PC", hosts, secure.getInt("port", PairUri.DEFAULT_PORT), fp)
    }

    fun save(link: Link) = secure.edit(commit = true) {
        putString("deviceId", link.deviceId)
        putString("key", link.key)
        putString("pcName", link.pcName)
        putString("hosts", link.hosts.joinToString(","))
        putInt("port", link.port)
        putString("fingerprint", link.fingerprint)
    }

    var workingHost: String?
        get() = secure.getString("workingHost", null)
        set(v) = secure.edit { putString("workingHost", v) }

    var cachedPrefs: Prefs?
        get() = plain.getString("prefs", null)?.let { runCatching { Parse.prefs(it) }.getOrNull() }
        set(v) = plain.edit { putString("prefs", v?.let { MusterJson.encodeToString(Prefs.serializer(), it) }) }

    /** Item ids we already posted a notification for, so the WebSocket and the 15-minute poll don't repeat them. */
    var notifiedIds: Set<String>
        get() = plain.getStringSet("notified", emptySet()) ?: emptySet()
        set(v) = plain.edit { putStringSet("notified", v) }

    var lastSyncAt: Long
        get() = plain.getLong("lastSync", 0L)
        set(v) = plain.edit { putLong("lastSync", v) }

    fun clear() {
        secure.edit(commit = true) { clear() }
        plain.edit(commit = true) { clear() }
    }

    private companion object {
        const val SECURE_FILE = "muster_link"
    }
}

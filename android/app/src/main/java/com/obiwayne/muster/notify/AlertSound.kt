package com.obiwayne.muster.notify

import android.Manifest
import android.content.ContentResolver
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.media.RingtoneManager
import android.net.Uri
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File
import java.io.FileNotFoundException

/** How Muster alerts sound on this phone. [uri] null = the phone's default notification sound. */
data class AlertPrefs(val play: Boolean = true, val uri: Uri? = null, val vibrate: Boolean = true)

/**
 * Phone-local alert sound settings (M09 "Alert sound"). They are not gateway prefs and survive unlinking.
 *
 * Android fixes a channel's sound and vibration once it exists, so every change bumps [version]; [Notifier.createChannels]
 * then replaces the alert channels with new ids ending in `_v<version>`.
 */
object AlertSound {
    private const val FILE = "muster_sound"
    private const val K_PLAY = "play"
    private const val K_URI = "uri"
    private const val K_VIBRATE = "vibrate"
    private const val K_VERSION = "version"

    private val _prefs = MutableStateFlow(AlertPrefs())
    val prefs: StateFlow<AlertPrefs> = _prefs

    private fun file(ctx: Context): SharedPreferences = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun load(ctx: Context): AlertPrefs {
        val f = file(ctx)
        val p = AlertPrefs(
            play = f.getBoolean(K_PLAY, true),
            uri = f.getString(K_URI, null)?.let(Uri::parse),
            vibrate = f.getBoolean(K_VIBRATE, true),
        )
        _prefs.value = p
        return p
    }

    fun version(ctx: Context): Int = file(ctx).getInt(K_VERSION, 1)

    /** Saves [p] and moves to the next channel version. Returns false when nothing changed. */
    fun save(ctx: Context, p: AlertPrefs): Boolean {
        val f = file(ctx)
        if (p == load(ctx)) return false
        f.edit(commit = true) {
            putBoolean(K_PLAY, p.play)
            putString(K_URI, p.uri?.toString())
            putBoolean(K_VIBRATE, p.vibrate)
            putInt(K_VERSION, f.getInt(K_VERSION, 1) + 1)
        }
        _prefs.value = p
        return true
    }

    /** Saves [p] and rebuilds the alert channels so the next alert uses it. Call off the main thread. */
    fun update(ctx: Context, p: AlertPrefs) {
        if (save(ctx, p)) Notifier.createChannels(ctx)
    }

    /** The sound the alert channels play, or null for silent. */
    fun soundUri(p: AlertPrefs): Uri? = if (!p.play) null else p.uri ?: Settings.System.DEFAULT_NOTIFICATION_URI

    /** What the ringtone picker returns for "Default" maps to null, so the phone's default keeps following the phone. */
    fun normalize(uri: Uri?): Uri? = uri?.takeIf { it != Settings.System.DEFAULT_NOTIFICATION_URI }

    fun title(ctx: Context, p: AlertPrefs): String {
        val uri = p.uri ?: return "Phone default"
        return runCatching { RingtoneManager.getRingtone(ctx, uri)?.getTitle(ctx) }.getOrNull()?.takeIf { it.isNotBlank() } ?: "Custom sound"
    }

    /**
     * False when the chosen sound is gone (deleted file, removed media). When we can't tell, for example a shared audio
     * file this app has no permission to read but the system can still play, it counts as readable.
     */
    fun readable(ctx: Context, uri: Uri): Boolean = when (uri.scheme) {
        ContentResolver.SCHEME_FILE -> uri.path?.let { File(it).canRead() } ?: false
        ContentResolver.SCHEME_CONTENT -> {
            val external = uri.authority == "media" && uri.pathSegments.firstOrNull()?.startsWith("external") == true
            val canReadMedia = ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_MEDIA_AUDIO) == PackageManager.PERMISSION_GRANTED
            if (external && !canReadMedia) {
                true
            } else {
                try {
                    ctx.contentResolver.openAssetFileDescriptor(uri, "r")?.use { true } ?: false
                } catch (_: FileNotFoundException) {
                    false
                } catch (_: Exception) {
                    true
                }
            }
        }
        else -> true
    }
}

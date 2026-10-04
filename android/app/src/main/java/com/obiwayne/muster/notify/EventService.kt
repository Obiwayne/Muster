package com.obiwayne.muster.notify

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.obiwayne.muster.MusterApp
import com.obiwayne.muster.data.Parse
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/**
 * Foreground service (type remoteMessaging) that keeps GET /api/events open and reconnects with backoff
 * (1 s, 2 s, 4 s … capped at 60 s, with jitter). A network change skips the wait.
 */
class EventService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loop: Job? = null
    private var socket: WebSocket? = null
    private val kick = Channel<Unit>(Channel.CONFLATED)
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
        showForeground(false)
        val cm = getSystemService(ConnectivityManager::class.java)
        netCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                kick.trySend(Unit)
            }
        }.also { runCatching { cm.registerDefaultNetworkCallback(it) } }
    }

    private fun showForeground(connected: Boolean) {
        val state = MusterApp.state
        val n = Notifier.service(this, state.pcName, connected)
        try {
            ServiceCompat.startForeground(this, Notifier.SERVICE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        } catch (_: Exception) {
            getSystemService(NotificationManager::class.java).notify(Notifier.SERVICE_ID, n)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val state = MusterApp.state
        if (state.link.value == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (loop?.isActive != true) loop = scope.launch { run() }
        return START_STICKY
    }

    private suspend fun run() {
        val state = MusterApp.state
        var attempt = 0
        while (scope.isActive) {
            val api = state.api() ?: break
            var opened = false
            for (host in api.orderedHosts()) {
                val result = connectOnce(host) { opened = true; attempt = 0 }
                if (result == Outcome.UNLINKED) {
                    state.onUnlinked()
                    stopSelf()
                    return
                }
                if (opened) break // it was open, then dropped: go to backoff with attempt reset
            }
            state.wsConnected.value = false
            showForeground(false)
            val delayMs = if (opened) 1000L else (1000L shl attempt.coerceAtMost(6)).coerceAtMost(60_000L)
            attempt++
            withTimeoutOrNull(delayMs + Random.nextLong(0, 500)) { kick.receive() }
        }
    }

    private enum class Outcome { CLOSED, FAILED, UNLINKED }

    private suspend fun connectOnce(host: String, onOpen: () -> Unit): Outcome {
        val state = MusterApp.state
        val api = state.api() ?: return Outcome.FAILED
        val done = CompletableDeferred<Outcome>()
        val ctx = this
        socket = api.openEvents(host, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                onOpen()
                state.store.workingHost = host
                state.wsConnected.value = true
                showForeground(true)
                // Catch up on anything that arrived while we were away.
                scope.launch { NeedsSync.poll(ctx, state) }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                Parse.event(text)?.let { NeedsSync.onEvent(ctx, state, it) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                if (code == CLOSE_UNLINKED) done.complete(Outcome.UNLINKED)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                done.complete(if (code == CLOSE_UNLINKED) Outcome.UNLINKED else Outcome.CLOSED)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                done.complete(if (response?.code == 401) Outcome.UNLINKED else Outcome.FAILED)
            }
        })
        return done.await()
    }

    override fun onDestroy() {
        netCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        socket?.cancel()
        MusterApp.state.wsConnected.value = false
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        /** The gateway closes the socket with 4001 when this phone is unlinked (PHONE.md). */
        const val CLOSE_UNLINKED = 4001

        fun start(ctx: Context) {
            ContextCompat.startForegroundService(ctx, Intent(ctx, EventService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, EventService::class.java))
        }
    }
}

/** The 15-minute fallback: polls /api/needs in case the WebSocket was down. */
class PollWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val state = MusterApp.state
        if (state.link.value == null) return Result.success()
        NeedsSync.poll(applicationContext, state)
        return Result.success()
    }

    companion object {
        const val NAME = "muster-needs-poll"

        fun schedule(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<PollWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, req)
        }
    }
}

package com.obiwayne.muster

import android.app.Application
import com.obiwayne.muster.notify.Notifier

class MusterApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
        state = AppState(this).also { it.init() }
        Notifier.createChannels(this)
    }

    companion object {
        lateinit var instance: MusterApp
            private set
        lateinit var state: AppState
            private set
    }
}

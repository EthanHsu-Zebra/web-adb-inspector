package io.ethan.webadb.attestation;

import android.app.Application;
import android.util.Log;

/**
 * The earliest, most reliable point to run user-space Java code on Android.
 * Application.onCreate is called by the framework during process startup,
 * before any Activity, Service, or ContentProvider user code runs. It
 * cannot be silently dropped by background-app restrictions the way
 * Activity launches can, and unlike a cold ContentProvider it does not
 * need any external intent to be delivered.
 *
 * We do not run the full probe here because the application context is
 * not fully ready when some Android versions call this. Instead we just
 * touch the output file as an unmistakable signal that the app process
 * actually instantiated. The full probe still runs from BootProvider
 * query() once the host triggers it.
 */
public class BootApplication extends Application {
    private static final String TAG = "WebAdbBoot";

    @Override
    public void onCreate() {
        super.onCreate();
        Log.i(TAG, "BootApplication.onCreate: app process is alive");
        try {
            java.io.FileOutputStream fos = new java.io.FileOutputStream(Probe.OUT_PATH);
            fos.close();
            Log.i(TAG, "BootApplication.onCreate: touched " + Probe.OUT_PATH);
        } catch (Throwable t) {
            Log.e(TAG, "BootApplication.onCreate: failed to touch output file", t);
        }
    }
}

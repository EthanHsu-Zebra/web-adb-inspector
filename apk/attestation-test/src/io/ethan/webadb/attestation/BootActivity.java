package io.ethan.webadb.attestation;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;

/**
 * LAUNCHER activity. Run on `am start -W -n
 * io.ethan.webadb.attestation/.BootActivity` or `monkey -p <pkg> 1`.
 * Executes the probe synchronously then finishes. The activity itself
 * is invisible (Theme.NoDisplay).
 *
 * Why this exists: on Android 14+, broadcasts to a cold app process
 * are silently dropped, even with --user 0 / explicit component / -S.
 * Launching an activity is the only reliable way to wake the process
 * from an adb shell context.
 *
 * We write the result file from THIS class so the host can see
 * "BootActivity.onCreate ran" as a single 0-byte touch, before any
 * probe logic runs.
 */
public class BootActivity extends Activity {
    private static final String TAG = "WebAdbBoot";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.i(TAG, "BootActivity.onCreate START");

        // First thing — make sure the activity is observably running
        // by writing a 0-byte file before anything else.
        try {
            java.io.FileOutputStream fos = new java.io.FileOutputStream(Probe.OUT_PATH);
            fos.close();
            Log.i(TAG, "Touched " + Probe.OUT_PATH);
        } catch (Throwable t) {
            Log.e(TAG, "Failed to touch output file", t);
        }

        try {
            Probe.run(getApplicationContext());
            Log.i(TAG, "Probe.run finished");
        } catch (Throwable t) {
            Log.e(TAG, "Probe.run threw", t);
        }
        finish();
        Log.i(TAG, "BootActivity.onCreate END");
    }
}

package io.ethan.webadb.attestation;

import android.app.Activity;
import android.os.Bundle;

/**
 * LAUNCHER activity. Run on `monkey -p <pkg> 1` or `am start -n
 * io.ethan.webadb.attestation/.BootActivity`. Executes the probe
 * synchronously then finishes. The activity itself is invisible
 * (Theme.NoDisplay).
 *
 * Why this exists: on Android 14+, broadcasts to a cold app process
 * are silently dropped, even with --user 0 / explicit component / -S.
 * Launching an activity is the only reliable way to wake the process
 * from an adb shell context.
 */
public class BootActivity extends Activity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            Probe.run(getApplicationContext());
        } catch (Throwable t) {
            android.util.Log.e("WebAdbProbe", "BootActivity probe failed", t);
        }
        finish();
    }
}

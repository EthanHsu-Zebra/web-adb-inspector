package io.ethan.webadb.attestation;

import android.app.Activity;
import android.os.Bundle;

/**
 * Invisible LAUNCHER activity. Its only purpose is to give the app a
 * launcher intent-filter so `monkey -p <pkg> 1` (run by the host
 * inspector) can spin up the app process. Without a started process,
 * Android 14+ drops broadcasts to installed receivers.
 *
 * The activity is Theme.NoDisplay so the user sees nothing.
 */
public class BootActivity extends Activity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        finish();
    }
}

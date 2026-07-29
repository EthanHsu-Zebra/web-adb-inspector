package io.ethan.webadb.attestation;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Broadcast entry point. On Android 14+ the host site may launch the
 * process via BootActivity instead because explicit broadcasts to a
 * cold process can be silently dropped. ProbeReceiver is kept as a
 * fallback for any caller that already has the app process running.
 */
public class ProbeReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        Probe.run(ctx);
    }
}

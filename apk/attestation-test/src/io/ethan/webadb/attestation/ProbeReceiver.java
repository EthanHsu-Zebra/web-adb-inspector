package io.ethan.webadb.attestation;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * BroadcastReceiver that dumps device-build / keystore / app-signing
 * information to a JSON file in the public Downloads directory so the
 * host-side WebUSB inspector can pull it back over ADB sync.
 *
 * Trigger from host:
 *   adb shell am broadcast -a io.ethan.webadb.PROBE \
 *       -n io.ethan.webadb.attestation/.ProbeReceiver
 *
 * Result file:
 *   /sdcard/Download/webadb_attestation.json
 *
 * NOTE: User-app Java context cannot read arbitrary system props via getprop.
 * We expose only what a normal unprivileged app can see. Anything privileged
 * stays on the host (adb shell) side of the inspector.
 */
public class ProbeReceiver extends BroadcastReceiver {
    private static final String TAG = "WebAdbProbe";
    private static final String OUT_FILE = "webadb_attestation.json";
    private static final String PROBE_OUT_PATH = "/data/local/tmp/webadb_attestation.json";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        // Touch the output file immediately so the host can detect that
        // the receiver was actually invoked (even if a later step throws).
        try {
            new FileOutputStream(PROBE_OUT_PATH).close();
        } catch (Throwable ignored) {}

        try {
            Map<String, Object> out = new LinkedHashMap<>();

            // 1) Build.* — always available to any app
            Map<String, Object> build = new LinkedHashMap<>();
            build.put("manufacturer", Build.MANUFACTURER);
            build.put("model", Build.MODEL);
            build.put("brand", Build.BRAND);
            build.put("device", Build.DEVICE);
            build.put("product", Build.PRODUCT);
            build.put("hardware", Build.HARDWARE);
            build.put("fingerprint", Build.FINGERPRINT);
            build.put("release", Build.VERSION.RELEASE);
            build.put("sdk_int", Build.VERSION.SDK_INT);
            build.put("security_patch", Build.VERSION.SECURITY_PATCH);
            build.put("bootloader", Build.BOOTLOADER);
            build.put("radio", Build.getRadioVersion());
            out.put("build", build);

            // 2) Settings.Secure.ANDROID_ID — persistent per-app/per-user id
            out.put("android_id", Settings.Secure.getString(
                ctx.getContentResolver(), Settings.Secure.ANDROID_ID));

            // 3) Package signing cert — proves this APK's identity.
            //    `Signature.toByteArray()` on the SigningInfo path returns
            //    the cert DER only when the APK uses v2+ signing; v1-signed
            //    APKs (like this debug-signed build) give an empty/4-byte
            //    blob. Try the legacy `signatures` path which always returns
            //    the actual cert DER for the querying app.
            try {
                Map<String, Object> sig = new LinkedHashMap<>();
                byte[] certBytes = null;
                // Prefer modern path (v2/v3); fall back to legacy v1 path.
                try {
                    android.content.pm.PackageInfo pi2 = ctx.getPackageManager().getPackageInfo(
                        ctx.getPackageName(),
                        android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES);
                    if (pi2.signingInfo != null) {
                        android.content.pm.Signature[] sigs = pi2.signingInfo.getApkContentsSigners();
                        if (sigs != null && sigs.length > 0 && sigs[0].toByteArray().length > 32) {
                            certBytes = sigs[0].toByteArray();
                        }
                    }
                } catch (Throwable ignored) {}
                if (certBytes == null || certBytes.length <= 32) {
                    android.content.pm.PackageInfo pi1 = ctx.getPackageManager().getPackageInfo(
                        ctx.getPackageName(),
                        android.content.pm.PackageManager.GET_SIGNATURES);
                    if (pi1.signatures != null && pi1.signatures.length > 0) {
                        certBytes = pi1.signatures[0].toByteArray();
                    }
                }
                if (certBytes != null && certBytes.length > 32) {
                    sig.put("sha256", sha256Hex(certBytes));
                    sig.put("size_bytes", certBytes.length);
                } else {
                    sig.put("sha256", "(unable to read signing cert)");
                    sig.put("size_bytes", certBytes != null ? certBytes.length : 0);
                }
                out.put("signing", sig);
            } catch (Throwable t) {
                Map<String, Object> sig = new LinkedHashMap<>();
                sig.put("error", String.valueOf(t.getMessage()));
                out.put("signing_error", sig);
            }

            // 4) AndroidKeyStore probe — does the device have a working KeyMint/TEE?
            //    We attempt to generate a key; success proves the keystore is alive
            //    and reports the security level (Software / TEE / StrongBox).
            try {
                String alias = "webadb_probe_" + System.currentTimeMillis();
                KeyPairGenerator kpg = KeyPairGenerator.getInstance(
                    KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
                kpg.initialize(new KeyGenParameterSpec.Builder(
                        alias,
                        KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .build());
                KeyPair kp = kpg.generateKeyPair();

                KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
                ks.load(null);
                KeyInfo info = (KeyInfo) ks.getKey(alias, null);

                Map<String, Object> ks_out = new LinkedHashMap<>();
                ks_out.put("success", true);
                ks_out.put("security_level", securityLevelName(info.getSecurityLevel()));
                ks_out.put("key_size", info.getKeySize());
                ks_out.put("algorithm", kp.getPrivate().getAlgorithm());
                ks_out.put("issuer", "AndroidKeyStore");
                ks_out.put("alias", alias);

                // 5) Key attestation cert chain (only if device supports it)
                //    No challenge is provided — chain is unsigned/empty extension.
                //    Still useful: proves the device can produce a cert at all.
                Certificate[] chain = ks.getCertificateChain(alias);
                if (chain != null && chain.length > 0) {
                    Map<String, Object>[] certs = new Map[chain.length];
                    for (int i = 0; i < chain.length; i++) {
                        Map<String, Object> c = new LinkedHashMap<>();
                        c.put("index", i);
                        c.put("type", chain[i].getType());
                        c.put("subject", chain[i].getPublicKey() != null
                            ? chain[i].getPublicKey().toString() : "");
                        c.put("sha256", sha256Hex(chain[i].getEncoded()));
                        c.put("pem", "-----BEGIN CERTIFICATE-----\n" +
                            Base64.encodeToString(chain[i].getEncoded(), Base64.DEFAULT) +
                            "-----END CERTIFICATE-----");
                        certs[i] = c;
                    }
                    ks_out.put("cert_chain", certs);
                } else {
                    ks_out.put("cert_chain", new Object[]{});
                }
                out.put("keystore", ks_out);

                // Best-effort cleanup of the probe key
                try { ks.deleteEntry(alias); } catch (Throwable ignored) {}
            } catch (Throwable t) {
                Map<String, Object> ks_out = new LinkedHashMap<>();
                ks_out.put("success", false);
                ks_out.put("error", String.valueOf(t.getMessage()));
                out.put("keystore", ks_out);
            }

            // 6) Write JSON to /data/local/tmp/ so the host inspector can
            //    pull it via adb sync (avoids scoped-storage restrictions
            //    on /sdcard/Download/ for unprivileged apps on Android 11+).
            File outFile = new File(PROBE_OUT_PATH);
            try (FileOutputStream fos = new FileOutputStream(outFile)) {
                fos.write(JsonWriter.toJson(out).getBytes("UTF-8"));
            }
            // Best-effort chmod 644 so the shell user can read it.
            try {
                Runtime.getRuntime().exec("chmod 644 " + PROBE_OUT_PATH).waitFor();
            } catch (Throwable ignored) {}
            Log.i(TAG, "Wrote " + outFile.getAbsolutePath() + " (" + outFile.length() + " bytes)");
        } catch (Throwable t) {
            Log.e(TAG, "Probe failed", t);
        }
    }

    private static String securityLevelName(int level) {
        // KeyInfo.securityLevel values from android.security.keystore.KeyInfo
        // SECURITY_LEVEL_SOFTWARE = 0, TRUSTED_ENVIRONMENT = 1, STRONG_BOX = 2
        if (level == 0) return "Software";
        if (level == 1) return "TEE";
        if (level == 2) return "StrongBox";
        return "Unknown(" + level + ")";
    }

    private static String sha256Hex(byte[] data) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(data);
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                String h = Integer.toHexString(b & 0xFF);
                if (h.length() == 1) sb.append('0');
                sb.append(h);
            }
            return sb.toString();
        } catch (Exception e) {
            return "(error: " + e.getMessage() + ")";
        }
    }
}

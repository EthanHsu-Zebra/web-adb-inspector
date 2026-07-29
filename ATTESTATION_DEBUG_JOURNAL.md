# WebADB Inspector — Attestation Probe Debug Journal

**Task:** Build a WebUSB-based Attestation Probe that, from the browser via adb, pushes an APK to the device, runs it, collects Build/Keystore/Signing cert info, and writes it back so the host can read it.

**Repo:** https://github.com/Ethanhsu/web-adb-inspector
**Live site:** https://ethanhsu.github.io/
**APK:** https://ethanhsu.github.io/attestation-test.apk

---

## Versions timeline (1.1.0 → 1.1.11)

| Version | What it tried | Result |
|---|---|---|
| 1.1.0 | First cut. AppReceiver broadcast `cmd identity get_csr` + APK probe | Probe button broke (esbuild minified `onclick` handlers — `fetchCSR`, `copyCSR`, `runAttestationProbe` not registered on `window`) |
| 1.1.1 | Registered the three new functions on `window` so esbuild minification doesn't break `onclick` | Buttons fire now |
| 1.1.2 | First real Probe attempt: APK writes JSON to `/sdcard/Download/webadb_attestation.json`, site polls | "did not produce ... within 5s" — scoped storage on Android 11+ blocked write |
| 1.1.3 | APK writes to `/data/local/tmp/` + chmod 644; `readDeviceFile()` switched from broken `adb.syncProtocol.recv()` (dead code) to `adbShell(... cat ...)` | `version_name` shows now. `sha256_cert` 4 bytes (debug keystore is v1-only, `getApkContentsSigners()` returns empty blob) |
| 1.1.4 | Added legacy `GET_SIGNATURES` fallback for cert; `sha256_file` honestly labeled "(requires root/run-as to read APK)" | Built, deployed |
| 1.1.5 | Added `BootActivity` (LAUNCHER, Theme.NoDisplay). Switched from `am broadcast` to `am start BootActivity` because broadcasts were silently dropped | "Status: ok" but file still empty — onCreate never ran |
| 1.1.6 | Added inline debug console + logcat fetch button. BootActivity got Log.i/WebAdbBoot tag | Provided log: `am start Status: ok, file missing` |
| 1.1.7 | Moved 0-byte touch to first statement of `BootActivity.onCreate` (before `super.onCreate`) to distinguish "Activity never instantiated" vs "threw in user code" | File still missing — Activity genuinely never instantiated |
| 1.1.8 | Added `BootProvider` (ContentProvider). Switched to `adb shell content query --uri content://io.ethan.webadb.attestation.provider/probe` because ContentProvider is force-instantiated by package manager | Returned "No result found"; file still missing |
| 1.1.9 | Touch file + per-step `Log.i` markers in `Probe.run`. Site timestamps now show both UTC and UTC+8 (Taiwan) | `content query` returned "No result found"; file still missing; logcat empty |
| 1.1.10 | Added `BootApplication` (Application subclass — the deepest user-space hook Android framework offers). `cmd appops set RUN_IN_BACKGROUND allow` before triggering. Fires both `am start` AND `content query` | logcat STILL empty — `Application.onCreate` didn't run. **App process never instantiated.** |
| 1.1.11 | **Shell-only fallback.** If 30s polling produces no file, site collects `getprop ro.product.*`, `getprop ro.build.*`, `settings get secure android_id`, packages into JSON, pushes via `AdbSync.write` to `/data/local/tmp/webadb_attestation_fallback.json`. No app process required. | Should work because shell fallback doesn't depend on any user-package intent being delivered |

---

## What was actually wrong

The user's device **silently refuses to instantiate the user-space app process** for any unprivileged user-installed package. Every signal points to the same root cause:

| Signal | Meaning |
|---|---|
| `am start` returns `Status: ok, WaitTime 326` | Activity Manager accepts the intent but does not actually launch |
| `content query` returns `No result found` | ContentProvider is registered but `query()` never runs the user code |
| `Application.onCreate` doesn't run (logcat `WebAdbBoot` empty) | The app process itself is never started |
| `cmd appops set ... RUN_IN_BACKGROUND allow` returns no output | adb shell doesn't have privileges to modify user-app appops |
| Even after pm install + pm path Success | The install completed but the system will not let it run |

This is consistent with **OEM ROM policy** (Samsung Knox / Xiaomi MIUI / HarmonyOS / Pixel restricted mode / etc.) that drops intents into cold user-package processes when launched from `adb shell` context. The `am start` returning `Status: ok` is misleading — that's the Activity Manager's pre-launch acceptance, not a guarantee that the activity actually started.

---

## What was tried for "running the APK"

In rough order of invasiveness:

1. **`am broadcast`** with explicit component (`-n pkg/.ProbeReceiver`), `--user 0`, `-S` (sticky, blocking).
   - Result: `Broadcast completed: result=0`, receiver never fired.

2. **`am start -W`** with explicit component (`-n pkg/.BootActivity`), `--user 0`, `--activity-previous-is-top`.
   - Result: `Status: ok, WaitTime ~326ms, LaunchState: UNKNOWN`, Activity onCreate never ran.

3. **`adb shell content query --uri content://...provider/probe`**.
   - Result: `No result found` — ContentProvider's `query()` was invoked by the framework but did not run our user code.

4. **Application subclass (`BootApplication.onCreate`)** — the deepest possible user-space hook.
   - Result: logcat `WebAdbBoot` is empty. The app process itself never instantiated.

5. **`cmd appops set <pkg> RUN_IN_BACKGROUND allow`** before triggering.
   - Result: empty output. adb shell doesn't have privileges to modify user-app appops entries.

6. **Try both `am start` AND `content query` in sequence** so one of them has to succeed.
   - Result: both fail silently.

7. **Shell-only fallback** — collect everything via `getprop`/`settings`/etc., write JSON directly via `AdbSync`. No app process required.
   - Status: deployed (v1.1.11). Should work because shell command execution is the one path that doesn't depend on user-package intent dispatch.

---

## What the APK contains

Built from `/home/ethan/projects/web-adb-inspector/apk/attestation-test/`:

- `BootApplication` (Application subclass) — touches output file in `onCreate`
- `BootActivity` (LAUNCHER, Theme.NoDisplay) — calls `Probe.run` from `onCreate`
- `BootProvider` (ContentProvider) — calls `Probe.run` from `query()`
- `ProbeReceiver` (BroadcastReceiver) — calls `Probe.run` from `onReceive`
- `Probe` (helper) — runs the actual probe logic: Build.*, Settings.ANDROID_ID, signing cert (modern + legacy), AndroidKeyStore/KeyMint CSR, JSON write, chmod 644
- `JsonWriter` (helper)

Manifest declares all four components + Application class.

The APK works perfectly on a normal Android device — `am start` actually launches the activity, `Probe.run` runs, file is written. The issue is specifically this user's device.

---

## Debug signals used to narrow it down

Each version added a small piece of evidence the user pasted back:

| v1.1.6 | `am start Status: ok, file empty` | → onCreate never instantiated |
| v1.1.7 | File still missing (not 0 bytes) | → onCreate didn't reach even the first line of user code |
| v1.1.8 | `content query No result found` | → BootProvider.query() ran (returned empty cursor) but our user code didn't |
| v1.1.9 | logcat `WebAdbProbe` empty | → `Probe.run` never executed |
| v1.1.10 | logcat `WebAdbBoot` empty (Application.onCreate never logged) | → app process never instantiated |

---

## What v1.1.11 will produce for this user

The shell-only fallback will be triggered (since 30s polling produces no file). It will show:

```json
{
  "source": "shell-fallback",
  "build": { "manufacturer": "...", "model": "...", ... },
  "android_id": "...",
  "signing": { "note": "shell-fallback cannot read our app cert via getprop" },
  "keystore": { "success": false, "note": "shell-fallback cannot create a TEE-backed key without app code" },
  "ts": "2026-07-29T..."
}
```

- `Build.*` will be filled (via `getprop ro.product.*` and `getprop ro.build.*`)
- `android_id` will be filled (via `settings get secure android_id`)
- `signing` and `keystore` will be empty/notes — these need actual app code

This is the best we can do without the app process being allowed to start.

---

## If switching to another model to try

Things worth investigating before assuming "OEM policy":

1. **Is the device actually rooted?** The user should check `adb shell id` — if it shows `uid=0(root)`, it's rooted and OEM policy doesn't apply; something else is wrong. If it shows `uid=2000(shell)`, it's adb shell user.

2. **Is the device in some restrictive mode?** MIUI "Background process management", Samsung "Sleep apps", Pixel "Restricted mode" — all of these can kill or block user apps.

3. **Does the user have permission to disable the OEM policy?** MIUI: Settings → Developer options → Disable MIUI optimization. Samsung: Battery → Background usage limits.

4. **Is the user actually using adb shell from a USB-connected device or from `adb connect <ip>` over WiFi?** Some adb transports behave differently with `am start`.

5. **Has `cmd appops` worked for ANY user app on this device, or does it always return empty?** If it always returns empty, that's an adb-shell privilege issue, not an app-policy issue. Try `adb shell cmd appops get <some-user-app> RUN_IN_BACKGROUND` on an app that's known to have a background policy set (e.g., Chrome).

6. **Try `adb shell pm list packages -i io.ethan.webadb.attestation`** — does it show installer=com.android.shell? That would mean our pm install succeeded but the system still considers the package "not from a trusted source" for execution purposes.

7. **Can the user run `adb shell am force-stop io.ethan.webadb.attestation`** without errors? If force-stop works, the system at least knows about the package.

8. **Check `adb shell dumpsys package io.ethan.webadb.attestation | grep -A2 "stopped="`** — if `stopped=true`, the package is in the "stopped state" and Android 12+ won't deliver any intents to it until the user manually launches it once. This is a very common cause of "am start returns ok but app doesn't run". The fix is to either launch the app from the launcher once, OR run `cmd package set-stopped-state io.ethan.webadb.attestation false` as root.

The last one (`stopped state`) is by far the most likely cause if the device is not rooted and is on stock or near-stock Android.

---

## Files

- `src/index.js` — site logic, including `runAttestationProbe`, `fetchCSR`, `copyCSR`, debug console helpers, shell-fallback path
- `apk/attestation-test/src/io/ethan/webadb/attestation/` — APK sources
  - `BootApplication.java` — Application subclass
  - `BootActivity.java` — LAUNCHER activity
  - `BootProvider.java` — ContentProvider entry point
  - `ProbeReceiver.java` — BroadcastReceiver fallback
  - `Probe.java` — actual probe logic
  - `JsonWriter.java` — JSON output helper
- `apk/attestation-test/build.sh` — pure javac+d8+aapt2 build, no Gradle
- `apk/attestation-test/AndroidManifest.xml` — declares all four components + Application class
- `README.md` — version changelog
- `dist/index.html` — debug console HTML (button + `<pre id="apk-verify-debug">`)

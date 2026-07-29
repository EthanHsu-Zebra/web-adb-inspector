# Web ADB Inspector

Browser-based Android device inspector using WebUSB. Connect your Android device via USB and inspect system properties, features, installed packages, attestation status, and RKP (Remote Key Provisioning) — all from the browser.

**Demo:** https://ethanhsu.github.io/

## Features

- **Zero server** — runs 100% client-side using WebUSB + ADB protocol
- **System Properties** — full `getprop` output with search and JSON export
- **Package Manager Features** — all hardware/software features with SDK classification
- **Installed Packages** — full dumpsys package data: version, SDK, UID, certs, permissions (with grant status)
- **Key Attestation** — Verified Boot, VBMeta, DM-Verity, Flash Lock, KeyMint, StrongBox
- **HW Trust** — KeyMint CSR retrieval (`cmd identity get_csr` for default / strongbox / TEE slots), DER SHA-256 fingerprint, copy PEM, JSON export
- **Attestation Probe** — ships a bundled `attestation-test.apk` to the device, installs it, fires its probe broadcast, pulls back what an unprivileged app context can see (`Build.*`, `Settings.Secure.ANDROID_ID`, app signing cert, `AndroidKeyStore` probe with security level / key size / cert chain). Result rendered as full key-value tree; export → `AttestationProbeDeviceInfo.deviceinfo.json`.
- **RKP Status** — Google server connectivity (`ping play.googleapis.com`), KeyMint provider, attestation, GMS, Play Integrity, Android 15 HAL-based hardware detection (NFC / Keystore / StrongBox / KeyMint / Biometrics via `service list`), standard AOSP boot security properties (with hover tooltips)
- **ADB Shell** — custom commands with quick-access buttons
- **JSON Export** — matches CTS `DeviceInfo.deviceinfo.json` schema exactly
- **Device Nicknames** — persistent nicknames for your devices
- **Font Size Control** — adjustable text scaling

## Requirements

- Browser with WebUSB support (Chrome, Edge, Chromium-based)
- Android device with USB debugging enabled
- ADB not running on the host (WebUSB needs exclusive device access)

## Build

```bash
npm install
npm run build
```

Output: `dist/bundle.js` + `dist/index.html`

## Deployment

This project is deployed to GitHub Pages via CI/CD pipeline:

1. Source repo: `Ethanhsu/web-adb-inspector` (public)
2. Deploy repo: `Ethanhsu.github.io` (clones source, builds, pushes `dist/` to Pages)
3. Branch: `master`

## Technology

- `@yume-chan/adb` — ADB protocol over WebUSB transport
- `@yume-chan/adb-daemon-webusb` — WebUSB device manager
- esbuild — single-file bundle (~113 KB)

## Version

**Current:** 1.1.19

### Changelog

- **1.1.19** — USB disconnect detection: added heartbeat ping every 5s as fallback for browsers where `navigator.usb` disconnect event fires but serial/vendorId match fails. Heartbeat pings `adb.getProp()` with 3s timeout, marks device dead after 2s, auto-removes from connected list and refreshes UI. This catches all physical disconnect cases regardless of browser behavior. Bumped APP_VERSION 1.1.18 -> 1.1.19.
- **1.1.18** — USB disconnect: match by vendorId+productId+serial instead of serial alone (serial can be null after disconnect on some browsers). Persist `_usbId` at connect time for reliable device matching. Shell tab output now persists per device (`dataCache.shellBySerial`) — survives device switches like probe results. Bumped APP_VERSION 1.1.17 -> 1.1.18.
- **1.1.17** — Probe results now persist per device (dataCache.probeBySerial) — switching away and back restores previous probe output. Shell tab: removed Quick Checks and per-button consoles — back to single ADB Shell with input + Run + Clear. Bumped APP_VERSION 1.1.16 -> 1.1.17.
- **1.1.14** — Shell tab: per-button independent console outputs (Android Ver, Model, Hardware, Battery, Display, WiFi each has their own output panel — no more mixed output). Added "Clear All" button to clear all panels at once. RKP tab: filter out invalid/unset items (empty, "Not set", "Not found", "Not installed" rows are hidden). HW Trust tab: `fetchCSR` now properly detects `cmd identity` errors ("Can't find service", etc.) and shows clean error message instead of crashing with atob decode error. Removed dead APK probe constants. Bumped APP_VERSION 1.1.13 -> 1.1.14.
- **1.1.13** — Attestation Probe: removed APK-based flow entirely (OEM ROMs block shell-launched app processes). Replaced with pure shell-only probe: `cmd identity get_csr` (default/strongbox/tee) with proper error handling for devices without Identity service, verified boot state, security hardware properties, KeyStore/KeyMint HAL status, active security services via `service list`. Fixed `atob` decode crash when CSR command returns error text instead of PEM. Added Clear button to Shell tab. Bumped APP_VERSION 1.1.12 -> 1.1.13.
- **1.1.12** — Attestation Probe shell fallback: enhanced to collect all HW Trust data reachable from adb shell context. New fields: `cmd identity get_csr` for default/strongbox/tee slots (with DER SHA-256 computed client-side via `crypto.subtle`), verified boot state (`ro.boot.verifiedbootstate`, `vbmeta.verify_state`, etc.), security hardware properties (`ro.hardware.keystore`, `ro.hardware.strongbox`, RKP flags), KeyStore/KeyMint HAL status (`cmd keystore`), and active security services (`android.security.keystore`, `android.hardware.keymint` via `service list`). This means even on devices that refuse to instantiate user app processes, the shell fallback still surfaces the device's attestation key identity — no APK launch required. Bumped APP_VERSION 1.1.11 → 1.1.12.

- **1.1.10** — Attestation Probe: added `BootApplication` (Application subclass). `Application.onCreate` is the earliest point at which user-space Java code is guaranteed to run on Android — it's invoked by the framework during process startup, before any Activity / Service / ContentProvider user code, and cannot be silently dropped by background-app restrictions the way Activity launches are. The `BootApplication.onCreate` touches `/data/local/tmp/webadb_attestation.json` and logs to `WebAdbBoot`, so the host can see whether the app process actually instantiated. Manifest now declares `android:name=".BootApplication"`. Site also now force-sets `cmd appops set io.ethan.webadb.attestation RUN_IN_BACKGROUND allow` before triggering, AND fires both `am start BootActivity` and `content query BootProvider` in sequence (one of them must succeed). Bumped APP_VERSION 1.1.9 → 1.1.10.

- **1.1.9** — Attestation Probe: the 0-byte touch moved back into `Probe.run` (was in `BootActivity.onCreate`). Per-step Log.i markers before each probe stage (build / android_id / signing / keystore / write). Write-failure catch rethrows to the outer catch with a Log.e entry, so logcat will surface the actual exception if step 5 fails. Site debug timestamps now show both UTC and Taiwan (UTC+8) times so timestamps in the inline console match `ls -la` on device. Bumped APP_VERSION 1.1.8 → 1.1.9.

- **1.1.8** — Attestation Probe: switched from `am start BootActivity` to `adb shell content query --uri content://io.ethan.webadb.attestation.provider/probe`. Even with the 0-byte touch as the first statement of `BootActivity.onCreate` (v1.1.7), the file still doesn't appear on the user's device — `am start` reports `Status: ok` but the activity's onCreate never actually runs (confirmed: the touch doesn't happen, the file is missing, not 0 bytes). ContentProvider is the Android-recommended way to guarantee user-space Java code runs: the system *must* instantiate every provider declared in the manifest before a client (including adb shell) can bind to it, regardless of background-app restrictions that block Activity launches and broadcasts. APK now ships a `BootProvider` whose `query()` invokes `Probe.run(getContext())` and returns an empty cursor. Bumped APP_VERSION 1.1.7 → 1.1.8.

- **1.1.7** — Attestation Probe: rewrote `BootActivity.onCreate` to touch the output file as its very first action, before any helper calls. With v1.1.6 the file never appeared on device even though `am start` returned `Status: ok`, which means BootActivity's onCreate either never ran or threw before any code could execute. The 0-byte touch from onCreate is the most reliable signal that the activity was actually instantiated and reached user code — if the touch succeeds but the full JSON doesn't, we know Probe.run threw partway. Probe.run's internal touch was removed to avoid confusion (it ran from within the same activity and could mask whether onCreate itself fired). Bumped APP_VERSION 1.1.6 → 1.1.7.

- **1.1.6** — Attestation Probe: added an inline debug console below the Run button. Per-step timestamps for fetch, push, pm install, pm path, am start, plus immediate `ls -la` and `stat` of the output file after launch. Buttons for fetching device logcat (filtered to WebAdbProbe/WebAdbBoot/AndroidRuntime) and copying the entire debug log to clipboard. BootActivity now logs entry/exit and any exception via `Log.i / Log.e` (tags `WebAdbBoot` and `WebAdbProbe`) so we can see on logcat whether the activity actually ran and whether Probe.run threw. Bumped APP_VERSION 1.1.5 → 1.1.6.

- **1.1.5** — Attestation Probe: gave up on broadcasts entirely. Even with --user 0 + explicit component + -S, Android 14+ silently drops broadcasts to a cold app process (result=0 but receiver never runs). Switched to launching the new BootActivity LAUNCHER activity via `am start -W -n io.ethan.webadb.attestation/.BootActivity` — Activity onCreate runs the probe synchronously, so the result file is guaranteed to appear. Refactored probe logic out of ProbeReceiver into a shared `Probe.run(Context)` helper so both the LAUNCHER activity and the (now fallback) broadcast receiver invoke the same code. Bumped APP_VERSION 1.1.4 → 1.1.5.

- **1.1.4** — Attestation Probe: APK now ships a LAUNCHER activity (`BootActivity`, Theme.NoDisplay, immediately `finish()`). Without a started app process, Android 14+ silently drops broadcasts to installed receivers even with `--user 0` / explicit component. Site now calls `monkey -p <pkg> 1` after install to start the process. `pm install` result is now parsed for `Success`; `pm path <pkg>` confirms the package is actually present; `am broadcast -S` (sticky, blocking) reports how many receivers actually fired. Error message now includes pm install + broadcast output for diagnosis. Bumped APP_VERSION 1.1.3 → 1.1.4.

- **1.1.3** — Attestation Probe: add immediate file touch in `onReceive` (so host can detect receiver firing vs. silent failure), add `--user 0` to broadcast flag (Android 14+ delivery fix), poll timeout 5s → 30s with 500ms interval (KeyMint HAL init can take 10-15s), error message now reports whatever the file contains if it exists (empty vs partial). APK signing cert: fall back to deprecated `PackageManager.GET_SIGNATURES` path when `SigningInfo` path returns the empty v1-scheme blob (this APK is debug-signed with v1 only). Packages export: `sha256_file` now labeled `(requires root/run-as to read APK)` — it's a sandbox limit, not a parser bug. Bumped APP_VERSION 1.1.2 → 1.1.3.

- **1.1.2** — Fix Attestation Probe failure: APK was writing its output to `/sdcard/Download/` which is blocked by Android 11+ scoped storage for unprivileged apps; now writes to `/data/local/tmp/webadb_attestation.json` with chmod 644. Fix `readDeviceFile`: was calling `adb.syncProtocol.recv()` which isn't wired up in `@yume-chan/adb`'s `Adb` class (dead code path — packages were silently falling back to the `pm list` fallback that has no version/cert/sha fields). Replaced with `adbShell(info.adb, 'cat ' + path)`. Also simplified `fetchPackages` to dump directly via shell protocol instead of writing a temp file first. Bumped APP_VERSION 1.1.1 → 1.1.2.
- **1.1.1** — Fix HW Trust / Attestation Probe buttons not firing (new functions weren't registered on `window`, so esbuild minified names made `onclick` handlers resolve to undefined). Fix dumpsys parser: `codePath` was truncated at embedded `==` (e.g. `/data/app/~~abc==/pkg-XYZ` → `/data/app/~~abc=`); requested/declared permissions in `name: attr=value` format weren't captured. Empty fields in Packages export JSON now show `(not parsed)` instead of empty strings. Raw dumpsys text cached as `dataCache.lastDumpsysText` for debugging.
- **1.1.0** — New HW Trust tab: KeyMint CSR retrieval via `cmd identity get_csr` (default / strongbox / TEE slots) with DER SHA-256 fingerprinting and PEM copy. New Attestation Probe: ships bundled `attestation-test.apk` to device → install → broadcast → pull JSON (Build.*, AndroidKeyStore probe, signing cert, key attestation chain). RKP: removed both `Warranty Bit (boot)` and `Warranty Void (user)` rows (OEM-specific, redundant). Bumped APP_VERSION 1.0.8 → 1.1.0.
- **1.0.8** — Fix init TypeError that silently killed header-version display
- **1.0.7** — Fix header-version not displaying (module + DOMContentLoaded race)
- **1.0.6** — RKP rewritten for Android 15: Google server connectivity (`ping play.googleapis.com`), HAL-based hardware detection via `service list` (no more vendor `ro.hardware.*`), standard AOSP boot security props. Package parser: fixed `version_name` parsing on Android 14 multi-KV lines. Package toggle: fixed `togglePkgDetail` selector. Header: version display.
- **1.0.5** — Parser fixes (trimmed not line), Shell tab, footer removal
- **1.0.4** — Search/dataCache expose, dumpsys parser fixes, EDI schema fields, cert colon format
- **1.0.3** — Multi-KV parser, version in header, prop column auto-width, RKP Operational
- **1.0.2** — Packages spinner fix, wider prop column, version from bundle

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

**Current:** 1.1.5

### Changelog

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

# Web ADB Inspector

Browser-based Android device inspector using WebUSB. Connect your Android device via USB and inspect system properties, features, installed packages, attestation status, and RKP (Remote Key Provisioning) — all from the browser.

**Demo:** https://ethanhsu-zebra.github.io/web-adb-inspector/

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
- **Remote Session (Share)** — generate a link so someone else can view a device's status, and (with your approval) run shell commands or take live screen/input control, from anywhere. Gated to Zebra devices only, with a remote-config rollout switch — see `share-config.json`.
- **Export All (HTML)** — combined, tabbed snapshot of Properties/Features/Packages/Attestation/RKP as one standalone file

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

Self-contained — pushing to `master` triggers `.github/workflows/deploy.yml`, which runs `npm ci && node build.mjs` and deploys `dist/` straight to this repo's own GitHub Pages site. No separate deploy repo (a legacy two-repo setup existed early on; see `PROJECT_CONTEXT.md` §4 for the full history and manual Pages-source prerequisite).

## Technology

- `@yume-chan/adb` — ADB protocol over WebUSB transport
- `@yume-chan/adb-daemon-webusb` — WebUSB device manager
- esbuild — single-file bundle (~250 KB)

## Version

**Current:** 1.31.0

Full, actively-maintained changelog and architecture notes live in [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) (§7 "Known Bugs and Fixes" doubles as the changelog) — this file isn't duplicated here to avoid the two drifting apart, which is exactly what happened to the changelog that used to live in this section (it stopped at 1.1.34 while the app moved on to 1.31.0; see git history if you want that old list).

# Web ADB Inspector

Browser-based Android device inspector using WebUSB. Connect your Android device via USB and inspect system properties, features, installed packages, attestation status, and RKP (Remote Key Provisioning) — all from the browser.

**Demo:** https://ethanhsu.github.io/

## Features

- **Zero server** — runs 100% client-side using WebUSB + ADB protocol
- **System Properties** — full `getprop` output with search and JSON export
- **Package Manager Features** — all hardware/software features with SDK classification
- **Installed Packages** — full dumpsys package data: version, SDK, UID, certs, permissions (with grant status)
- **Key Attestation** — Verified Boot, VBMeta, DM-Verity, Flash Lock, KeyMint, StrongBox
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
- esbuild — single-file bundle (~104 KB)

## Version

**Current:** 1.0.6

### Changelog

- **1.0.6** — RKP rewritten for Android 15: Google server connectivity (`ping play.googleapis.com`), HAL-based hardware detection via `service list` (no more vendor `ro.hardware.*`), standard AOSP boot security props. Package parser: fixed `version_name` parsing on Android 14 multi-KV lines. Package toggle: fixed `togglePkgDetail` selector. Header: version display.
- **1.0.5** — Parser fixes (trimmed not line), Shell tab, footer removal
- **1.0.4** — Search/dataCache expose, dumpsys parser fixes, EDI schema fields, cert colon format
- **1.0.3** — Multi-KV parser, version in header, prop column auto-width, RKP Operational
- **1.0.2** — Packages spinner fix, wider prop column, version from bundle

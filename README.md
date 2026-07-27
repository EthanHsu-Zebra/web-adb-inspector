# Web ADB Inspector

Browser-based ADB device inspector using WebUSB. Runs entirely client-side — no server, no proxy, no wireless ADB.

Inspired by the Google GTS EdiHost module for inspecting Android device properties and features.

## Features

- **Properties** — full `getprop` output, formatted as key-value pairs
- **Features** — `pm list features` output, like GTS EdiHost
- **Packages** — third-party installed packages (`pm list packages -3`)
- **Shell** — interactive ADB shell with quick-access buttons

## Requirements

- Chrome or Edge (WebUSB support)
- Android device with USB debugging enabled
- USB cable

## Usage

1. Open the page (hosted on GitHub Pages or locally)
2. Connect your Android device via USB
3. Click **Connect Device** and grant USB permission in the browser dialog
4. Select the device from the sidebar to view its details

## Architecture

| Layer | Technology |
|-------|------------|
| USB transport | WebUSB API (browser-native) |
| ADB protocol | @yume-chan/adb (Tango ADB) |
| Auth | @yume-chan/adb-credential-web (IndexedDB + WebCrypto) |
| Build | esbuild (IIFE bundle) |
| Hosting | GitHub Pages (fully static) |

Everything runs in the browser. No Node.js server, no Python proxy, no wireless ADB.

## Build

```bash
npm install
node build.mjs
# Output: dist/bundle.js (minified, ~20 KB)
```

The `dist/` directory is ready for GitHub Pages deployment.

## License

MIT

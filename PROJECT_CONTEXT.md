# Web ADB Inspector — Project Context (Complete Handover)

Last updated: 2026-07-30
Current version: v1.1.42

## 1. Project Overview

Browser-based Android device inspector using **WebUSB + ADB protocol**. Runs 100% client-side — no server, no ADB installed on host.

- Source repo: `Ethanhsu/web-adb-inspector` (public)
- Deploy repo: `Ethanhsu.github.io` (clones source, builds, deploys to GitHub Pages)
- Live URL: https://Ethanhsu.github.io/
- Working directory: `/home/ethan/projects/web-adb-inspector`

### Core Dependencies (package.json)
- `@yume-chan/adb` ^2.6.0 — ADB protocol library
- `@yume-chan/adb-daemon-webusb` ^2.3.2 — WebUSB transport for ADB daemon
- `@yume-chan/adb-credential-web` ^2.1.0 — ADB credential store (localStorage-backed)
- `esbuild` ^0.20.0 — bundler (devDependency)

### Build
```bash
node build.mjs         # one-shot build -> dist/bundle.js
node build.mjs --watch # watch mode
```
Output: `dist/bundle.js` (minified IIFE, ~127 KB) + `dist/bundle.js.map`
The build script does NOT regenerate `dist/index.html` — it is checked into the repo as-is.

## 2. Architecture

### Single-file architecture
- `src/index.js` — ALL logic in one file (~2050 lines). No component framework.
- `dist/index.html` — HTML + inline CSS + `<script src="bundle.js?v=...">`
- `dist/bundle.js` — esbuild IIFE bundle of `src/index.js` + yume-chan deps

### Global State (src/index.js lines 14-18)
```js
const credentialStore = new AdbWebCredentialStore('web-adb-inspector');
const connectedDevices = new Map();      // serial -> { adb, usbDevice, transport, _displayName, _usbId }
const availableDevices = new Map();      // serial -> { adb:null, usbDevice, transport:null, _displayName, _usbId }
let activeSerial = null;                  // currently selected device
const dataCache = { props: [], features: [], packages: [] };
const deviceNicknames = { /* from localStorage */ };
let fontSizeLevel = 0;                   // from localStorage
```

### Two-panel sidebar
- **Connected devices** (top) — devices with active ADB connection
- **Ready to Connect** (bottom) — previously granted USB devices (disconnected via button, or newly plugged in but not yet connected)

### Key Data Structures

`connectedDevices` Map entries:
```js
serial -> {
  adb: Adb instance,
  usbDevice: USBDevice,
  transport: AdbDaemonTransport,
  _displayName: string,  // e.g. "Xiaomi 23049RAD8C"
  _usbId: { vendorId, productId, serial }  // for USB event matching
}
```

`availableDevices` Map entries:
```js
serial -> {
  adb: null,
  usbDevice: USBDevice reference (may be stale — see WebUSB lifecycle below),
  transport: null,
  _displayName: string,
  _usbId: { vendorId, productId, serial }  // for USB event matching
}
```

## 3. USB/ADB Connection Flow

### 3.1 Initial connection (new device via +Connect Device button)
1. Click `+Connect Device` → `scanDevices()` (line 95)
2. `AdbDaemonWebUsbDeviceManager.BROWSER.requestDevice()` shows browser picker
3. User selects device → returns `USBDevice`
4. Calls `connectDevice(usbDevice)` (line 236)

### 3.2 connectDevice(usbDevice) — line 236
The MASTER connection function. ALL paths converge here:
1. Validates `usbDevice` has `.connect()` method
2. `usbDevice.connect()` — opens USB connection
3. `AdbDaemonTransport.authenticate()` — establishes ADB protocol
4. `new Adb(transport)` — creates ADB client
5. Reads `ro.serialno` to get actual ADB serial (may differ from USB serial)
6. Sets up `USBConnection.closed` listener for disconnect detection
7. Sets up heartbeat (3s interval, `adb.getProp('ro.build.id')`)
8. Registers `_usbDisconnectHandler` on `navigator.usb` (one-time, line 334)
9. Stores in `connectedDevices` Map
10. Calls `renderDeviceList()` + `selectDevice(adbSerial)`

### 3.3 Reconnecting from "Ready to Connect" list — connectAvailable() line 547
TWO-STEP strategy:
1. **Instant reconnect**: `navigator.usb.getDevices()` → find matching device by `_usbId` → pass directly to `connectDevice()`. No picker needed.
2. **Fallback picker**: If device not in `getDevices()` (was unplugged and re-plugged), use `mgr.requestDevice()` to show picker, then `connectDevice()`.

**CRITICAL**: Do NOT pass the raw USBDevice to `AdbDaemonTransport.authenticate()` — you need `usbDevice.connect()` first, which returns a `USBConnection`. `connectDevice()` handles this. The v1.1.41 bug (`pipeTo` error) was caused by passing the USBDevice directly as `connection` to authenticate.

### 3.4 Disconnect via button — disconnectOne() line 587
1. Calls `transport.close()`
2. Deletes from `connectedDevices`
3. Moves device info to `availableDevices` (keeps it in "Ready to Connect")
4. Key format must match `scanAvailableDevices()` — uses `serial || vid:pid:timestamp`

### 3.5 Physical unplug — _usbDisconnectHandler line 334
Registered ONCE on `navigator.usb.addEventListener('disconnect', ...)`:
1. Event fires with `e.device` (the unplugged USBDevice)
2. Matches against `connectedDevices` using `_usbId` (serial preferred, fallback to vid+pid)
3. If matched in connected: close transport, delete from connected, delete from available
4. If matched in available only: delete from available
5. Calls `renderDeviceList()` to update UI

### 3.6 USB connect events
- `navigator.usb.addEventListener('connect', scanAvailableDevices)` — line 73
- Also called on page init with 500ms delay — line 68

### 3.7 scanAvailableDevices() — line 123
1. `navigator.usb.getDevices()` gets all previously granted devices
2. Builds `knownConnected` and `knownAvailable` sets using `vid:pid:serial` keys
3. Skips devices already in connected or available
4. Adds new devices to `availableDevices` Map
5. Calls `renderDeviceList()`

## 4. Deployment Pipeline

### Flow
```
Ethanhsu/web-adb-inspector (main) --push--> GitHub Actions
  --> clones into Ethanhsu.github.io
  --> npm ci + node build.mjs
  --> copies dist/* to Ethanhsu.github.io root
  --> git push --> GitHub Pages serves from Ethanhsu.github.io
```

### Trigger deployment
```bash
gh workflow run --repo Ethanhsu/Ethanhsu.github.io "Build and deploy from web-adb-tool"
```
Deployment takes ~30-60 seconds total.

### Verify deployment
```bash
# Check HTML version
curl -sL "https://Ethanhsu.github.io/index.html" | grep -oP 'bundle\.js\?[^\"]+'
# Check bundle contains specific code
curl -s "https://Ethanhsu.github.io/bundle.js?v=..." | grep -oP 'search term'
```

### Cache-busting
`dist/index.html` contains `<script src="bundle.js?v=YYYYMMDDNN">`.
- The build script does NOT auto-update this — manually edit `dist/index.html` before commit.
- Users must hard refresh (Ctrl+Shift+R) after deployment.

### Workflow file location
The workflow lives in `dist/.github/workflows/deploy.yml` (yes, inside the dist folder, because the deploy repo IS the dist folder).

## 5. UI Structure (dist/index.html)

Key DOM elements:
- `#device-list` — sidebar container for device cards
- `#welcome-msg` — placeholder when no devices
- `#inspector-section` — main content area (hidden until device selected)
- `#shell-input` + `#shell-output` — ADB shell panel
- `#props-output` — system properties table
- `#features-output` — device features list
- `#packages-output` — installed packages list
- `#attestation-output` — key attestation status
- `#rkp-output` — RKP (Remote Key Provisioning) status
- `#csr-output` — CSR (Certificate Signing Request) display
- `#probe-output` — attestation probe results
- `#probe-debug-logcat` — debug logcat for probe
- `#header-version` — version badge in header
- `#font-size-controls` — A-/A+ buttons

### Device card layout
Connected: `[Device Name] [Serial] [Disconnect button]`
Available:  `[Device Name] [Serial] [Connect button]`
Selected device card has highlighted border.

## 6. Features

| Feature | Function | Description |
|---------|----------|-------------|
| System Properties | `fetchProperties()` | `adb.getProp()` full dump, searchable, JSON export |
| Features | `fetchFeatures()` | `adb.features()`, SDK feature classification |
| Packages | `fetchPackages()` | `dumpsys package` parser (primary) + `pm list packages` fallback |
| Attestation | `fetchAttestation()` | Verified Boot, VBMeta, DM-Verity, Flash Lock, KeyMint, StrongBox |
| CSR | `fetchCSR(slot)` | KeyMint CSR via `cmd identity get_csr` |
| RKP | `fetchRKP()` | Google server ping, KeyMint provider, HAL service checks |
| Shell | `runShell()` | Custom ADB shell commands |
| Probe | `runAttestationProbe()` | Ships APK to device, runs probe, retrieves results |
| JSON Export | `exportJSON()` | CTS-compatible `DeviceInfo.deviceinfo.json` |
| Nicknames | `setNickname()` | Persistent device nicknames (localStorage) |
| Font Size | `changeFontSize()` | Text scaling (localStorage) |

## 7. Known Bugs and Fixes

### v1.1.42 (current) — FIXED
- `pipeTo` error: `connectAvailable()` was passing raw `USBDevice` to `AdbDaemonTransport.authenticate()` as `connection` parameter. Fix: use `getDevices()` + pass matching device to `connectDevice()` which handles `connect()` -> `USBConnection` properly.

### v1.1.41 — pipeTo error (superseded by 1.1.42)
- Attempted to fix by using `mgr.requestDevice()` from `connectAvailable()`. Still caused pipeTo error because `connectDevice()` expects a USBDevice it can call `.connect()` on, but the picker flow was not properly wired.

### v1.1.40 — disconnect handler key mismatch
- `disconnectOne()` moved device to availableDevices with key format `serial || vid:pid:timestamp`
- `scanAvailableDevices()` used `serial || vid:pid:timestamp`
- Mismatch caused duplicate entries. Fixed by aligning key formats.

### Historical patterns
- **WebUSB device references are transient**: `getDevices()` returns fresh objects each time. Never cache `usbDevice` across connections — always re-acquire via `getDevices()` or `requestDevice()`.
- **ADB serial vs USB serial**: `adb.serial` comes from USB device, `ro.serialno` may differ. Always use `adbSerial` (from `ro.serialno` if available) as the Map key in `connectedDevices`.
- **Heartbeat must use ADB protocol, not raw USB**: `usbDevice.controlTransferOut` was unreliable. Current approach: `adb.getProp('ro.build.id')` with 1s timeout, 3s interval.

### Current disconnect handler issues
- Physical unplug detection relies on `navigator.usb.addEventListener('disconnect', ...)`. This fires reliably in Chrome/Edge.
- The handler matches by `_usbId.serial` first, then `vid+pid`. If two identical devices (same vid:pid, no serial) are present, matching may be ambiguous.
- After physical unplug, `scanAvailableDevices()` runs on the next USB connect event and may re-add devices. This is correct behavior — only re-adds if the device is physically present again.

## 8. Debugging Commands

```bash
# Check WebUSB status in browser console
navigator.usb.getDevices()

# View connection state
connectedDevices.size
availableDevices.size
for (const [k,v] of connectedDevices) console.log(k, v._usbId)

# Force re-scan
scanAvailableDevices()

# Check disconnect handler is registered
_usbDisconnectHandler !== null

# Deploy
cd /home/ethan/projects/web-adb-inspector
node build.mjs
git add -A && git commit -m "message" && git push
gh workflow run --repo Ethanhsu/Ethanhsu.github.io "Build and deploy from web-adb-tool"

# Verify deployment
sleep 45
curl -sL "https://Ethanhsu.github.io/index.html" | grep 'bundle.js?v='
```

## 9. File Structure

```
/home/ethan/projects/web-adb-inspector/
├── .gitignore
├── .github/           (NOT present — workflow is in dist/.github/)
├── ATTESTATION_DEBUG_JOURNAL.md  — debug notes for attestation feature
├── NOTICE.md          — third-party notices
├── PROJECT_CONTEXT.md  — THIS FILE
├── README.md          — user-facing documentation
├── apk/               — attestation-test.apk (debug-signed)
├── build.mjs          — esbuild config
├── dist/
│   ├── .github/workflows/deploy.yml  — CI/CD pipeline
│   ├── index.html     — served by GitHub Pages
│   ├── bundle.js      — production bundle
│   └── bundle.js.map  — sourcemap
├── node_modules/
├── package.json
├── package-lock.json
└── src/
    └── index.js       — ALL application code (~2050 lines)
```

## 10. Important Conventions

- **All code in src/index.js**: No modules, no components. Single IIFE bundle.
- **Map keys for connectedDevices**: Use ADB serial (from `ro.serialno` if available, else `adb.serial`)
- **Map keys for availableDevices**: Use USB serial or `vid:pid:timestamp` fallback
- **_usbId is mandatory**: Every entry in both maps must have `_usbId: { vendorId, productId, serial }` for disconnect matching
- **renderDeviceList() after any state change**: Always call after modifying connectedDevices or availableDevices
- **activeSerial tracking**: Update when devices are removed. If activeSerial points to a deleted device, switch to next available or null.
- **Error handling**: `msg.includes('already in use')` -> show ADB release dialog
- **Cache-bust param**: Update `dist/index.html` `?v=` param before each commit

## 11. yume-chan Library Notes

- `AdbDaemonWebUsbDeviceManager.BROWSER` — null if WebUSB not supported. Check before use.
- `AdbDefaultInterfaceFilter` — standard ADB interface filter for device picker.
- `AdbWebCredentialStore` — persists ADB auth keys in localStorage/browser keychain.
- `AdbDaemonTransport.authenticate()` — takes `{ serial, connection, credentialStore, features, initialDelayedAckBytes }`. `connection` must be a `USBConnection` from `usbDevice.connect()`, NOT a `USBDevice`.
- `connection.closed` — Promise that resolves when USB connection closes. Use for disconnect detection.

## 12. Session Recovery Checklist

When starting a new session on this project:
1. Read this file first
2. Check current version: `grep APP_VERSION src/index.js`
3. Check git status: `git status && git log --oneline -5`
4. Check deployment status: `curl -sL "https://Ethanhsu.github.io/index.html" | grep 'bundle.js?v='`
5. If code changes needed: edit `src/index.js` → `node build.mjs` → update cache-bust in `dist/index.html` → commit → push → trigger workflow

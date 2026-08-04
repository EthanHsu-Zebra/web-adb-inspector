# Web ADB Inspector — Project Context (Complete Handover)

Last updated: 2026-08-04
Current version: v1.2.0

## 1. Project Overview

Browser-based Android device inspector using **WebUSB + ADB protocol**. Runs 100% client-side — no server, no ADB installed on host. Now also supports **remote-shared sessions** (see §13): a second user, anywhere, with just a browser, can view live device status and run approved shell commands against the host's physically-connected device via WebRTC.

- Source repo (upstream): `Ethanhsu/web-adb-inspector` (public)
- This fork: `EthanHsu-Zebra/web-adb-inspector` — self-deploys directly to its own GitHub Pages (no separate deploy repo)
- Local working directory: `C:\Users\nqx678\OneDrive - Zebra Technologies\VSCodeProject\web-adb-inspector`

### Core Dependencies (package.json)
- `@yume-chan/adb` ^2.6.0 — ADB protocol library
- `@yume-chan/adb-daemon-webusb` ^2.3.2 — WebUSB transport for ADB daemon
- `@yume-chan/adb-credential-web` ^2.1.0 — ADB credential store (localStorage-backed)
- `@trystero-p2p/nostr` ^0.25.3 — serverless WebRTC room signaling (Nostr relays) for remote sessions
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

### Flow (self-contained — no separate deploy repo, unlike upstream)
```
EthanHsu-Zebra/web-adb-inspector (master) --push--> GitHub Actions (.github/workflows/deploy.yml)
  --> npm ci + node build.mjs
  --> actions/upload-pages-artifact (dist/)
  --> actions/deploy-pages --> GitHub Pages serves this repo's own Pages site
```
Live URL: `https://ethanhsu-zebra.github.io/web-adb-inspector/`
One manual, non-code prerequisite: repo Settings → Pages → Source = "GitHub Actions".

### Trigger deployment
Just push to `master` (or `workflow_dispatch` from the Actions tab). No cross-repo `gh workflow run` needed anymore.

### Verify deployment
```bash
curl -sL "https://ethanhsu-zebra.github.io/web-adb-inspector/index.html" | grep -oP 'bundle\.js\?[^\"]+'
```

### Cache-busting
`dist/index.html` contains `<script src="bundle.js?v=YYYYMMDDNN">`.
- The build script does NOT auto-update this — manually edit `dist/index.html` before commit.
- Users must hard refresh (Ctrl+Shift+R) after deployment.

### Workflow file location
Top-level `.github/workflows/deploy.yml` in this fork (the legacy `dist/.github/workflows/deploy.yml`, which targeted the old cross-repo flow, has been removed).

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
node build.mjs
# then manually bump the ?v= cache-bust param in dist/index.html
git add -A && git commit -m "message" && git push
# GitHub Actions builds + deploys to Pages automatically on push to master

# Verify deployment
sleep 45
curl -sL "https://ethanhsu-zebra.github.io/web-adb-inspector/index.html" | grep 'bundle.js?v='
```

## 9. File Structure

```
web-adb-inspector/  (this fork)
├── .gitignore
├── .github/workflows/deploy.yml  — self-contained Pages CI/CD (checkout -> build -> deploy-pages)
├── ATTESTATION_DEBUG_JOURNAL.md  — debug notes for attestation feature
├── NOTICE.md          — third-party notices
├── PROJECT_CONTEXT.md  — THIS FILE
├── README.md          — user-facing documentation
├── apk/               — attestation-test.apk (debug-signed)
├── build.mjs          — esbuild config
├── dist/
│   ├── index.html     — served by GitHub Pages (built dist/ is deployed as the Pages artifact)
│   ├── bundle.js      — production bundle
│   └── bundle.js.map  — sourcemap
├── node_modules/
├── package.json
├── package-lock.json
└── src/
    └── index.js       — ALL application code (~2400+ lines, incl. Remote Session, §12)
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

## 12. Remote Session (WebRTC sharing)

Lets a second user (viewer), anywhere, with just a browser, join a session a host creates and (once approved/trusted) run adb shell commands against the host's connected device. Fully peer-to-peer — no server of ours; signaling goes over public Nostr relays via `@trystero-p2p/nostr`'s `joinRoom({appId, password}, roomId)`.

### State
`remoteSession` (module-level, `src/index.js`) — either `null`, a host session (`{role:'host', room, roomId, password, trusted, viewers:Set, actions, pendingApprovals:Map}`), or a viewer session (`{role:'viewer', room, roomId, password, hostPeerId, actions, pendingRequests:Map, mirror:{activeSerial, connected[], available[]}}`).

### Host flow
1. `startShareSession()` — generates roomId/password (`crypto.getRandomValues`), joins a trystero room, wires up actions, shows the share modal (`showShareModal()`, built at runtime like `showDevicePicker()`).
2. `renderDeviceList()` has a single hook (`if (remoteSession?.role === 'host') broadcastDeviceState();`) that pushes a serializable device snapshot to all viewers on every state change — this is what keeps requirement "viewer sees live connect/disconnect" in sync, without touching every call site.
3. Incoming `cmdRequest` from a viewer → `handleRemoteCmdRequest()`. If `remoteSession.trusted` is false (the default, every session), it queues in `pendingApprovals` and shows a banner (`#remote-approval-bar`) with Approve/Deny. Either path funnels into `executeRemoteShell()`, which calls the **same unmodified `adbShell()`** used by the local `runShell()` — no duplicated shell logic.

### Viewer flow
1. A link `#room=<id>&key=<password>` — the URL fragment is never sent to any server. `initRemoteViewerIfLinked()` (called from `init()`) detects it and calls `joinAsViewer()`, which skips WebUSB entirely (`isViewerMode()` guards the page-load `scanAvailableDevices()` call and the `navigator.usb` `connect` listener).
2. `renderMirrorDeviceList()` mirrors the host's device list into the same `#device-list`/`#welcome-msg` sidebar elements the host UI uses (read-only, no connect/disconnect buttons) — reuses existing CSS rather than a parallel UI.
3. `#viewer-shell-section` is a dedicated remote-shell panel; `sendRemoteCommand()` sends a `cmdRequest` to the host and `handleCmdResponse()` renders the result once approved.
4. All three inbound viewer listeners (`devicePush`, `cmdResponse`, `bye`) check `ctx.peerId === remoteSession.hostPeerId` before acting — without that, a second peer in the same room could spoof messages to another viewer (trystero has no built-in sender-role enforcement).

### Known limitations (v1) / debugging history
- `REMOTE_TURN_CONFIG` (near `remoteSession` state) wires in the free/shared Open Relay Project TURN servers (incl. a 443/TCP option) as a fallback when direct STUN-only P2P fails. Open Relay's servers are free/shared and rate-limited — fine for personal/team use, not a production SLA.
- **Cross-network debugging saga (2026-08-04) — root cause: relay overlap, not a firewall block.** A host on a corporate network repeatedly showed zero `WebRTC peer joined` events while two independent remote viewers instead found *each other* (trystero rooms are a full mesh). Investigation went through several wrong turns before landing on the real cause:
  1. First hypothesis: corporate web filter blocking Nostr relay signaling outright. Pinned `relayConfig` to 4 well-known relays (`relay.damus.io`, `nos.lol`, `relay.nostr.band`, `relay.snort.social`) to test this.
  2. That surfaced a *different* problem: a plain `wss://echo.websocket.org` test proved WebSocket itself was never blocked, and the console showed `Trystero: relay failure from wss://relay.damus.io/ - rate-limited` — our own repeated test cycles had concentrated load onto just 4 relays and tripped their abuse protection. Reverted the pin back to the library default (5 random relays from its ~47-relay pool per `joinRoom()` call) to stop self-inflicting rate limits.
  3. That reverted default then failed *identically on both host and viewer* — both consoles showed `WebSocket connection to 'wss://relay.nostrdice.com/' failed` and `wss://hol.is` failed. Same two dead relays on two unrelated networks meant those two relays were just down/unreliable — not a client-side or firewall issue.
  4. The actual root cause: `joinRoom()`'s default behavior has each side **independently** pick 5 random relays out of the 47-relay pool. For two peers to find each other they need at least one relay in common — with independent random 5-of-47 draws, there's roughly a 50%+ chance of *zero* overlap between host and viewer on any given attempt. That fully explains the inconsistent behavior throughout this investigation.
  - **Fix**: `REMOTE_RELAY_URLS` pins both host and viewer to the same fixed list of 8 relays across different operators (`relay.damus.io`, `nos.lol`, `relay.nostr.band`, `relay.snort.social`, `relay.primal.net`, `purplerelay.com`, `communities.nos.social`, `relay.mostr.pub`) with `redundancy` set to try all 8 — guaranteeing overlap (same list on both sides) while being large enough that 2-3 flaky/rate-limited relays don't matter. `warnOnRelayFailure: true` stays on so relay-level issues keep surfacing in the console.
- Lesson for future debugging here: a "stuck connecting" / "0 peers joined" symptom is NOT reliable evidence of a firewall block by itself — check the browser console for explicit relay-level messages (`rate-limited`, `failed`) on *both* sides before assuming network-level blocking, and avoid rapid repeated `joinRoom()` test cycles against a small relay set (self-inflicted rate-limiting looks identical to a real block from the app's own logs).
- "Trust this session" auto-approves commands from *any* peer currently in the room, not just the original viewer — the approval gate, not viewer identity, is the real safety control.
- Viewer mirror only covers the device list + shell — Properties/Features/Packages/Attestation tabs are not (yet) mirrored to viewers.
- **Final resolution (2026-08-04): switched off public Nostr relays entirely, to a self-hosted signaling relay.** After the relay-pinning fix still failed cross-network testing (confirmed via `pollIceState()` diagnostic — zero `RTCPeerConnection` objects were ever created on either side, ruling out ICE/TURN and pointing squarely at signaling never succeeding — plus a renewed `rate-limited` message from `relay.damus.io`, meaning even the pinned 8-relay list was degraded from cumulative testing), the decision was to self-host: `relay-server/` is a small Node service using `@trystero-p2p/ws-relay`'s server helper (`createWsRelayServer`), deployed on Render.com's free tier at `wss://web-adb-inspector-relay.onrender.com`. The client (`src/index.js`) now imports from `@trystero-p2p/ws-relay` instead of `@trystero-p2p/nostr`, with `REMOTE_RELAY_URLS` pointing at that single URL. This removes rate-limiting, relay-overlap odds, and third-party downtime as failure modes entirely — the relay is dedicated to just this app.
  - **Real bug hit and fixed during this build**: `createWsRelayServer(options)` destructures as `const {onError, ...wsOptions} = options`, spreading the *rest* directly into `new WebSocketServer(...)`. So `server`/`port` must be top-level keys in the options object passed to `createWsRelayServer()` — nesting them under a `wsOptions: {...}` sub-key (an easy mistake to make from the API's internal variable name) silently creates an unrelated default WebSocketServer on port 8080 instead of attaching to the intended HTTP server. Caught via a local smoke test (HTTP health check succeeded, but a real WebSocket client got "Unexpected server response: 200" instead of a 101 upgrade) — see `relay-server/server.js` for the fixed version and the comment explaining it.
  - Render free tier spins down after 15 min idle (~30-50s cold-start on the next connection) — a known, accepted tradeoff for zero-cost hosting.
  - **Debugging tool note**: don't use bare Node.js (`node -e` scripts, etc.) to test HTTPS/WSS connectivity from a corporate-network machine as a proxy for what the browser will experience — Node bundles its own CA list and does NOT read the OS/browser certificate store, so it can fail TLS validation (`unable to get local issuer certificate`) against a corporate TLS-inspecting proxy even when the actual browser (which does trust the OS cert store, like PowerShell's `Invoke-WebRequest`) would succeed fine. This produced a red-herring failure while validating the Render deployment.

## 13. Session Recovery Checklist

When starting a new session on this project:
1. Read this file first
2. Check current version: `grep APP_VERSION src/index.js`
3. Check git status: `git status && git log --oneline -5`
4. Check deployment status: `curl -sL "https://ethanhsu-zebra.github.io/web-adb-inspector/index.html" | grep 'bundle.js?v='`
5. If code changes needed: edit `src/index.js` → `node build.mjs` → update cache-bust in `dist/index.html` → commit → push (Pages deploys automatically via `.github/workflows/deploy.yml`)

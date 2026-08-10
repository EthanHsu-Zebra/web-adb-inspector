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
Connected: `[checkbox] [Device Name] [Serial] [Disconnect button]`
Available:  `[checkbox] [Device Name] [Serial] [Connect button]`
Selected device card has highlighted border.

### Bulk select (v1.4.0)
Each card has a checkbox (`toggleDeviceSelection('connected'|'available', serial)`), tracked in two independent `Set`s: `selectedConnectedSerials`, `selectedAvailableSerials`. When either has 1+ entries, its section's bulk bar (`#connected-bulk-bar` / `#available-bulk-bar`) shows a count and a "Disconnect Selected"/"Connect Selected" button (`disconnectSelected()`/`connectSelected()`), which just loop `disconnectOne()`/`connectAvailable()` over the selected serials — no new connect/disconnect logic, just batches the existing per-device functions. `renderDeviceList()` prunes both sets of any serial no longer present in its map (e.g. after a physical unplug) before rendering, so counts never go stale, and calls `updateBulkBars()` at the end of every render.

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

### v1.8.0 — Tab-key path completion, host + viewer; clarified the `ls -l` `?????????` question
Two things came out of the same user report.

**The `?????????` columns in `ls -l /sys/power`** are not a bug in this tool — `adb shell` on a non-rooted/userdebug build runs as the unprivileged `shell` user, and `ls -l` prints that placeholder for any entry it can't `stat()` (common for sysfs nodes owned by `root` with restrictive permissions). Running the exact same `ls -l /sys/power` from a real terminal's `adb shell` shows identical output — nothing our command-wrapping changes. Worth documenting here since it's likely to come up again.

**Tab completion**, actually a feature gap: added `runTabCompletion()` (`src/index.js`, shared by both shells) — on Tab, it takes whatever path-looking word sits before the caret, splits it into a directory part and a name prefix, asks for a directory listing, and either completes to the single match (adding a trailing space for files, not directories) or to the longest common prefix across multiple matches (classic shell behavior; a second Tab press to list all candidates was **not** implemented — out of scope for now).
- Host Shell tab: `completeShellPath()` calls `adbShellTimed` directly with `ls -1Ap '<dir>'` (reusing `wrapWithCwdTracking`/`extractCwdMarker` so the listing resolves against the tracked cwd) — no round-trip needed, it already has the `adb` object.
- Remote shell: the viewer doesn't have device access, so this needed a new signaling round-trip. Added two more trystero actions, `pathComplete` (viewer→host) and `pathCompleteResult` (host→viewer) — `handlePathCompleteRequest()` runs the same `ls -1Ap` listing keyed by the same per-(peerId, serial) `viewerCwd` map `executeRemoteShell()` already tracks. Deliberately **not** gated by the trust/approval setting — it's a read-only directory listing triggered by a keypress, not command execution a user explicitly asked to run; approval-gating this would mean an approval prompt firing on every Tab press for untrusted sessions, wrecking the point of autocomplete.
- Both inputs' `onkeydown` now go through `handleShellKeydown()`/`handleViewerShellKeydown()` (still handle Enter as before) instead of inline `if(event.key==='Enter')...`.

### v1.7.1 — fixed extractCwdMarker() finding the wrong marker occurrence
v1.7.0 shipped `cd` tracking that didn't actually track anything: `pwd` after `cd storage` still reported `/`, and the raw `@@ADBWEB_CWD@@<path>` marker text leaked straight into the visible console instead of being stripped. Root cause: `extractCwdMarker()` used `lastIndexOf(CWD_MARKER)` to find "the" marker, but the wrapped command emits *two* adjacent copies of it (`'<MARKER>' "$PWD" '<MARKER>'`, no separator between the path and the closing one) — `lastIndexOf` landed on the closing copy, so the visible "text" slice (everything before that index) still included the opening copy plus the path, and the "cwd" slice (everything after) was just trailing whitespace, which parsed to empty and silently fell back to `null` — so the tracked directory never advanced past its initial state. Fixed by using `indexOf` for the first marker and searching for the second occurrence starting *after* it, so the path between them is what gets extracted and both marker copies are correctly excluded from the visible text.

### v1.7.0 — persistent-feeling `cd` and a visible current-directory prompt, host + viewer
Every `adb shell <cmd>` call is a brand-new process with no memory of the last one, so `cd /sdcard` typed into either Shell tab did nothing to the *next* command — a real, longstanding usability gap the user called out directly ("extremely restricts the usage").

Faked persistence rather than opening an actual interactive/PTY session (`sp.pty()` exists in `@yume-chan/adb` but would mean a much bigger rewrite of the one-shot request/response model both shells use): every command sent to the device is wrapped as `cd '<last-known-dir>' 2>/dev/null\n<user command>\nprintf '\n%s%s%s\n' '<MARKER>' "$PWD" '<MARKER>'` (`wrapWithCwdTracking()`/`extractCwdMarker()`, `src/index.js`, next to `adbShell`/`adbShellTimed`). Because it's one shell invocation, the user's own `cd` (or `pushd`, or whatever) takes effect before the trailing `printf`, so `$PWD` always reflects wherever the command actually left the shell — that becomes the tracked directory for the *next* command. No special-casing of `cd` as a command was needed; this works for anything that changes directory.

Verified the round-trip is safe through `@yume-chan/adb`'s `splitCommand()`/`command.join(" ")` (client-side space-tokenize, then rejoin before sending as the `shell,v2,raw:` service string) — since the wrapped command only ever has single spaces between tokens and embeds real newlines *inside* tokens (newline isn't a delimiter to that tokenizer), split+rejoin round-trips it byte-for-byte, so the device's `sh -c` sees exactly the multi-statement script intended.

- Host's local Shell tab: `dataCache.cwdBySerial[serial]`, updated in `runShell()`, displayed via `updateShellCwdLabel()` (`#shell-cwd`, restored on `selectDevice()` device-switch alongside the existing `shellBySerial` restore).
- Remote shell: host tracks cwd **per (viewer peerId, serial)** in `remoteSession.viewerCwd` (a `Map`) inside `executeRemoteShell()`, so two viewers (or a viewer and the host's own local session) don't stomp each other's directory. The resolved cwd rides back on `cmdResponse.cwd`; the viewer stores it in `remoteSession.mirror.cwdBySerial[serial]` and shows it via `updateViewerCwdLabel()` (`#viewer-shell-cwd`), refreshed on every `renderMirrorDeviceList()` call so it stays correct across device switches too.
- Both echoed prompt lines now show the directory the command actually ran in (`<dir> $ <cmd>` on host, `[device] <dir> $ <cmd>` on viewer) instead of a bare `$`.
- Found and fixed, in passing: a literal NUL byte (0x00) had ended up in `src/index.js` in place of an intended space character while authoring this change (`peerId + ' ' + serial`) — `esbuild` bundled it without complaint (NUL is valid inside a JS string literal), so it would've shipped silently. Caught it because `Grep`'s content mode refuses to print through a NUL and says so explicitly; patched the single byte back to `0x20` and confirmed no other occurrences in the file. Worth remembering as a sanity check if a grep unexpectedly reports "binary file matches" in this text-only source file again.

### v1.6.1 — per-device shell consoles on both host and viewer
Following up on v1.6.0's "no state bug found" conclusion for the device-switch report: the user clarified what they actually wanted — each device should have its *own* console (matching what the host's local Shell tab already did via `dataCache.shellBySerial`), not one shared scrolling log that all devices write into. The host side already worked this way (`selectDevice()` saves/restores `dataCache.shellBySerial[serial]` on switch); the viewer side never had it — `#viewer-shell-output` was one continuous buffer regardless of which mirrored device was active.

Added the same pattern to the viewer:
- `remoteSession.mirror.shellBySerial` (per-viewer-session object, keyed by serial) mirrors `dataCache.shellBySerial`.
- `switchMirrorShellOutput(oldSerial, newSerial)` saves the outgoing device's visible `#viewer-shell-output` text into its slot and loads the incoming device's slot (or empty, if none yet) — called from the new `selectMirrorDevice(serial)` (now what the device-card `onclick` calls) and from `renderMirrorDeviceList()`'s existing auto-fallback branch (covers the initial pick and the "active device disappeared" case, not just explicit clicks).
- `sendRemoteCommand()` now records the target `serial` alongside `cmd` in `pendingRequests`, so `handleCmdResponse()` can route a late-arriving response to the *device it was actually for* — if the viewer already switched away by the time the response arrives, it's stashed straight into that device's `shellBySerial` slot instead of bleeding into whatever's currently on screen.
- `clearViewerShell()` only clears the currently active device's slot, not the others.
- Host side got the equivalent fix for remote-issued commands: `executeRemoteShell()` used to only append `[remote] $ ...` output to `#shell-output` if the targeted device happened to be the host's *currently selected* one — otherwise that history was dropped entirely. Now every remote command's output is appended to `dataCache.shellBySerial[serial]` unconditionally (and to the live DOM too, if that device happens to be selected), so switching to that device's Shell tab later still shows what the remote viewer ran against it.

### v1.6.0 — remote sessions default to trusted; fixed non-terminating commands (e.g. bare `logcat`) hanging forever
Three changes, all in the remote-shell path:
- **Trust by default.** `remoteSession.trusted` now starts `true` (was `false`), and the share modal's "Auto-run commands" checkbox is checked by default. The per-command approval gate (`showApprovalPrompt`/`approveRemoteCommand`/`denyRemoteCommand`) still exists — unchecking the box re-enables it — but the user only shares the link with people they already trust, so requiring a click per command added friction with no real safety benefit for that use case.
- **Root cause found for "viewer stuck on `(pending host approval...)` forever for `logcat` but other commands work fine."** `executeRemoteShell()` called `adbShell()`, which uses `@yume-chan/adb`'s `spawnWaitText()` — it waits for the shell process to *exit* before resolving. A bare `logcat` (no `-d`/`-t`) never exits; it streams until killed. So the host-side `await` never returned, no `cmdResponse` was ever sent, and the viewer's optimistic "pending" placeholder (set immediately on send, before any approval/execution happens) just sat there unchanged — regardless of whether the command had been approved. This wasn't approval-specific at all; short-lived commands "worked" simply because they returned quickly enough not to notice.
  - Fix: added `adbShellTimed(adb, cmd, timeoutMs)` (`src/index.js`, next to `adbShell`) which spawns via `sp.spawn(cmd, signal)` directly (instead of `spawnWaitText`), races it against a timeout, and on timeout aborts the `AbortSignal` + calls `process.kill()` before throwing a clear error naming the timeout and suggesting `logcat -d` / `logcat -d -t 200`. `executeRemoteShell()` now calls this with a 20s timeout instead of `adbShell()`. Local shell (`runShell()`) is untouched — same underlying risk exists there too, but wasn't reported and wasn't in scope.
  - Needed a new direct dependency: `@yume-chan/stream-extra` (`TextDecoderStream`, `ConcatStringStream`) — previously only pulled in transitively.
- **Added a visible remote-shell target indicator** (`dist/index.html` `#viewer-shell-target`, updated in `renderMirrorDeviceList()`) showing which device the Remote Shell panel is currently pointed at, and each command line in the output now echoes `[device] $ command`. This was added defensively while investigating a separate report ("clicking device B while viewing device A's shell still sends to A") — code review of `renderMirrorDeviceList()`'s card `onclick` and `sendRemoteCommand()`'s read of `remoteSession.mirror.activeSerial` didn't turn up an actual state bug (the click handler sets `activeSerial` before re-rendering, and the guard that could override it only fires when the serial is missing or no longer connected), so the leading theory is that the *lack of any on-screen confirmation* of the active target was the real problem, not a logic bug. Revisit with viewer-side debug logs if switching still misbehaves after this.

### v1.5.9 — removed the in-app "Forget" button
Given the extensive v1.4.2-v1.5.8 investigation consistently traced the whole "connection fails repeatedly, only a reload recovers it" saga back to un-pairing + re-pairing specifically (an already-established device reconnects reliably; a freshly forgotten-then-re-paired one is what reliably triggers the stuck state), removed `forgetDevice()` and its "Forget" button entirely — it was a reliable trouble-maker for a fairly niche use case (deliberately testing the first-time-connection flow). `showHelpModal()`'s "Un-pairing a device" entry now documents the manual browser-native way to do this instead (page-info icon → Site settings → USB devices → remove), with an explicit warning about the known stuck-connection risk and that a Reload button will appear if it happens. This doesn't fix the underlying issue (v1.5.8's `reset()` addition and the possible future iframe-isolation approach are the paths for that) — it just removes the easy, tempting in-app trigger for it.

### v1.5.8 — try USBDevice.reset() (a real bus-level reset) as a cheaper alternative to the iframe-isolation idea
Before committing to a same-origin-iframe "mini-reload" architecture (a real but complex/uncertain option — discarding any browsing context, not just the top-level page, triggers the same WebUSB cleanup per spec, so a disposable iframe per connection attempt could in principle avoid needing a full page reload), tried the cheaper option first: `USBDevice.reset()`. Unlike `open()`/`close()` (which only manage the *browser's logical claim/handle*), `reset()` performs an actual USB-protocol-level bus reset — the software equivalent of physically unplugging and replugging the device. Added it to both existing cleanup points:
- The pre-emptive cleanup before every attempt (v1.5.6): now `open()` → `reset()` → `close()` (each independently best-effort; `reset()` requires the device to already be `opened`, hence `open()` first) instead of just `close()`.
- The post-failure catch-block cleanup (v1.5.5, for when `usbDevice.connect()` succeeds but a later step fails): now `reset()` before `close()`, instead of just `close()`.

Not yet confirmed whether this resolves the issue — if it doesn't, the next step is the iframe-isolation approach, or accepting the v1.5.7 one-click Reload button as the practical answer going forward.

### v1.5.7 — accepted this can't be fixed purely in-page; added a one-click Reload
v1.5.6's pre-emptive `close()`-before-every-attempt *also* didn't recover it — confirmed the exact same "Failed to execute 'open'... device was disconnected" error persisted through a full 7-attempt retry cycle even with that in place. That result actually rules out the "still open from a previous attempt" theory entirely: an unconditional `close()` before every attempt, including the very first, should clear any such state if that were the real cause, and it didn't.

Revised (final, for now) theory: this is most likely a problem inside the browser's own per-page WebUSB bookkeeping, not in anything our device-object handling can reach. Chrome/Edge's WebUSB implementation is backed by a connection between the page and the browser's internal USB service for each device; if that gets into a bad state, `getDevices()` calls within the *same page* may keep handing back references tied to that same broken internal state no matter how many times it's re-fetched or how carefully `open()`/`close()` are sequenced from script. Only an actual page reload tears down and re-establishes that connection — which matches every observation throughout this entire investigation: hard refresh has been 100% reliable; nothing else has, including several different open/close strategies.

Given that, no further in-page JS retry/cleanup logic is expected to fix this — accepted this needs a real reload, and made that reload one click instead of manual: `showADBReleaseDialog()` is no longer a plain `alert()`; it's a proper modal (matching the existing Share/Help modal style) with a **Reload Page** button (`location.reload()`) alongside the existing troubleshooting guidance, shown whenever `isDeviceBusyError()` matches — which includes the final failure after all of `connectAvailable()`/`scanDevices()`'s retries are exhausted.

### v1.5.6 — v1.5.5 wasn't sufficient: pre-emptive close-before-open added
v1.5.5's cleanup only runs when `usbDevice.connect()` itself *succeeds* and a later step (almost always `AdbDaemonTransport.authenticate()`) fails afterward — it does nothing for `Failed to execute 'open' on 'USBDevice': The device was disconnected'`, since that error comes from the `open()` call itself rejecting, meaning `openedConnection` never becomes `true` and there's nothing for that catch-block cleanup to close. Confirmed this exact error still persisted across a full 7-attempt retry cycle (twice) even with v1.5.5 deployed — a hard refresh was still needed to recover.

Leading theory: the underlying `@yume-chan/adb-daemon-webusb` library's `connect()` sequence can partially succeed (the native `open()` call) before failing at a later *internal* step (e.g. claiming the interface) — without ever handing our code a connection object to close ourselves, since the overall `connect()` promise it returns still just rejects. That would leave the *native* device open from a previous attempt's perspective, and Chrome/Edge's WebUSB implementation apparently doesn't tolerate a second `open()` from the same page while that lingering state exists — causing the next attempt's `open()` to reject immediately with the same "disconnected"-sounding message. Only a full page reload (forcing the browser to release everything the page held) recovers, matching what's been observed throughout.

Fix: `connectDevice()` now unconditionally calls `await usbDevice.raw.close()` (ignoring any error) *before* every attempt, not just in a catch block after one already failed — clearing any lingering native-open state a previous attempt might have left, regardless of exactly which internal step that attempt failed at. This is a more defensive, "always start from a known-closed state" strategy layered on top of (not replacing) v1.5.5's after-the-fact cleanup.

If this *still* doesn't fully resolve it, the next step would be to test with `AdbDaemonWebUsbConnection`-level instrumentation (patching/logging inside `@yume-chan/adb-daemon-webusb` itself, or filing an upstream issue) to find exactly which internal step is leaking — this is about as much as can be fixed from the outside of that library without forking it.

### v1.5.5 — FIXED (likely the real root cause all along): leaked USB claim on failed connect never released
The actual smoking gun (2026-08-06): re-toggling "USB debugging" on the device (which re-triggers Android's authorization prompt, confirmed accepted) and re-pairing still failed all 7 retries (~44.5s) — but a hard refresh right after immediately succeeded. If the underlying block were external/timing-based (e.g. the CrowdStrike scan-window theory), more retrying *within the same page* should work just as well as after a refresh — external systems don't care whether the page reloaded. But a hard refresh does exactly one relevant thing: it force-releases every WebUSB claim held by that page. That pointed back at our own code.

Found it: `connectDevice()`'s catch block never closed the `connection` object (or the device) when `AdbDaemonTransport.authenticate()` failed *after* `usbDevice.connect()` had already succeeded (i.e. already claimed the USB interface). Every failed attempt — and there have been many, across this whole investigation — leaked a claimed interface that the browser kept associated with the page for its entire remaining lifetime. Retrying with a freshly-refetched device object doesn't help, because the leak isn't about *which device object* you hold, it's an OS-level claim the page never released. Only a full reload (which the browser cleans up on unload) clears it — which is the entire explanation for "hard refresh reliably fixes it" observed throughout this investigation, and likely means the CrowdStrike/endpoint-security theory (while plausibly still a contributing factor for the *first* failure in a sequence) was mostly a red herring for why retries kept failing afterward — each retry was doomed by the leak from the *previous* attempt, not by an external block.

Fix: `connectDevice()` now tracks whether `usbDevice.connect()` succeeded (`openedConnection`), and if a later step throws, calls `usbDevice.raw.close()` (the standard native `USBDevice.close()`, not anything yume-chan-specific — closing the device is what actually releases the OS-level claim) before returning `false`, wrapped in its own try/catch so a failure to close doesn't mask the original error.

### v1.5.4 — retry logic reaches the initial "+Connect Device" picker path too; widened further; confirmed not device-specific
Follow-up (2026-08-06) to v1.5.3. Two important refinements:

1. **It's not FR55-specific.** Forgetting and freshly re-pairing TC201 (previously 100% reliable) reproduced the exact same failure. The real trigger is "freshly `forgetDevice()`'d + re-paired via the picker" for *any* device, not a policy block on one specific VID — an already-established connection reconnects fine regardless of which device. This is a stronger fit for the CrowdStrike-scan-window theory (a fresh permission grant looks like a "newly attached" event worth (re-)scanning) than a per-VID deny policy (which would fail identically regardless of how long you wait).
2. **`scanDevices()` (the "+Connect Device" native-picker path) had zero retry logic at all** — only `connectAvailable()` (the "Ready to Connect" reconnect path) retried. So a fresh pairing's first (and only) attempt failing required the user to notice it landed in "Ready to Connect" and manually click Connect there to reach the retry-capable path — observed directly: "it doesn't connect automatically hence I have to click connect button."
3. **"Hard refresh fixes it" is misleading** — a refresh can't change anything at the USB/OS level (confirmed: VID is fixed hardware descriptor data, doesn't change). The refresh-plus-manual-retry cycle just takes real wall-clock time (10-30+ seconds), which is probably long enough for the transient block to clear on its own — i.e., retrying for that long automatically should have the same effect without the manual refresh.

Fix: extracted the retry-with-backoff loop out of `connectAvailable()` into a shared `connectWithRetries(mgr, usbId, firstDevice, onStatus)`, now used by *both* `scanDevices()` and `connectAvailable()` — `onStatus(label)` lets each caller show progress wherever makes sense (`scanDevices()` has no device card yet, so it updates the global status banner instead of a per-card status). Also widened `CONNECT_RETRY_DELAYS_MS` again, from `[1000, 2000, 3000, 5000, 8000]` (~19s) to `[1500, 3000, 5000, 8000, 12000, 15000]` (~44.5s, 7 total attempts) — closer to the real wall-clock time a manual hard-refresh-and-retry cycle was taking.

Also clarified for the user: `forgetDevice()`'s "Forget" and `showADBReleaseDialog()`'s "Release" are unrelated concepts that happen to share a word — `forget()` only revokes this browser's own WebUSB permission grant; the release dialog is about a *different* problem (something else on the OS holding the device open).

### v1.5.3 — widened retry window after a deep-dive into "Connection closed unexpectedly" / "device was disconnected"
Full investigation (2026-08-06) into the two USB connection failure messages that had been intermittently affecting one specific device (Zebra FR55, USB VID `0x05E0` PID `0x2106`) on one specific host, while another device (Zebra TC201, VID `0x05C6`) on the same host worked reliably:

- Ruled out: two-simultaneous-ADB-sessions contention (failed with `otherConnected=0` — the *other* device wasn't even connected).
- Ruled out: a full device-level lock or hardware fault — `chrome://usb-internals`'s own "Get Device Descriptor" test succeeded, returning a complete valid descriptor (manufacturer "Zebra Technologies", product "FR55", matching serial), and the ADB interface descriptor (Class 0xFF/Subclass 0x42/Protocol 0x01 — the standard ADB interface signature) looked normal.
- Notable finding: Windows Device Manager shows **CrowdStrike Device Control Sensor Interface** and **CrowdStrike Firmware Analysis Sensor Interface** installed on this host, and FR55 does not appear at all in Device Manager's "Devices by connection" tree (consistent with a filter/analysis driver intercepting it before normal PnP enumeration).
- Key data point that shaped the final theory: the *same* device, on the *same* host, sometimes connects successfully and sometimes doesn't — with the specific error varying between attempts. A hard, permanent policy block (e.g. CrowdStrike Device Control denying this VID outright) would fail identically every time regardless of retries; this intermittent, variable-duration pattern doesn't fit that.
- **Leading theory**: CrowdStrike's Firmware Analysis module briefly scans newly-attached/re-paired USB device firmware before releasing the device for normal OS/application use — a transient window of variable length, not a permanent deny. This is consistent with every observation: passive descriptor queries succeeding during the window, the device being invisible to normal PnP enumeration during it, TC201 (connected earlier, possibly already "trusted"/scanned) being unaffected, and a freshly-`forgetDevice()`'d-then-re-paired FR55 re-triggering a fresh scan (and thus the delay) each time.
- **Action taken**: widened `CONNECT_RETRY_DELAYS_MS` from `[1000, 2500, 4000]` (~7.5s total) to `[1000, 2000, 3000, 5000, 8000]` (~19s total, 6 attempts) — giving a potentially slower scan more room to finish before the app gives up. This is a workaround for a symptom, not a fix for the root cause.
- **If this theory is confirmed and the issue persists even with the wider window**: the actual fix is outside this app's control — it would need a CrowdStrike Falcon Device Control / Firmware Analysis policy exception for this device (VID `0x05E0`, PID `0x2106`) from IT/Security, since Falcon policy is managed centrally through the Falcon console, not locally.

### v1.5.2 — FIXED: card disappeared mid-retry + misleading "Failed" banner during retries
Two bugs found together, both from the v1.5.1 "keep the card visible during retries" change:
1. **Race with the disconnect handler.** When the device actually electrically drops during a failed attempt (confirmed — `findGrantedDevice()` briefly finds it missing from the granted list entirely, not just failing to open), the global native `'disconnect'` event fires and `handleUsbDisconnect()` matches it against `availableDevices` and deletes the entry — independently of, and racing against, `connectAvailable()`'s own retry loop still working on that same serial. Since v1.5.1 no longer removes the entry itself, this was the *only* remaining path that could delete it — and doing so orphaned the "Retrying..." card from the UI (an entry `connectingStatus` still had a status for, but that `renderDeviceList()` could no longer find in `availableDevices` to render). Fix: `handleUsbDisconnect()` now checks `connectingStatus.has(key)` before deleting an available-devices entry, in both its serial-match and vid+pid-fallback branches, and simply leaves it alone (returns) if a retry is in progress — `connectAvailable()`'s own logic already handles "device temporarily ungranted" correctly via its retry backoff.
2. **Misleading banner.** `connectDevice()` unconditionally showed "Failed: ..." in the global status banner on every failed attempt, including ones about to be automatically retried — looking like a permanent failure when it usually wasn't. `connectDevice(usbDevice, opts)` now takes `opts.silent` (suppresses the banner + `showADBReleaseDialog()` on failure) and `opts.onError(msg)` (still captures the message). `connectAvailable()`'s retry-managed attempts all pass `{silent: true, onError}`; only after every retry is exhausted does it show one accurate final status message (and the busy-device dialog, if the last error matches `isDeviceBusyError()`). The non-retried call sites (`scanDevices()`, and `connectAvailable()`'s picker-fallback STEP 2) are unaffected — they still get immediate, direct feedback since there's no retry to wait for.

### v1.5.1 — per-device "Connecting..." status UI + broader busy-device detection
`connectAvailable()` no longer deletes the device from `availableDevices` at the start of an attempt — the card now stays visible throughout, showing a live status (`connectingStatus: Map<serial, {attempt, total, label}>`, checked in `renderDeviceList()`'s available-card template) like "Connecting..." then "Retrying (2/4)..." instead of vanishing and only reappearing if every retry fails. Guarded against double-invocation (`if (connectingStatus.has(serial)) return;`) since the card no longer disappears to prevent an accidental second click.

Also: a new, distinct failure mode observed — `Failed to execute 'open' on 'USBDevice': The device was disconnected`, failing instantly (no point retrying) and affecting *every* device on the host, immediately after a `forgetDevice()` + re-pair cycle. Unlike the transient one-device-races-another issue above, this one didn't self-heal with retries. This error text is different from the `already in use` string the existing `showADBReleaseDialog()` trigger looked for, so that helpful dialog never showed despite likely being the same underlying problem (something else on the host holding the device — background `adb.exe`/ADB server, Android Studio, vendor device-management/sync software). Generalized the detection into `isDeviceBusyError(msg)`, matching `already in use`, `device was disconnected`, `failed to execute 'open'`, `unable to claim interface`, and `access denied`, used at both `connectDevice()` and `scanDevices()`'s catch blocks. Also broadened the dialog's own copy to mention checking for these other kinds of software, not just `adb.exe`.

Note: WebUSB's `requestDevice()` is single-device-per-call by design (no batch/multi-select picker) — pairing multiple *new* devices always requires one picker invocation each. Bulk actions (`connectSelected()`/`disconnectSelected()`) only batch already-paired devices.

### v1.5.0 — retry backoff tuning + Help modal + device-card layout fix
Further data (2026-08-06) on the "Connection closed unexpectedly" issue: it's not device-specific — in one trial TC201 failed as the second connect, in another FR55 failed as the second connect, with the other device succeeding first both times. Whichever device connects *second* while the other is already active is the one at risk. The v1.4.4 800ms single retry wasn't long enough in one case — the device didn't reappear in the granted list until ~1.86s after the failure. `connectAvailable()`'s retry is now backoff-based (1000ms, 2500ms, 4000ms — up to 3 retries) instead of a single 800ms attempt, and `connectDevice()` now logs the elapsed time of `usbDevice.connect()` and `AdbDaemonTransport.authenticate()` separately (plus how many *other* devices were already connected at start), to help pin down whether the failure happens at the raw USB-claim step or the ADB-handshake step next time it's investigated further. Root cause still not confirmed — next step if it recurs is checking Windows Device Manager's "devices by connection" tree (do the two ports actually share a root hub?) or checking for USB-filtering endpoint security software.

Also added: a **Help** button/modal (`showHelpModal()`) explaining what Connected / Ready to Connect / Connect / Disconnect / Forget / bulk-select / Share mean, in plain language, for a first-time user of the device list. And fixed device names/serials getting ellipsis-truncated in the 280px sidebar (especially once the checkbox + two action buttons were added to available cards) — `.device-card` is now a two-row layout (`.device-card-top`: checkbox + name/serial, full width; `.device-card-bottom`: status dot + action buttons, right-aligned below) instead of one cramped row, with `.dev-name`/`.dev-serial` wrapping instead of ellipsis-cutting, and the sidebar widened from 280px to 320px. All three places that build `.device-card` markup (connected, available, and the remote-viewer mirror in `renderMirrorDeviceList()`) needed updating together, since they all share the same CSS class.

### v1.4.4 — added: automatic retry for the "Connection closed unexpectedly" failure
Confirmed (2026-08-06, real hardware) this failure recurs even with the v1.4.3 400ms buffer between bulk connects, and even when the two devices are on physically separate USB ports (ruling out simple hub bandwidth contention as the sole cause). Root cause not fully understood — possibly host-controller/root-hub grouping behind the scenes even on "separate" ports, possibly endpoint security software, unconfirmed. Since the exact cause isn't nailed down, added a pragmatic mitigation: `connectAvailable()` now retries once automatically on failure, waiting 800ms and re-fetching a fresh device reference via `findGrantedDevice()` (a new shared helper) before retrying `connectDevice()` — WebUSB device references are transient, so retrying with the *same* object that just failed isn't reliable. If the retry also fails, the device is restored to "Ready to Connect" as before (v1.4.3). If this recurs even after the retry, the next step would be checking Windows Device Manager's "devices by connection" view to see if the two ports actually share a root hub, or checking for USB-filtering endpoint security software on the host.

### v1.4.3 — FIXED: bulk "Connect Selected" — a failed device vanished instead of returning to Ready to Connect
`connectDevice()` catches all its own errors internally (logs + status message) and never threw — so callers had no way to distinguish success from failure. Hit in practice with bulk-select: connecting two different physical devices back-to-back, the second failed with "Connection closed unexpectedly" (likely USB bus/hub contention from firing a second `connect()` immediately after the first succeeded) — `connectAvailable()` had already deleted it from `availableDevices` before attempting the connection, and since `connectDevice()` didn't signal failure, it never got restored. The device disappeared from both lists until an unrelated spontaneous `'connect'` event happened to trigger a rescan ~2s later — not a reliable recovery path.

Fix: `connectDevice()` now returns `true`/`false`. `connectAvailable()` checks this in both its instant-match and picker-fallback branches and restores the entry to `availableDevices` immediately on failure, instead of just for the outer picker-exception case it already handled. `connectSelected()` (the bulk action) also now waits 400ms between successive connect attempts, to reduce the chance of triggering the same bus contention in the first place.

### v1.4.2 — added: "Forget" button on Ready to Connect cards
Calls `USBDevice.forget()` (via `usbDevice.raw.forget()` on our wrapped type) to revoke this site's browser permission grant for that device, so it behaves like a never-paired device again (only reachable via the native picker from then on) — a UI way to simulate a fresh device connection instead of digging through Chrome's page-info → Site settings → USB devices. `forget()` isn't Baseline-supported across all browsers (works in Chrome); falls back to removing the entry from our own list only (with a clear debug-log warning that the browser-level grant wasn't actually revoked) if unsupported. Re-fetches a fresh device reference via `mgr.getDevices()` first if the stored entry's `usbDevice` is `null` (e.g. it arrived via `disconnectOne()`, which deliberately nulls that field per the "never cache usbDevice" convention).

### v1.4.2 — FIXED: freshly (re-)granted device showed in both Connected AND Ready to Connect
Race condition: `mgr.requestDevice()` granting a new permission fires the browser's native `'connect'` event essentially simultaneously with the picker flow's own direct `connectDevice(device)` call. That event's listener calls `scanAvailableDevices()` asynchronously — if it completed its "is this already in `connectedDevices`?" check *before* `connectDevice()`'s own (much longer) chain of awaits (`usbDevice.connect()`, `AdbDaemonTransport.authenticate()`, `adb.getProp('ro.serialno')`, ...) reached its `connectedDevices.set(...)` call, the scan would see `connectedDevices` still empty and add the device to `availableDevices` too — and nothing ever removed it afterward.

Also found while fixing this: `scanDevices()`'s own "already connected" duplicate-check had the same `.vendorId`/`.productId`-not-via-`.raw` bug as v1.3.2/v1.3.3, so it could never actually detect a duplicate.

Fix: `connectDevice()` now registers its target device's `vid:pid:serial` key in a module-level `connectingUsbIds` Set *synchronously*, before any `await`, and removes it in a `finally` block. `scanAvailableDevices()` skips any key present in that set (same treatment as "already connected"/"already available"). As a defensive backstop, `connectDevice()` also explicitly deletes any matching `availableDevices` entry right after adding to `connectedDevices`, in case some other race still slips one in. `scanDevices()`'s duplicate-check now reads `device.raw.vendorId`/`device.raw.productId` like everywhere else.

### v1.4.1 — FIXED: unplugging a never-connected "Ready to Connect" device did nothing
`navigator.usb.addEventListener('disconnect', ...)` was registered *lazily inside `connectDevice()`*, guarded by `if (!_usbDisconnectHandler)`. "Ready to Connect" entries are populated purely by `scanAvailableDevices()` (from a prior grant) and need no `connectDevice()` call at all — so on a fresh page load where the user hadn't yet clicked "Connect" on anything, no disconnect listener existed yet, and physically unplugging an available device did nothing; it stayed listed forever. Fix: the handler (now the standalone `handleUsbDisconnect()`, no longer an inline closure) is registered unconditionally at page-load time, next to the existing `'connect'` listener, both gated only by `!isViewerMode()`.

Also documented (not a bug, working as designed): WebUSB's permission model means `getDevices()` can only ever return devices already granted ("paired") to this origin. A never-granted device will only ever appear in the native `requestDevice()` picker (unpaired) — there's no API for a page to discover ungranted hardware, by deliberate design of the spec. To fully "un-pair"/simulate a fresh device: either revoke via Chrome's site settings (page-info icon → Site settings → USB devices), or call the granted device's underlying `USBDevice.forget()` (MDN-documented, Chrome-supported; via our wrapper this would be `usbDevice.raw.forget()`) — not currently wired into the UI as of v1.4.1.

### v1.3.2 — FIXED: "invalid USBDevice object — missing connect()" on Ready-to-Connect
This was actually the same root-cause class of bug as v1.1.41/v1.1.42 below, recurring because that earlier fix's "use `getDevices()`" was ambiguous about *which* `getDevices()`. `connectAvailable()` and `scanAvailableDevices()` were both calling `navigator.usb.getDevices()` — the plain native WebUSB API, which returns bare `USBDevice` objects. `.connect()` is **not** part of the WebUSB spec at all; it only exists on `AdbDaemonWebUsbDevice`, the wrapper type that `AdbDaemonWebUsbDeviceManager.BROWSER`'s own `requestDevice()`/`getDevices()` methods return. The "+Connect Device" button worked because `scanDevices()` already went through `mgr.requestDevice()` (wrapped); the "Ready to Connect" list's `connectAvailable()` went through the native, unwrapped `getDevices()` instead, so its found device lacked `.connect()` and tripped `connectDevice()`'s guard clause.

This same mismatch also explained a second symptom: a device already in `connectedDevices` (recorded via the wrapped `.serial`) kept reappearing as a duplicate "Ready to Connect" ghost entry with a fresh `vid:pid:timestamp` key on every scan — because the *old*, buggy `scanAvailableDevices()` computed its dedup key from the *native* device's `.serial` (empty/undefined for this hardware), which never matched the wrapped device's `.serial` the connected entry was keyed by.

Fix: both functions now call `AdbDaemonWebUsbDeviceManager.BROWSER.getDevices({filters:[AdbDefaultInterfaceFilter]})` instead of `navigator.usb.getDevices()`. Since `AdbDaemonWebUsbDevice` doesn't expose `vendorId`/`productId` directly (only via its `.raw` property, the underlying native `USBDevice`), all vid/pid comparisons in these two functions now go through `d.raw.vendorId`/`d.raw.productId` instead of `d.vendorId`/`d.productId`.

### v1.3.3 — FIXED: same bug, one more spot (`connectDevice()` itself)
The v1.3.2 fix above wasn't complete. `connectDevice(usbDevice)` — called from *both* the picker path and the reconnect path, always with a wrapped `AdbDaemonWebUsbDevice` — built its stored `_usbId` from `usbDevice.vendorId`/`usbDevice.productId` directly, which are `undefined` on the wrapped type (confirmed live: `connectDevice SUCCESS` logged `usb=undefined:undefined:253085251E0049`). That corrupted `_usbId` then propagated everywhere: `disconnectOne()` copies it verbatim into the "Ready to Connect" entry, so the *next* `connectAvailable()` call looks for `vid+pid=undefined:undefined`, never matches the real device (which has real numbers), and falls back to the native picker dialog every time instead of reconnecting instantly — and the stale duplicate "Ready to Connect" ghost entry persists for the same reason (dedup key mismatch against the corrupted connected entry). Fix: `connectDevice()` now reads `usbDevice.raw.vendorId`/`usbDevice.raw.productId` too, consistent with v1.3.2.

### v1.1.42 — FIXED
- `pipeTo` error: `connectAvailable()` was passing raw `USBDevice` to `AdbDaemonTransport.authenticate()` as `connection` parameter. Fix: use `getDevices()` + pass matching device to `connectDevice()` which handles `connect()` -> `USBConnection` properly.

### v1.1.41 — pipeTo error (superseded by 1.1.42)
- Attempted to fix by using `mgr.requestDevice()` from `connectAvailable()`. Still caused pipeTo error because `connectDevice()` expects a USBDevice it can call `.connect()` on, but the picker flow was not properly wired.

### v1.1.40 — disconnect handler key mismatch
- `disconnectOne()` moved device to availableDevices with key format `serial || vid:pid:timestamp`
- `scanAvailableDevices()` used `serial || vid:pid:timestamp`
- Mismatch caused duplicate entries. Fixed by aligning key formats.

### Historical patterns
- **WebUSB device references are transient**: `getDevices()` returns fresh objects each time. Never cache `usbDevice` across connections — always re-acquire via `getDevices()` or `requestDevice()`.
- **"`getDevices()`" is ambiguous — always mean `AdbDaemonWebUsbDeviceManager.BROWSER.getDevices()`**, never bare `navigator.usb.getDevices()`. Only the manager's version returns the wrapped `AdbDaemonWebUsbDevice` (with `.connect()`); the native one returns plain `USBDevice` objects that will fail `connectDevice()`'s guard clause. See v1.3.2 above — this exact ambiguity is what caused it to recur after v1.1.42.
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

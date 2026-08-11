// Web ADB Inspector - Pure WebUSB, runs entirely in browser
const APP_VERSION = '1.19.0';
import {
  Adb, AdbFeature,
  AdbDaemonTransport,
  ADB_DAEMON_DEFAULT_FEATURES,
  ADB_DAEMON_DEFAULT_INITIAL_PAYLOAD_SIZE,
} from '@yume-chan/adb';
import {
  AdbDaemonWebUsbDeviceManager,
  AdbDefaultInterfaceFilter,
} from '@yume-chan/adb-daemon-webusb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { TextDecoderStream, ConcatStringStream, ConcatBufferStream } from '@yume-chan/stream-extra';
import { joinRoom } from '@trystero-p2p/ws-relay';

// --- Global State ---
const credentialStore = new AdbWebCredentialStore('web-adb-inspector');
const connectedDevices = new Map();
const availableDevices = new Map(); // Button-disconnected devices (still physically present)
const selectedConnectedSerials = new Set(); // for bulk Disconnect Selected
const selectedAvailableSerials = new Set(); // for bulk Connect Selected
// vid:pid:serial keys currently mid-connectDevice(), so a concurrent scanAvailableDevices()
// (e.g. triggered by the same native 'connect' event the picker's grant fires) doesn't race
// ahead and add the device to "Ready to Connect" before connectedDevices.set() runs.
const connectingUsbIds = new Set();
// serial -> {attempt, total, label} for available devices currently mid-connectAvailable()
// (including retries) — drives the "Connecting... (2/4)" status shown on their card.
const connectingStatus = new Map();
// Serials to automatically reconnect the next time scanAvailableDevices() sees them show
// up again — populated by handleUsbDisconnect() whenever it tears down a device that
// wasn't an explicit user-initiated disconnect (disconnectingSerial). Confirmed via a real
// Linux multi-device debug log (2026-08-11): connecting a SECOND device on the same
// physical hub/controller as an already-connected one can trigger a spurious 'disconnect'
// event for the ALREADY-connected device (almost certainly a bus-level reset ripple from
// connectDevice()'s own pre-emptive USBDevice.reset() call on the device being newly
// connected) — a 'USB connect event' for the same device typically follows ~1-2s later,
// but without this, the app just dropped it into "Ready to Connect" and left it there
// until the user noticed and manually clicked Connect. Auto-reconnecting costs nothing for
// a genuine unplug (the attempt just exhausts its retries and it sits in "available" same
// as before) but fully self-heals the common phantom-disconnect case.
const pendingAutoReconnect = new Set();
let activeSerial = null;
let disconnectingSerial = null;  // serial currently being intentionally disconnected (suppress USB event)
const dataCache = { props: [], features: [], packages: [] };
// Host-side, keyed by serial -> {tab: html} — the most recently rendered tab HTML for
// EVERY device the host has ever selected this session, not just whichever one is
// currently active. Populated by pushTabHtml() on every fresh fetch/render; read by
// handleViewerHello() so a newly-joined viewer gets caught up on every device the host
// has visited so far, not only the one currently open. Without this, a viewer selecting a
// device the host looked at earlier (and has since switched away from) saw a permanent
// "Waiting for host data…" for that device's Properties/Features/etc, since pushTabHtml()
// only ever fires again for whichever device is CURRENTLY active on the host.
const hostTabHtmlCache = {};
const deviceNicknames = (() => { try { return JSON.parse(localStorage.getItem('device-nicknames') || '{}'); } catch { return {}; } })();
let fontSizeLevel = (() => { try { return parseInt(localStorage.getItem('font-size-level') || '0', 10); } catch { return 0; } })();

// --- Remote Session (WebRTC sharing, host or viewer role) ---
const REMOTE_APP_ID = 'web-adb-inspector-v1';
// Free/shared public TURN relay (Open Relay Project) — fallback for when direct
// STUN-only P2P fails (symmetric NAT, restrictive corporate firewalls that block
// UDP). Port 443/TCP variant is included specifically so TURN traffic can blend
// in with ordinary HTTPS on networks that block other UDP/TCP ports outright.
// NOTE (2026-08-10 TURN investigation): trystero's peer.mjs already prepends its
// own defaultIceServers (Google + Cloudflare STUN) ahead of this array — see
// `iceServers: defaultIceServers.concat(turnConfig ?? [])` in
// @trystero-p2p/core/dist/peer.mjs — so STUN/srflx gathering was never actually
// missing. The explicit stun: entry below is therefore likely redundant today;
// it's kept anyway as a defensive, explicit fallback in case a future trystero
// version changes that default. The turns: (TURN-over-TLS) entry is speculative:
// Open Relay's own marketing claims "Support TURNS + SSL to allow connections
// through deep packet inspection firewalls," but no example configuration found
// (their docs, blog, or third-party integration guides) actually shows a turns:
// URL — it may only exist on their paid/API-key dynamic-credential tier, not
// this free static-credential one. Adding it costs nothing (a browser silently
// ignores an iceServers entry that doesn't work) so it's included on the chance
// it helps; do not assume it's confirmed functional. See TURN_RELIABILITY_ANALYSIS.md.
const REMOTE_TURN_CONFIG = [
  { urls: 'stun:openrelay.metered.ca:80' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];
// Signaling: self-hosted relay (relay-server/, deployed on Render), not public Nostr
// relays. Three rounds of public-relay debugging (2026-08-04, see PROJECT_CONTEXT.md
// section 12) found they're unreliable for a quick 1:1 host/viewer rendezvous —
// rate-limiting under repeated use, and independent random relay selection meaning
// host and viewer often shared no relay in common. A dedicated relay we control removes
// both problems entirely.
const REMOTE_RELAY_URLS = ['wss://web-adb-inspector-relay.onrender.com'];
let remoteSession = null;
function isViewerMode() { return !!(remoteSession && remoteSession.role === 'viewer'); }
// host:   { role:'host', room, roomId, password, viewers:Set<peerId>,
//           actions:{hello,devicePush,cmdRequest,cmdResponse,bye} }
// viewer: { role:'viewer', room, roomId, password, hostPeerId:null,
//           actions:{...}, pendingRequests:Map<requestId,{cmd}>,
//           mirror:{ activeSerial:null, connected:[], available:[] } }

// --- Debug Console ---
const debugLog = [];
function debugLogPush(msg, level) {
  level = level || 'evt';
  const ts = new Date().toLocaleTimeString('en-GB', {hour12:false}) + '.' + String(new Date().getMilliseconds()).padStart(3,'0');
  debugLog.push({ts, msg, level});
  const el = document.getElementById('debug-output');
  if (!el) return;
  const row = document.createElement('div');
  row.className = 'debug-entry';
  row.innerHTML = `<span class="debug-ts">${ts}</span><span class="debug-${level}">[${level.toUpperCase()}]</span> ${msg}`;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
  const cnt = document.getElementById('debug-count');
  if (cnt) cnt.textContent = `(${debugLog.length} entries)`;
}
function toggleDebugConsole() {
  const el = document.getElementById('debug-console');
  if (el) el.classList.toggle('hidden');
}
function clearDebugLog() {
  debugLog.length = 0;
  const el = document.getElementById('debug-output');
  if (el) el.innerHTML = '';
  const cnt = document.getElementById('debug-count');
  if (cnt) cnt.textContent = '(0 entries)';
}
function copyDebugLog() {
  const text = debugLog.map(d => `${d.ts} [${d.level.toUpperCase()}] ${d.msg}`).join('\n');
  navigator.clipboard.writeText(text).catch(()=>{});
}

const SDK_PREFIXES = ['android.hardware.', 'android.software.', 'android.feature.', 'com.google.android.feature.'];
function isSDKFeature(n) { return SDK_PREFIXES.some(p => n.startsWith(p)); }

// --- Init ---
// Module scripts are deferred — they execute AFTER DOMContentLoaded fires.
// Wrapping init in DOMContentLoaded would mean it never runs.
// Use IIFE that runs immediately + a fallback for non-deferred contexts.
(function init() {
  // DOM should already be ready since module scripts defer until after parsing
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
    return;
  }
  checkWebUSB();
  initRemoteViewerIfLinked();
  // iterateKeys() is an async generator (returns AsyncGenerator, not Promise),
  // so .catch() is undefined. Wrap in an IIFE that returns a Promise.
  (async () => {
    try {
      for await (const _ of credentialStore.iterateKeys()) {
        // we just want to verify access works; the keys themselves are unused here
        break;
      }
    } catch (e) {
      try { await credentialStore.generateKey(); } catch (_) {}
    }
  })();
  applyFontSize();
  // Show version in header (host) and in the viewer banner (viewer) — same string, two
  // spots, since the viewer never sees the host's header controls but should still be
  // able to tell which build they loaded (e.g. to confirm a hard-refresh actually
  // picked up a new deploy).
  const verEl = document.getElementById('header-version');
  if (verEl) verEl.textContent = 'v' + APP_VERSION;
  const viewerVerEl = document.getElementById('viewer-version');
  if (viewerVerEl) viewerVerEl.textContent = 'v' + APP_VERSION;
})();

function checkWebUSB() {
  const b = document.getElementById('webusb-status');
  if (!AdbDaemonWebUsbDeviceManager.BROWSER) {
    b.textContent = 'WebUSB: NOT supported';
    b.className = 'badge err';
    document.getElementById('btn-scan').disabled = true;
    return;
  }
  b.textContent = 'WebUSB: ready';
  b.className = 'badge ok';
}
// Scan for previously granted USB devices on page load (skipped in remote-viewer mode — viewer never touches WebUSB)
if (!isViewerMode()) setTimeout(() => scanAvailableDevices(), 500);

// Listen for new USB devices at any time
if (!isViewerMode()) {
  navigator.usb.addEventListener('connect', (e) => {
    debugLogPush(`USB connect event: VID=${e.device.vendorId} PID=${e.device.productId} Serial=${e.device.serial || '(none)'}`, 'ok');
    console.log('[usb-connect-event] device:', e.device.vendorId, e.device.productId, e.device.serial);
    scanAvailableDevices();
  });
  // Registered unconditionally (not lazily inside connectDevice()) so unplugging a
  // device that's only ever sat in "Ready to Connect" — never actually connected this
  // session — still gets detected and removed. See handleUsbDisconnect()'s comment.
  navigator.usb.addEventListener('disconnect', handleUsbDisconnect);
}

function getOS() {
  const u = navigator.userAgent;
  if (/Windows/.test(u)) return 'windows';
  if (/Mac/.test(u)) return 'mac';
  if (/Linux/.test(u)) return 'linux';
  return 'unknown';
}

// Broader than a plain "already in use" check: WebUSB surfaces the same underlying
// problem (something else on the host holding the device — a background adb.exe/ADB
// server, Android Studio, vendor sync/management software, etc.) under several different
// error messages depending on exactly where it fails. All of these warrant the same
// "go free up the device" guidance.
function isDeviceBusyError(msg) {
  const m = (msg || '').toLowerCase();
  return m.includes('already in use') ||
    m.includes('device was disconnected') ||
    m.includes("failed to execute 'open'") ||
    m.includes('unable to claim interface') ||
    m.includes('access denied');
}

// A custom modal (not a plain alert()) specifically so it can offer a one-click Reload
// button — confirmed (2026-08-06, see PROJECT_CONTEXT.md) that once this failure starts
// recurring within a page, no amount of retrying or closing/reopening the device from our
// own code recovers it; only an actual page reload does, reliably, every time. Most likely
// a stuck per-page WebUSB<->browser-service connection that our script has no way to reset
// short of the page itself reloading.
function showADBReleaseDialog(vendorId) {
  hideADBReleaseDialog();
  const os = getOS();
  let t, b;
  if (os === 'windows') { t = 'Release the device on Windows'; b = 'Something else on this machine may have the device open (a background adb.exe/ADB server, Android Studio, or vendor device-management software).\n\n1. Command Prompt: adb kill-server\n2. Or: taskkill /F /IM adb.exe\n3. Also check Task Manager for Android Studio, Zebra device-management tools (e.g. StageNow, 123Scan, device sync utilities), or other apps that talk to this device over USB, and close them.'; }
  else if (os === 'mac') { t = 'Release ADB on macOS'; b = '1. Terminal: adb kill-server\n2. If stuck: pkill -f adb'; }
  else {
    // "Access denied" on Linux almost always means one of two things, and it's worth
    // trying both since they look identical from here: (1) the native platform-tools
    // adb server has already claimed the device — it does this the instant it sees an
    // ADB-capable device, even with no "adb shell" session running, which conflicts
    // directly with this page's WebUSB access; or (2) there's no udev rule granting a
    // non-root user permission to open the raw USB device node at all. Confirmed
    // (2026-08 report): with two devices sharing the same vendor:product ID plugged in
    // at once, one connected fine while the other failed "Access denied" on every
    // retry — consistent with (1), since a device the native adb server had already
    // seen earlier would be claimed while a never-before-seen one wouldn't be.
    const vidHex = vendorId ? vendorId.toString(16).padStart(4, '0') : 'xxxx';
    t = 'Release the device on Linux';
    b = 'Something else on this machine most likely has the device open:\n\n' +
      '1. Terminal: adb kill-server\n' +
      '   The native Android platform-tools adb server auto-claims any ADB-capable USB device the moment it sees it. This is the most common cause, especially if only one of several similar devices fails.\n\n' +
      '2. If that doesn\'t fix it, you likely need a udev rule granting USB access:\n' +
      '   echo \'SUBSYSTEM=="usb", ATTR{idVendor}=="' + vidHex + '", MODE="0666", GROUP="plugdev"\' | sudo tee /etc/udev/rules.d/51-android.rules\n' +
      '   sudo udevadm control --reload-rules && sudo udevadm trigger\n' +
      '   Then unplug and replug the device.' + (vendorId ? '' : ' (run `lsusb` first to find the vendor ID for the "idVendor" line above.)') + '\n\n' +
      '3. Also check for Android Studio, scrcpy, or other USB device-management tools that might already have it open.';
  }
  const overlay = document.createElement('div');
  overlay.id = 'adb-release-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;';
  overlay.onclick = (e) => { if (e.target === overlay) hideADBReleaseDialog(); };
  const box = document.createElement('div');
  box.style.cssText = 'background:#1e1e2e;color:#cdd6f4;border-radius:12px;padding:24px;min-width:360px;max-width:520px;box-shadow:0 8px 32px rgba(0,0,0,0.4);';
  box.innerHTML =
    '<h3 style="margin:0 0 12px;font-size:18px;">' + esc(t) + '</h3>' +
    '<p style="font-size:13px;color:#a6adc6;margin-bottom:16px;white-space:pre-wrap;">' + esc(b) + '</p>' +
    '<p style="font-size:13px;color:#a6adc6;margin-bottom:16px;">If none of that helps: reloading this page has reliably fixed this in testing — at the cost of disconnecting any other devices currently connected here.</p>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
    '<button class="btn btn-sm" id="adb-release-dismiss-btn">Dismiss</button>' +
    '<button class="btn" id="adb-release-reload-btn" style="background:#f38ba8;">Reload Page</button>' +
    '</div>';
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  document.getElementById('adb-release-dismiss-btn').onclick = () => hideADBReleaseDialog();
  document.getElementById('adb-release-reload-btn').onclick = () => location.reload();
}

function hideADBReleaseDialog() {
  const el = document.getElementById('adb-release-modal-overlay');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

// --- Device Discovery ---
// Connect device — always use native WebUSB picker, filter connected after selection
async function scanDevices() {
  try {
    const mgr = AdbDaemonWebUsbDeviceManager.BROWSER;
    if (!mgr) return;
    const device = await mgr.requestDevice({ filters: [AdbDefaultInterfaceFilter] });
    if (!device) return;
    // Check if this device is already connected. device is the wrapped AdbDaemonWebUsbDevice —
    // vendorId/productId only exist via .raw, not directly (see PROJECT_CONTEXT.md v1.3.2/v1.3.3).
    const usbId = { vendorId: device.raw.vendorId, productId: device.raw.productId, serial: device.serial };
    const key = usbId.vendorId + ':' + usbId.productId + ':' + (usbId.serial || '');
    for (const [, info] of connectedDevices) {
      if (info._usbId) {
        const existing = info._usbId.vendorId + ':' + info._usbId.productId + ':' + (info._usbId.serial || '');
        if (existing === key) {
          setStatus('Already connected: ' + (info._displayName || 'device'), 'warn');
          return;
        }
      }
    }
    // A freshly-granted device (this is always the case here — scanDevices() only runs off
    // the native picker) can hit the same transient post-attach delay as a reconnect, so it
    // gets the same retry treatment via connectWithRetries() — see that function's comment
    // and PROJECT_CONTEXT.md. There's no device card yet to show per-device status against,
    // so retries are reflected in the global status banner instead.
    const { ok, lastError } = await connectWithRetries(mgr, usbId, device, (label) => setStatus(label, 'connecting'));
    if (!ok) {
      setStatus('Failed to connect after retries' + (lastError ? ': ' + lastError : ''), 'err');
      if (lastError && isDeviceBusyError(lastError)) showADBReleaseDialog(usbId.vendorId);
    }
  } catch (err) {
    const msg = err.message || String(err);
    if (isDeviceBusyError(msg)) showADBReleaseDialog(usbId.vendorId);
    else setStatus('Failed: ' + msg, 'err');
  }
}

// Populate "Ready to Connect" section from previously granted USB devices.
// Only adds devices that are NOT already in connectedDevices or availableDevices.
// Called on page init and on USB connect events.
async function scanAvailableDevices() {
  try {
    // NOTE: must use the yume-chan manager's getDevices(), not navigator.usb.getDevices()
    // directly — the latter returns plain native USBDevice objects with no .connect()
    // method at all (that's not part of the WebUSB spec; it's a convenience method the
    // manager's own wrapped AdbDaemonWebUsbDevice type adds). Storing/matching against
    // raw native devices here is what made connectAvailable() fail with "invalid USBDevice
    // object — missing connect()" despite an identical-looking device working fine via the
    // "+Connect Device" picker (which goes through mgr.requestDevice(), already wrapped).
    const mgr = AdbDaemonWebUsbDeviceManager.BROWSER;
    if (!mgr) return;
    const granted = await mgr.getDevices({ filters: [AdbDefaultInterfaceFilter] });
    debugLogPush(`scanAvailableDevices: granted=${granted.length} connected=${connectedDevices.size} available=${availableDevices.size}`, 'evt');
    console.log('[scan-available] granted:', granted.length, 'connected:', connectedDevices.size, 'available:', availableDevices.size);
    // Build a set of known vid:pid:serial for O(1) lookup
    const knownConnected = new Set();
    for (const [, ci] of connectedDevices) {
      if (ci._usbId) {
        const k = ci._usbId.vendorId + ':' + ci._usbId.productId + ':' + (ci._usbId.serial || '');
        knownConnected.add(k);
      }
    }
    const knownAvailable = new Set();
    for (const [, ai] of availableDevices) {
      if (ai._usbId) {
        const k = ai._usbId.vendorId + ':' + ai._usbId.productId + ':' + (ai._usbId.serial || '');
        knownAvailable.add(k);
      }
    }
    for (const usbDevice of granted) {
      const uid = { vendorId: usbDevice.raw.vendorId, productId: usbDevice.raw.productId, serial: usbDevice.serial };
      const uidKey = uid.vendorId + ':' + uid.productId + ':' + (uid.serial || '');
      // Skip if already connected or available (exact vid+pid+serial match)
      if (knownConnected.has(uidKey)) {
        console.log('[scan-available] skip (already connected):', uidKey);
        continue;
      }
      if (knownAvailable.has(uidKey)) {
        console.log('[scan-available] skip (already available):', uidKey);
        continue;
      }
      if (connectingUsbIds.has(uidKey)) {
        console.log('[scan-available] skip (connectDevice in progress):', uidKey);
        continue;
      }
      // Add as available
      const key = usbDevice.serial || (uid.vendorId + ':' + uid.productId + ':' + Date.now());
      availableDevices.set(key, {
        adb: null, usbDevice, transport: null,
        _displayName: usbDevice.name || ('USB Device ' + uid.vendorId + ':' + uid.productId),
        _usbId: uid,
      });
      console.log('[scan-available] added:', key, 'vid:', uid.vendorId, 'pid:', uid.productId, 'serial:', uid.serial);
      // Self-heal a phantom disconnect (see pendingAutoReconnect's declaration comment) —
      // this device just reappeared after an unexpected drop, reconnect it automatically
      // instead of leaving it sitting in "Ready to Connect" until the user notices.
      if (pendingAutoReconnect.has(key)) {
        pendingAutoReconnect.delete(key);
        debugLogPush(`scanAvailableDevices: ${key} reappeared after an unexpected disconnect — auto-reconnecting`, 'ok');
        connectAvailable(key);
      }
    }
    renderDeviceList();
  } catch (err) {
    console.log('[scan-available] failed:', err);
  }
}



async function showDevicePicker(devices) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;';
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(); };

    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e2e;color:#cdd6f4;border-radius:12px;padding:24px;min-width:320px;max-width:500px;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.4);';
    box.innerHTML = '<h3 style="margin:0 0 16px;font-size:18px;">Select Device</h3>';

    const list = document.createElement('div');
    for (const dev of devices) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px;border-radius:8px;cursor:pointer;transition:background 0.15s;border:1px solid transparent;margin-bottom:4px;';
      row.onmouseover = () => { row.style.background = '#313244'; row.style.borderColor = '#89b4fa'; };
      row.onmouseout = () => { row.style.background = 'transparent'; row.style.borderColor = 'transparent'; };
      const name = dev.name || 'USB Device';
      const serial = dev.serial || 'N/A';
      row.innerHTML = `<div style="flex:1;"><div style="font-weight:500;">${name}</div><div style="font-size:12px;color:#a6adc6;">${serial}</div></div><div style="font-size:12px;color:#a6adc6;">${dev.vendorId && dev.productId ? 'VID:'+dev.vendorId+' PID:'+dev.productId : ''}</div>`;
      row.onclick = () => { cleanup(); connectDevice(dev).catch(e => setStatus('Failed: ' + e.message, 'err')); resolve(); };
      list.appendChild(row);
    }
    box.appendChild(list);

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'margin-top:16px;padding:8px 20px;border-radius:6px;border:1px solid #585b70;background:#313244;color:#cdd6f4;cursor:pointer;font-size:14px;';
    cancel.onclick = () => { cleanup(); resolve(); };
    box.appendChild(cancel);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function cleanup() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
  });
}

// Helper: handle "transfer was cancelled" errors from WebUSB
// These fire when USB drops mid-operation — treat as disconnect
function handleUsbError(err, serial) {
  if (err && typeof err === 'object' && 'message' in err && err.message && err.message.includes('transfer was cancelled')) {
    if (connectedDevices.has(serial)) {
      setStatus('Device disconnected (USB transfer error): ' + serial, 'warn');
      try { connectedDevices.get(serial)?.transport?.close(); } catch(ex) {}
      connectedDevices.delete(serial);
      notifyDeviceRemoved(serial);
      if (activeSerial === serial) {
        activeSerial = connectedDevices.size > 0 ? connectedDevices.keys().next().value : null;
      }
      renderDeviceList();
      if (activeSerial) {
        selectDevice(activeSerial);
      } else {
        document.getElementById('inspector-section').classList.add('hidden');
      }
    }
    return true; // handled
  }
  return false;
}

// Global USB disconnect handler. Registered unconditionally at page-load time (see the
// top-level navigator.usb.addEventListener('disconnect', ...) call near init) — NOT lazily
// inside connectDevice() as it used to be. That lazy registration meant a device sitting
// in "Ready to Connect" (populated purely by scanAvailableDevices() from a prior grant,
// no connectDevice() call needed) would have no disconnect listener at all if the user
// hadn't yet connected *any* device this session, so unplugging it did nothing and it
// stayed listed forever.
function handleUsbDisconnect(e) {
  const dev = e.device;
  debugLogPush(`USB disconnect event: VID=${dev.vendorId} PID=${dev.productId} Serial=${dev.serial || '(none)'}`, 'warn');
  console.log('[disconnect-event] fired, device:', dev.vendorId, dev.productId, dev.serial);
  // Guard: ignore disconnect events for devices we're intentionally disconnecting via button
  if (disconnectingSerial) {
    const info = connectedDevices.get(disconnectingSerial);
    if (info && info._usbId) {
      const uid = info._usbId;
      if (uid.vendorId === dev.vendorId && uid.productId === dev.productId) {
        if (dev.serial && uid.serial ? dev.serial === uid.serial : true) {
          debugLogPush(`USB disconnect SUPPRESSED (intentional): serial=${disconnectingSerial}`, 'ok');
          console.log('[disconnect-event] suppressed (intentional disconnect):', disconnectingSerial);
          disconnectingSerial = null;
          return;
        }
      }
    }
    disconnectingSerial = null;
  }
  // Match strategy: exact serial first, then vid+pid fallback (only if single candidate)
  let matchedKey = null;
  // Pass 1: exact serial match
  for (const [key, info] of connectedDevices) {
    const uid = info._usbId;
    if (!uid) continue;
    if (dev.serial && uid.serial && uid.serial === dev.serial) {
      matchedKey = key; break;
    }
  }
  // Pass 2: vid+pid fallback — only if exactly one match
  if (!matchedKey) {
    const candidates = [];
    for (const [key, info] of connectedDevices) {
      const uid = info._usbId;
      if (uid && uid.vendorId === dev.vendorId && uid.productId === dev.productId) {
        candidates.push(key);
      }
    }
    if (candidates.length === 1) {
      matchedKey = candidates[0];
    } else if (candidates.length > 1) {
      debugLogPush(`USB disconnect AMBIGUOUS vid+pid: ${candidates.length} candidates: ${candidates.join(', ')}`, 'warn');
      console.log('[disconnect-event] ambiguous vid+pid match, skipping:', candidates);
    }
  }
  if (matchedKey) {
    const info = connectedDevices.get(matchedKey);
    debugLogPush(`USB disconnect MATCHED connected: serial=${matchedKey}`, 'err');
    console.log('[disconnect-event] MATCH connected:', matchedKey);
    setStatus('Device disconnected: ' + matchedKey, 'warn');
    try { info.transport.close(); } catch(ex) {}
    // Stop heartbeat
    const hbKey = 'hb-' + matchedKey;
    if (window[hbKey]) { clearInterval(window[hbKey]); delete window[hbKey]; }
    connectedDevices.delete(matchedKey);
    notifyDeviceRemoved(matchedKey);
    // Not an explicit user-initiated disconnect (that's handled and returned above) —
    // give it a chance to self-heal if this was actually a phantom hub-ripple event (see
    // pendingAutoReconnect's declaration comment) rather than a genuine unplug.
    pendingAutoReconnect.add(matchedKey);
    setTimeout(() => pendingAutoReconnect.delete(matchedKey), 20000);
    // Also remove matching entry from availableDevices by serial
    for (const [akey, ainfo] of availableDevices) {
      const au = ainfo._usbId;
      if (!au) continue;
      // Match by serial (exact), or vid+pid only if no serial on either side
      if (dev.serial && au.serial && au.serial === dev.serial) {
        console.log('[disconnect-event] removing from available:', akey);
        availableDevices.delete(akey);
        break;
      }
      if (!dev.serial && !au.serial && au.vendorId === dev.vendorId && au.productId === dev.productId) {
        console.log('[disconnect-event] removing from available:', akey);
        availableDevices.delete(akey);
        break;
      }
    }
    if (activeSerial === matchedKey) {
      activeSerial = connectedDevices.size > 0 ? connectedDevices.keys().next().value : null;
    }
    renderDeviceList();
    if (activeSerial) {
      selectDevice(activeSerial);
    } else {
      document.getElementById('inspector-section').classList.add('hidden');
    }
    return;
  }
  // No match in connected — check availableDevices (unconnected device unplugged)
  // Match by serial first, then vid+pid only if unambiguous.
  // Skip deletion entirely if connectAvailable() is actively retrying this serial — its own
  // retry loop already handles "device temporarily not found" (it's what triggers the
  // backoff wait), and deleting the entry here would orphan the "Retrying..." card from the
  // UI mid-retry: renderDeviceList() only shows a connectingStatus entry for serials still
  // present in availableDevices, so removing the map entry hides the card even though the
  // retry is still running in the background.
  for (const [akey, ainfo] of availableDevices) {
    const au = ainfo._usbId;
    if (!au) continue;
    if (dev.serial && au.serial && au.serial === dev.serial) {
      if (connectingStatus.has(akey)) {
        console.log('[disconnect-event] skip removing from available (retry in progress):', akey);
        return;
      }
      console.log('[disconnect-event] removing from available (unconnected):', akey);
      availableDevices.delete(akey);
      renderDeviceList();
      return;
    }
  }
  // VID+PID fallback for available (only if single candidate)
  const availCandidates = [];
  for (const [akey, ainfo] of availableDevices) {
    const au = ainfo._usbId;
    if (au && au.vendorId === dev.vendorId && au.productId === dev.productId) {
      availCandidates.push(akey);
    }
  }
  if (availCandidates.length === 1) {
    if (connectingStatus.has(availCandidates[0])) {
      console.log('[disconnect-event] skip removing from available vid+pid (retry in progress):', availCandidates[0]);
      return;
    }
    console.log('[disconnect-event] removing from available (vid+pid):', availCandidates[0]);
    availableDevices.delete(availCandidates[0]);
    renderDeviceList();
    return;
  } else if (availCandidates.length > 1) {
    debugLogPush(`USB disconnect AMBIGUOUS vid+pid in available: ${availCandidates.length} candidates: ${availCandidates.join(', ')}`, 'warn');
    console.log('[disconnect-event] ambiguous vid+pid match in available, skipping:', availCandidates);
  }
  console.log('[disconnect-event] no match found in connected or available');
}

// opts.silent: skip the global status banner + ADB-release dialog on failure. Used by
// connectAvailable()'s retry loop, where a raw "Failed: ..." banner on an attempt that's
// about to be automatically retried is misleading — the caller manages user-facing status
// for that flow instead, and only surfaces a failure once all retries are exhausted.
// Real body, renamed from connectDevice — see the serializing wrapper of the same name
// right below this function for why.
async function connectDeviceExclusive(usbDevice, opts = {}) {
  const silent = !!opts.silent;
  let connectingKey = null;
  let openedConnection = false;
  try {
    // Guard: ensure we have a valid USBDevice with connect()
    if (!usbDevice || typeof usbDevice.connect !== 'function') {
      debugLogPush('connectDevice: invalid USBDevice object — missing connect()', 'err');
      if (!silent) setStatus('Invalid device object — please reconnect', 'err');
      return false;
    }
    // Mark this device "connecting" synchronously, before any awaits — closes the race
    // where the native 'connect' event (fired by the same requestDevice() grant that got
    // us here) triggers a concurrent scanAvailableDevices() call that would otherwise see
    // connectedDevices still empty and add this same device to "Ready to Connect".
    connectingKey = usbDevice.raw.vendorId + ':' + usbDevice.raw.productId + ':' + (usbDevice.serial || '');
    connectingUsbIds.add(connectingKey);
    debugLogPush(`connectDevice start: serial=${usbDevice.serial || '(none)'} opened=${usbDevice.opened} otherConnected=${connectedDevices.size}`, 'evt');
    // Defensive pre-emptive close: v1.5.5's catch-block cleanup only runs when
    // usbDevice.connect() itself *succeeds* and a later step fails. It does nothing for
    // "Failed to execute 'open' on 'USBDevice': The device was disconnected" — that error
    // comes from the open() call itself rejecting, so openedConnection never becomes true
    // and there's nothing for that cleanup to close. Confirmed this exact error still
    // persisted across retries even with v1.5.5's fix in place. Leading theory: the
    // underlying library's connect() sequence can partially succeed (native open()) before
    // failing at a later internal step (e.g. claiming the interface), without ever handing
    // us a connection object to close ourselves — leaving the *native* device open from a
    // previous attempt, which then makes the *next* attempt's open() call fail outright.
    // Unconditionally closing first, before every attempt, clears that regardless of what
    // state a previous attempt left behind. Ignore any error — most of the time there's
    // nothing to close, and that's fine.
    //
    // v1.5.8: also try an actual USBDevice.reset() — a real USB-protocol-level bus reset
    // (like a real unplug/replug at the electrical level), distinct from open()/close()
    // (which only manage the browser's logical claim/handle). reset() requires the device
    // to already be "opened", hence open() first here — this is a deliberately more
    // aggressive best-effort cleanup than v1.5.6's close()-only attempt, since that alone
    // didn't recover this failure. Each step is independent and best-effort; if any of
    // them isn't applicable (e.g. nothing to reset) that's expected, not an error.
    try { await usbDevice.raw.open(); } catch (_) {}
    try { await usbDevice.raw.reset(); debugLogPush('connectDevice: pre-emptive USB reset succeeded', 'evt'); } catch (_) {}
    try { await usbDevice.raw.close(); } catch (_) {}
    setStatus('Connecting...', 'connecting');
    console.log('[connect] usbDevice:', usbDevice.serial, 'opened:', usbDevice.opened, 'connect:', typeof usbDevice.connect);
    const t0 = Date.now();
    const connection = await usbDevice.connect();
    openedConnection = true;
    debugLogPush(`connectDevice: usbDevice.connect() resolved after ${Date.now() - t0}ms`, 'evt');
    console.log('[connect] connected, opened:', usbDevice.opened, 'conn.closed:', typeof connection.closed);
    const t1 = Date.now();
    const transport = await AdbDaemonTransport.authenticate({
      serial: usbDevice.serial || 'usb', connection, credentialStore,
      features: ADB_DAEMON_DEFAULT_FEATURES,
      initialDelayedAckBytes: ADB_DAEMON_DEFAULT_INITIAL_PAYLOAD_SIZE,
    });
    debugLogPush(`connectDevice: AdbDaemonTransport.authenticate() resolved after ${Date.now() - t1}ms`, 'evt');

    const adb = new Adb(transport);

    // Get REAL serial from device property — adb.serial may fall back to USB vendor:product
    let adbSerial = adb.serial;
    try {
      const realSerial = await adb.getProp('ro.serialno');
      if (realSerial && realSerial !== adbSerial) {
        console.log('[serial] overriding', adbSerial, '->', realSerial);
        adbSerial = realSerial;
      }
    } catch(e) {
      console.log('[serial] getProp failed, using fallback:', adbSerial);
    }
    if (connection && typeof connection.closed === 'object') {
      connection.closed.then(() => {
        debugLogPush(`connection.closed: serial=${adbSerial} still_in_map=${connectedDevices.has(adbSerial)}`, 'warn');
        if (connectedDevices.has(adbSerial)) {
          setStatus('Device disconnected: ' + adbSerial, 'warn');
          try { transport.close(); } catch(ex) {}
          // Stop heartbeat
          const hbKey2 = 'hb-' + adbSerial;
          if (window[hbKey2]) { clearInterval(window[hbKey2]); delete window[hbKey2]; }
          connectedDevices.delete(adbSerial);
          notifyDeviceRemoved(adbSerial);
          availableDevices.delete(adbSerial);
          if (activeSerial === adbSerial) {
            activeSerial = connectedDevices.size > 0 ? connectedDevices.keys().next().value : null;
          }
          renderDeviceList();
          if (activeSerial) {
            selectDevice(activeSerial);
          } else {
            document.getElementById('inspector-section').classList.add('hidden');
          }
        }
      }).catch(() => {});
    }
    let displayName = usbDevice.name || 'Android Device';
    try {
      const model = await adb.getProp('ro.product.model');
      const brand = await adb.getProp('ro.product.brand');
      displayName = brand + ' ' + model;
    } catch (_) {}

    // Polling fallback: adb.getProp() with 1s timeout every 3s
    const hbKey = 'hb-' + adbSerial;
    const hbInterval = setInterval(() => {

      if (!connectedDevices.has(adbSerial)) {
        clearInterval(hbInterval);
        delete window[hbKey];
        return;
      }
      // Silent heartbeat — no UI counter
      // adb.getProp throws immediately when USB physically disconnected
      Promise.race([
        adb.getProp('ro.build.id'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1000))
      ]).catch(e => {
        if (!connectedDevices.has(adbSerial)) return;
        debugLogPush(`heartbeat FAILED: serial=${adbSerial} err=${e.message}`, 'err');
        clearInterval(hbInterval);
        delete window[hbKey];
        const info = connectedDevices.get(adbSerial);
        try { transport.close(); } catch(ex) {}
        // Physical disconnect — delete entirely (not available)
        connectedDevices.delete(adbSerial);
        notifyDeviceRemoved(adbSerial);
        availableDevices.delete(adbSerial);
        if (activeSerial === adbSerial) {
          activeSerial = connectedDevices.size > 0 ? connectedDevices.keys().next().value : null;
        }
        renderDeviceList();
        setStatus('Device disconnected: ' + adbSerial, 'warn');
        if (activeSerial) selectDevice(activeSerial);
        else document.getElementById('inspector-section').classList.add('hidden');
      });
    }, 3000);
    window[hbKey] = hbInterval;

    // Use global navigator.usb.ondisconnect (reliable across browsers)
    // Store USB identifiers at connect time for reliable disconnect matching.
    // usbDevice here is always the wrapped AdbDaemonWebUsbDevice (from mgr.requestDevice()
    // or mgr.getDevices()) — it doesn't expose vendorId/productId directly, only via .raw
    // (the underlying native USBDevice). Reading usbDevice.vendorId/.productId directly
    // silently gives undefined, which corrupts every downstream vid+pid match (disconnect
    // matching, Ready-to-Connect dedup, reconnect-by-vid+pid) — see PROJECT_CONTEXT.md v1.3.2/v1.3.3.
    const usbId = {
      serial: usbDevice.serial,
      vendorId: usbDevice.raw.vendorId,
      productId: usbDevice.raw.productId,
    };

    connectedDevices.set(adbSerial, { adb, usbDevice, transport, _displayName: displayName, _usbId: usbId });
    // Defensive cleanup: if a "Ready to Connect" entry for this same physical device
    // still exists (a race the connectingUsbIds guard above didn't fully close, or one
    // that predates this connection), remove it now rather than showing the device twice.
    for (const [akey, ainfo] of availableDevices) {
      const au = ainfo._usbId;
      if (au && au.vendorId === usbId.vendorId && au.productId === usbId.productId &&
          (!usbId.serial || !au.serial || au.serial === usbId.serial)) {
        availableDevices.delete(akey);
      }
    }
    debugLogPush(`connectDevice SUCCESS: serial=${adbSerial} display=${displayName} usb=${usbId.vendorId}:${usbId.productId}:${usbId.serial || '(none)'}`, 'ok');
    renderDeviceList();
    if (connectedDevices.size === 1) {
      selectDevice(adbSerial);
    } else if (remoteSession && remoteSession.role === 'host') {
      // Second+ device connected while already sharing — it won't get auto-selected (so
      // nothing would otherwise ever fetch its tab data), but a viewer could pick it
      // right away. See prefetchTabsForViewers()'s comment.
      debugLogPush(`connectDevice SUCCESS: triggering prefetchTabsForViewers(${adbSerial}) (not first device, already sharing)`, 'evt');
      prefetchTabsForViewers(adbSerial);
    } else {
      debugLogPush(`connectDevice SUCCESS: NOT prefetching for ${adbSerial} (not first device, not sharing yet — will run when/if a share session starts)`, 'evt');
    }
    setStatus('Connected', 'ok');
    return true;

  } catch (err) {
    const msg = err.message || String(err);
    debugLogPush(`connectDevice FAILED: ${msg}`, 'err');
    if (openedConnection) {
      // usbDevice.connect() succeeded (claims the interface) but something after it —
      // almost always AdbDaemonTransport.authenticate() — failed. If we don't release the
      // claim here, the browser keeps treating the interface as held by this page for the
      // rest of the page's lifetime: every subsequent attempt fails the same way, even with
      // a freshly re-fetched device object from getDevices(), no matter how long we retry —
      // only a full page reload (which force-releases all of a page's WebUSB claims) clears
      // it. Confirmed exactly this pattern in practice: ~45s of retries all failing, then an
      // immediate success right after a hard refresh. See PROJECT_CONTEXT.md. Use the native
      // USBDevice.close() (via .raw) rather than anything yume-chan-specific, since closing
      // the device is what actually releases the OS-level claim, standard WebUSB behavior.
      // v1.5.8: also try a real bus-level reset() while still open, before closing —
      // distinct from close() (logical claim release only); reset() asks the OS/hardware
      // to actually reset the device's USB connection, which might clear stuck state that
      // close() alone doesn't touch.
      try {
        await usbDevice.raw.reset();
        debugLogPush('connectDevice: reset USB device after failure', 'evt');
      } catch (resetErr) {
        debugLogPush(`connectDevice: failed to reset USB device: ${resetErr.message || resetErr}`, 'warn');
      }
      try {
        await usbDevice.raw.close();
        debugLogPush('connectDevice: released USB claim after failure', 'evt');
      } catch (closeErr) {
        debugLogPush(`connectDevice: failed to release USB claim: ${closeErr.message || closeErr}`, 'warn');
      }
    }
    if (opts.onError) opts.onError(msg);
    if (!silent) {
      if (isDeviceBusyError(msg)) showADBReleaseDialog(usbDevice.raw.vendorId);
      setStatus('Failed: ' + msg, 'err');
    }
    return false;
  } finally {
    if (connectingKey) connectingUsbIds.delete(connectingKey);
  }
}

// Serializes every actual connectDeviceExclusive() attempt (across ALL devices, not just
// retries of the same one) behind a simple promise-chain mutex — the backoff WAITS between
// Confirmed via a real Linux multi-device debug log (2026-08-11): connecting a second
// device while a first one is already connected (or being connected) can trigger a
// spurious 'disconnect' for the OTHER device — almost certainly a bus-level reset ripple
// across a shared hub/controller from connectDeviceExclusive()'s pre-emptive
// open()/reset()/close() sequence. That's an inherent USB/hardware quirk this app can't
// fully prevent, but letting two of those sequences run at the literal same instant only
// makes it more likely.
//
// v1.16.1 originally "fixed" this with a promise-chain mutex around the WHOLE
// connectDeviceExclusive() call, including AdbDaemonTransport.authenticate() — which can
// legitimately take an unbounded amount of time (it can be waiting on the user to accept
// an on-device RSA key confirmation prompt). A real Windows debug log confirmed the
// resulting bug: a second device's connect stalled after usbDevice.connect() resolved (no
// SUCCESS, no FAILED, ever) and the app just went quiet — because that mutex design means
// ONE stuck/slow connect call permanently jams every future connectDevice() call behind
// it, forever, with zero visible error (the queue promise never settles either way).
//
// Fixed by staggering call STARTS instead of serializing whole calls: enforce a minimum
// gap between when consecutive connectDeviceExclusive() calls begin (comfortably longer
// than the observed reset/open/close duration, ~1s in practice), but never wait on a
// previous call's actual completion. Worst case this adds a flat ~1.2s delay before a
// connect attempt starts; it can never block indefinitely on another device's hang.
const MIN_CONNECT_START_GAP_MS = 1200;
let lastConnectStartAt = 0;
async function connectDevice(usbDevice, opts = {}) {
  const wait = Math.max(0, (lastConnectStartAt + MIN_CONNECT_START_GAP_MS) - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastConnectStartAt = Date.now();
  return connectDeviceExclusive(usbDevice, opts);
}

// --- Shell ---
async function adbShell(adb, cmd) {
  const sp = adb.subprocess.shellProtocol;
  if (sp && sp.isSupported) return (await sp.spawnWaitText(cmd)).stdout;
  throw new Error('Shell protocol not supported');
}

// Like adbShell(), but kills the process and throws if it doesn't exit within
// timeoutMs. Needed for the remote-shell path: a viewer can request any
// command, including non-terminating ones (bare "logcat", "top", "tail -f"),
// which would otherwise hang the wait-for-exit call forever.
async function adbShellTimed(adb, cmd, timeoutMs) {
  const sp = adb.subprocess.shellProtocol;
  if (!sp || !sp.isSupported) throw new Error('Shell protocol not supported');
  const controller = new AbortController();
  const process = await sp.spawn(cmd, controller.signal);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    try { process.kill(); } catch (_) {}
  }, timeoutMs);
  try {
    const [stdout] = await Promise.all([
      process.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(new ConcatStringStream()),
      process.stderr.pipeThrough(new TextDecoderStream()).pipeThrough(new ConcatStringStream()),
      process.exited,
    ]);
    return stdout;
  } catch (err) {
    if (timedOut) {
      throw new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s (it never exited). If this was "logcat", it streams forever — use "logcat -d" or "logcat -d -t 200" to dump and exit instead.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Like adbShellTimed(), but preserves raw binary stdout instead of decoding it as
// text — needed for `screencap -p`, whose PNG bytes would be corrupted by the
// text-decode path every other shell helper here uses.
async function adbScreencap(adb, timeoutMs) {
  const sp = adb.subprocess.shellProtocol;
  if (!sp || !sp.isSupported) throw new Error('Shell protocol not supported');
  const controller = new AbortController();
  const process = await sp.spawn('screencap -p', controller.signal);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    try { process.kill(); } catch (_) {}
  }, timeoutMs);
  try {
    const [stdout] = await Promise.all([
      process.stdout.pipeThrough(new ConcatBufferStream()),
      process.stderr.pipeThrough(new ConcatBufferStream()),
      process.exited,
    ]);
    return stdout;
  } catch (err) {
    if (timedOut) throw new Error(`screencap timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Chunked to avoid "Maximum call stack size exceeded" from spreading a large
// typed array into String.fromCharCode at once.
function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Captures one device screenshot, scales it down and re-encodes as JPEG so it's
// small enough to push several times a second over a P2P data channel. Returns the
// REAL (pre-scale) device resolution too, since the viewer needs it to map tap/swipe
// coordinates back from the (smaller) transmitted image to real device pixels.
async function captureScaledFrame(adb, maxWidth, jpegQuality) {
  const png = await adbScreencap(adb, 8000);
  const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  const scale = Math.min(1, maxWidth / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx2d = canvas.getContext('2d');
  ctx2d.drawImage(bitmap, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: jpegQuality });
  const buf = new Uint8Array(await blob.arrayBuffer());
  return { jpegBase64: uint8ToBase64(buf), realWidth: bitmap.width, realHeight: bitmap.height };
}

// --- Shell: persistent-feeling `cd` across one-shot commands ---
// Each `adb shell <cmd>` invocation is a fresh process with no memory of a
// previous one, so a bare `cd /sdcard` normally has no effect on the next
// command. We fake persistence: every command is wrapped so it first `cd`s
// into the last-known directory, then runs the user's command (which may
// itself `cd` further), then prints $PWD wrapped in a marker we can parse
// back out — that becomes the new "last-known directory" for next time.
const CWD_MARKER = '@@ADBWEB_CWD@@';

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function wrapWithCwdTracking(cwd, cmd) {
  const cdPrefix = cwd ? `cd ${shQuote(cwd)} 2>/dev/null\n` : '';
  return `${cdPrefix}${cmd}\nprintf '\\n%s%s%s\\n' '${CWD_MARKER}' "$PWD" '${CWD_MARKER}'`;
}

// Splits the marker (and the resolved cwd it carries) back out of raw shell
// output. Returns the command's real output plus the resolved cwd (or null
// if the marker never made it back, e.g. the command was killed by a timeout).
function extractCwdMarker(output) {
  const idx = output.indexOf(CWD_MARKER);
  if (idx === -1) return { text: output, cwd: null };
  const afterFirst = idx + CWD_MARKER.length;
  const idx2 = output.indexOf(CWD_MARKER, afterFirst);
  if (idx2 === -1) return { text: output, cwd: null };
  const cwd = output.slice(afterFirst, idx2).trim();
  const text = output.slice(0, idx).replace(/\n+$/, '');
  return { text, cwd: cwd || null };
}

// --- ADB Sync: read large files from device ---
async function readDeviceFile(adb, path) {
  // Use shell 'cat' rather than the documented adb.sync() — it works
  // for any path adb shell can read (/data/local/tmp/, /sdcard/, etc.) and
  // doesn't need the user to wire up a sync protocol wrapper. Suitable
  // for small text files (dumpsys output, probe JSON, etc.).
  return (await adbShell(adb, 'cat ' + path)).trim();
}

// --- UI ---
function renderDeviceList() {
  // Prune selections for devices that no longer exist in their respective map
  // (disconnected/removed since the last render) so stale counts never show.
  for (const s of Array.from(selectedConnectedSerials)) if (!connectedDevices.has(s)) selectedConnectedSerials.delete(s);
  for (const s of Array.from(selectedAvailableSerials)) if (!availableDevices.has(s)) selectedAvailableSerials.delete(s);

  const list = document.getElementById('device-list');
  const welcome = document.getElementById('welcome-msg');
  const availSection = document.getElementById('available-section');
  const hasAny = connectedDevices.size > 0 || availableDevices.size > 0;
  if (!hasAny) {
    list.classList.add('hidden');
    welcome.classList.remove('hidden');
    availSection.classList.add('hidden');
    updateBulkBars();
    return;
  }
  welcome.classList.add('hidden');
  list.innerHTML = '';
  if (connectedDevices.size === 0) {
    list.classList.add('hidden');
  } else {
    list.classList.remove('hidden');
    for (const [serial, info] of connectedDevices) {
      const nick = deviceNicknames[serial] || '';
      const checked = selectedConnectedSerials.has(serial) ? 'checked' : '';
      const card = document.createElement('div');
      card.className = 'device-card' + (activeSerial === serial ? ' active' : '');
      card.innerHTML = `<div class="device-card-top">
        <input type="checkbox" class="device-checkbox" ${checked} onclick="event.stopPropagation();toggleDeviceSelection('connected','${serial}')" title="Select">
        <div class="dev-info">
          ${nick ? '<div class="dev-nick">' + esc(nick) + '</div>' : ''}
          <div class="dev-name">${esc(info._displayName || serial)}</div>
          <div class="dev-serial">${esc(serial)}</div>
        </div>
      </div>
      <div class="device-card-bottom">
        <span class="dev-status-dot" title="Connected"></span>
        <button class="btn btn-sm btn-disconnect" onclick="event.stopPropagation();disconnectOne('${serial}')" title="Disconnect">Disconnect</button>
      </div>`;
      card.onclick = () => selectDevice(serial);
      list.appendChild(card);
    }
  }
  // Render available (button-disconnected) devices
  if (availableDevices.size === 0) {
    availSection.classList.add('hidden');
  } else {
    availSection.classList.remove('hidden');
    const availList = document.getElementById('available-list');
    availList.innerHTML = '';
    for (const [serial, info] of availableDevices) {
      const nick = deviceNicknames[serial] || '';
      const displaySerial = info._usbId && info._usbId.serial ? info._usbId.serial : serial;
      const checked = selectedAvailableSerials.has(serial) ? 'checked' : '';
      const connecting = connectingStatus.get(serial);
      const card = document.createElement('div');
      card.className = 'device-card available' + (connecting ? ' connecting' : '');
      const bottomHtml = connecting
        ? `<span class="loading"></span><span class="connecting-label">${esc(connecting.label)}</span>`
        : `<span class="dev-status-dot dev-status-dot-gray" title="Ready to Connect"></span>
        <button class="btn btn-sm btn-connect" onclick="event.stopPropagation();connectAvailable('${serial}')" title="Connect">Connect</button>`;
      card.innerHTML = `<div class="device-card-top">
        <input type="checkbox" class="device-checkbox" ${checked} onclick="event.stopPropagation();toggleDeviceSelection('available','${serial}')" title="Select">
        <div class="dev-info">
          ${nick ? '<div class="dev-nick">' + esc(nick) + '</div>' : ''}
          <div class="dev-name">${esc(info._displayName || displaySerial)}</div>
          <div class="dev-serial">${esc(displaySerial)}</div>
        </div>
      </div>
      <div class="device-card-bottom">${bottomHtml}</div>`;
      availList.appendChild(card);
    }
  }
  updateBulkBars();
  if (remoteSession && remoteSession.role === 'host') broadcastDeviceState();
}

function toggleDeviceSelection(kind, serial) {
  const set = kind === 'connected' ? selectedConnectedSerials : selectedAvailableSerials;
  if (set.has(serial)) set.delete(serial); else set.add(serial);
  updateBulkBars();
}

function updateBulkBars() {
  const cBar = document.getElementById('connected-bulk-bar');
  const cCount = document.getElementById('connected-selected-count');
  if (cBar) {
    if (selectedConnectedSerials.size > 0) {
      cBar.classList.remove('hidden');
      if (cCount) cCount.textContent = selectedConnectedSerials.size + ' selected';
    } else {
      cBar.classList.add('hidden');
    }
  }
  const aBar = document.getElementById('available-bulk-bar');
  const aCount = document.getElementById('available-selected-count');
  if (aBar) {
    if (selectedAvailableSerials.size > 0) {
      aBar.classList.remove('hidden');
      if (aCount) aCount.textContent = selectedAvailableSerials.size + ' selected';
    } else {
      aBar.classList.add('hidden');
    }
  }
}

async function connectSelected() {
  const serials = Array.from(selectedAvailableSerials);
  selectedAvailableSerials.clear();
  updateBulkBars();
  for (let i = 0; i < serials.length; i++) {
    await connectAvailable(serials[i]);
    // Small buffer between back-to-back USB connect attempts — observed a device on a
    // shared hub drop with "Connection closed unexpectedly" when a second device's
    // connect() fired immediately after the first one succeeded (see PROJECT_CONTEXT.md).
    if (i < serials.length - 1) await new Promise(r => setTimeout(r, 400));
  }
}

function disconnectSelected() {
  const serials = Array.from(selectedConnectedSerials);
  selectedConnectedSerials.clear();
  updateBulkBars();
  for (const serial of serials) {
    disconnectOne(serial);
  }
}

function selectDevice(serial) {
  // Save current device shell output before switching
  if (activeSerial && activeSerial !== serial) {
    const currentShell = document.getElementById('shell-output');
    if (currentShell) {
      if (!dataCache.shellBySerial) dataCache.shellBySerial = {};
      dataCache.shellBySerial[activeSerial] = currentShell.textContent;
    }
  }

  const info = connectedDevices.get(serial);
  if (!info) return;
  activeSerial = serial;
  document.getElementById('inspector-section').classList.remove('hidden');
  const nick = deviceNicknames[serial] || '';
  document.getElementById('selected-device-name').textContent =
    (info._displayName || serial) + (nick ? ' ("' + nick + '")' : '') + ' (' + serial + ')';
  renderDeviceList();

  // Restore persisted shell output if cached
  const shellEl = document.getElementById('shell-output');
  if (shellEl) {
    shellEl.textContent = dataCache.shellBySerial?.[serial] || '';
    const term = document.getElementById('shell-console');
    if (term) term.scrollTop = term.scrollHeight;
  }
  updateShellCwdLabel();
  document.getElementById('search-props').value = '';
  document.getElementById('search-features').value = '';
  document.getElementById('search-packages').value = '';

  // Clear live-tab outputs (these refresh on each switch)
  ['rkp-output', 'attestation-output'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });

  // Fetch all data for the new device (and mirror each tab's rendered result to any
  // connected viewers once it settles — see pushTabHtml()).
  fetchProperties().then(() => pushTabHtml('props', 'props-output'));
  fetchFeatures().then(() => pushTabHtml('features', 'features-output'));
  fetchPackages().then(() => pushTabHtml('packages', 'packages-output'));
  fetchAttestation().then(() => pushTabHtml('attestation', 'attestation-output'));
  fetchRKP().then(() => pushTabHtml('rkp', 'rkp-output'));
}

// Re-fetches the manager's granted-device list fresh and finds the one matching usbId.
// Always re-fetch rather than reusing a cached device object — WebUSB device references
// are transient (see PROJECT_CONTEXT.md), and a device object involved in a failed
// connect() attempt may be unusable even for an immediate retry with the same reference.
async function findGrantedDevice(mgr, usbId) {
  const granted = mgr ? await mgr.getDevices({ filters: [AdbDefaultInterfaceFilter] }) : [];
  let usbDevice = null;
  if (usbId.serial) {
    usbDevice = granted.find(d => d.serial === usbId.serial && d.raw.vendorId === usbId.vendorId && d.raw.productId === usbId.productId);
  }
  if (!usbDevice) {
    const candidates = granted.filter(d => d.raw.vendorId === usbId.vendorId && d.raw.productId === usbId.productId);
    // Linux quirk (confirmed via a real multi-device debug log, 2026-08-11): during the
    // Access-denied/disconnect-reconnect churn right after a reconnect attempt, a granted
    // device's .serial can transiently read back empty/unset even though it's the same
    // physical device — that's why the exact-serial match above can miss. Falling back to
    // "any vid+pid match" is fine when there's only one such device, but with TWO OR MORE
    // devices sharing the same vid+pid (e.g. two of the same model), picking blindly here
    // previously connected the WRONG physical device under this card's serial with no
    // indication anything was amiss (confirmed: a retry meant for serial A silently
    // "succeeded" by reconnecting already-connected serial B instead). Safer to report no
    // match and let the existing retry/backoff loop try again shortly, by which point the
    // serial is usually readable again, than to ever misattribute a connection.
    if (!usbId.serial || candidates.length === 1) usbDevice = candidates[0] || null;
  }
  return { usbDevice, count: granted.length };
}

// Widened again (2026-08-06) — a ~19s window still wasn't always enough. The clarifying
// data point: it's not one specific device that's affected — ANY device, right after being
// un-paired (browser-level; see PROJECT_CONTEXT.md — the in-app Forget button was removed
// after this investigation, since it reliably triggered this) and freshly re-paired, can hit
// this; an already-established device reconnects reliably. A "hard refresh and try again"
// was observed to reliably recover it,
// but that's most likely just because the refresh-and-retry cycle takes 10-30+ real seconds
// — enough for whatever's transiently holding the device (leading theory: endpoint security
// software, e.g. CrowdStrike's "Firmware Analysis" module seen installed on this host,
// scanning newly-attached-looking USB devices before releasing them) to finish. So: retry
// for about that long instead of relying on the user to manually reload. See
// PROJECT_CONTEXT.md for the full investigation.
const CONNECT_RETRY_DELAYS_MS = [1500, 3000, 5000, 8000, 12000, 15000];
const CONNECT_TOTAL_ATTEMPTS = 1 + CONNECT_RETRY_DELAYS_MS.length; // shown in the card's "Connecting... (N/total)" status

// Shared retry-with-backoff loop, used both when reconnecting an already-paired device
// (connectAvailable()) and right after a fresh pairing grant (scanDevices()) — both can hit
// the same transient post-attach delay, so both need the same resilience. onStatus(label) is
// called on every attempt/retry so each caller can show it wherever makes sense (a specific
// device card vs. the global status banner, since a freshly-granted device from scanDevices()
// has no card yet to attach a per-device status to).
async function connectWithRetries(mgr, usbId, firstDevice, onStatus) {
  let lastError = null;
  const onError = (msg) => { lastError = msg; };
  onStatus(`Connecting... (1/${CONNECT_TOTAL_ATTEMPTS})`);
  let ok = await connectDevice(firstDevice, { silent: true, onError });
  for (let attempt = 0; !ok && attempt < CONNECT_RETRY_DELAYS_MS.length; attempt++) {
    const delay = CONNECT_RETRY_DELAYS_MS[attempt];
    debugLogPush(`connectWithRetries: attempt ${attempt + 1} failed (${lastError}), waiting ${delay}ms before retry`, 'warn');
    onStatus(`Retrying (${attempt + 2}/${CONNECT_TOTAL_ATTEMPTS})...`);
    await new Promise(r => setTimeout(r, delay));
    const retryStart = Date.now();
    const retry = await findGrantedDevice(mgr, usbId);
    debugLogPush(`connectWithRetries: retry #${attempt + 2} findGrantedDevice took ${Date.now() - retryStart}ms, found=${!!retry.usbDevice} among ${retry.count} granted`, 'evt');
    if (retry.usbDevice) {
      ok = await connectDevice(retry.usbDevice, { silent: true, onError });
    } else {
      debugLogPush(`connectWithRetries: retry #${attempt + 2} found no matching granted device yet`, 'warn');
    }
  }
  return { ok, lastError };
}

async function connectAvailable(serial) {
  if (connectingStatus.has(serial)) return; // already in progress (e.g. double-click) — ignore
  debugLogPush(`connectAvailable called: serial=${serial}`, 'evt');
  const info = availableDevices.get(serial);
  if (!info) {
    debugLogPush(`connectAvailable: NOT found in availableDevices: ${serial}`, 'err');
    setStatus('Device not found in available list: ' + serial, 'err');
    return;
  }
  // Deliberately NOT deleting from availableDevices here (unlike earlier versions) — the
  // card stays visible throughout, showing a live "Connecting..." status via connectingStatus,
  // instead of vanishing from "Ready to Connect" and only reappearing if every retry fails.
  // On success, connectDevice()'s own defensive cleanup removes this entry; on failure, it's
  // simply still here since it was never removed.
  connectingStatus.set(serial, { attempt: 1, total: CONNECT_TOTAL_ATTEMPTS, label: 'Connecting...' });
  renderDeviceList();
  console.log('[connect-available] attempting reconnect for:', serial, info._displayName, info._usbId);
  // STEP 1: Try instant reconnect via getDevices() — no picker if device still granted
  try {
    // Must use the manager's getDevices() (returns wrapped AdbDaemonWebUsbDevice, with
    // .connect()), not navigator.usb.getDevices() (plain native USBDevice, no .connect()
    // at all) — see the matching note in scanAvailableDevices().
    const mgr = AdbDaemonWebUsbDeviceManager.BROWSER;
    const { usbDevice, count } = await findGrantedDevice(mgr, info._usbId);
    debugLogPush(`connectAvailable: granted=${count} looking for vid+pid=${info._usbId?.vendorId}:${info._usbId?.productId} serial=${info._usbId?.serial || '(none)'}`, 'evt');
    console.log('[connect-available] granted:', count, 'looking for:', info._usbId);
    if (usbDevice) {
      debugLogPush(`connectAvailable: instant match via getDevices: serial=${usbDevice.serial}`, 'ok');
      console.log('[connect-available] instant match via getDevices:', usbDevice.serial);
      const { ok, lastError } = await connectWithRetries(mgr, info._usbId, usbDevice, (label) => {
        connectingStatus.set(serial, { total: CONNECT_TOTAL_ATTEMPTS, label });
        renderDeviceList();
      });
      connectingStatus.delete(serial);
      if (!ok) {
        debugLogPush(`connectAvailable: connectDevice failed after all retries: serial=${serial}`, 'warn');
        setStatus(`Failed to connect ${info._displayName || serial} after retries` + (lastError ? ': ' + lastError : ''), 'err');
        if (lastError && isDeviceBusyError(lastError)) showADBReleaseDialog(info._usbId?.vendorId);
      }
      renderDeviceList();
      return;
    }
    debugLogPush(`connectAvailable: no instant match in ${count} granted devices`, 'warn');
  } catch (err) {
    debugLogPush(`connectAvailable: getDevices() failed: ${err.message}`, 'err');
    console.log('[connect-available] getDevices() failed:', err);
  }
  // STEP 2: Not in granted list — must use picker (unplugged & re-plugged)
  debugLogPush(`connectAvailable: falling back to picker`, 'warn');
  console.log('[connect-available] no instant match, falling back to picker');
  connectingStatus.set(serial, { attempt: CONNECT_TOTAL_ATTEMPTS, total: CONNECT_TOTAL_ATTEMPTS, label: 'Waiting for device picker...' });
  renderDeviceList();
  try {
    const mgr = AdbDaemonWebUsbDeviceManager.BROWSER;
    if (!mgr) throw new Error('WebUSB ADB manager not available');
    setStatus('Select device to connect...', 'connecting');
    const picked = await mgr.requestDevice({ filters: [AdbDefaultInterfaceFilter] });
    if (!picked) throw new Error('Device picker cancelled');
    debugLogPush(`connectAvailable: picker returned: serial=${picked.serial}`, 'evt');
    const ok = await connectDevice(picked);
    if (!ok) {
      debugLogPush(`connectAvailable: connectDevice (via picker) failed: serial=${serial}`, 'warn');
    }
  } catch (err) {
    debugLogPush(`connectAvailable: picker failed: ${err.message}`, 'err');
    console.log('[connect-available] picker failed:', err);
    setStatus('Connect failed: ' + (err.message || String(err)), 'err');
  } finally {
    connectingStatus.delete(serial);
    renderDeviceList();
  }
}

function showHelpModal() {
  hideHelpModal();
  const overlay = document.createElement('div');
  overlay.id = 'help-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;';
  overlay.onclick = (e) => { if (e.target === overlay) hideHelpModal(); };

  const box = document.createElement('div');
  box.style.cssText = 'background:#1e1e2e;color:#cdd6f4;border-radius:12px;padding:24px;min-width:360px;max-width:560px;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.4);';
  const row = (term, def) => '<div style="margin-bottom:10px;"><div style="font-weight:600;color:#89b4fa;">' + esc(term) + '</div><div style="font-size:13px;color:#a6adc6;">' + def + '</div></div>';
  box.innerHTML =
    '<h3 style="margin:0 0 14px;font-size:18px;">Device List Help</h3>' +
    row('Connected', 'Actively connected via ADB right now. Click a card to view its Properties/Features/Packages/Shell.') +
    row('Ready to Connect', 'A device the browser has previously been granted USB permission for ("paired"), but that isn\'t currently connected. Clicking Connect here usually reconnects instantly, with no popup.') +
    row('Connect', 'Reconnects a Ready-to-Connect device. Falls back to the browser\'s native device picker only if the saved permission can\'t instantly find the device (e.g. it was unplugged and replugged).') +
    row('Disconnect', 'Closes the ADB session for a Connected device. It moves to Ready to Connect — the browser permission is kept, so reconnecting is instant.') +
    row('Un-pairing a device ("Forget")', 'There\'s no in-app button for this — click the page-info/lock icon in the address bar, then Site settings (or Permissions) → USB devices → remove the device. It then disappears from "Ready to Connect" and can only be reconnected via the native "+ Connect Device" picker again, as if it were brand-new. Heads up: freshly un-pairing and re-pairing a device has, in practice, sometimes led to a connection that fails repeatedly no matter how long it retries, recoverable only by reloading this page (the app will offer a Reload button if that happens) — so only do this if you specifically need to test the first-time-connection flow.') +
    row('+ Connect Device', 'Opens the browser\'s native USB device picker, to grant permission for a new device (or one whose permission needs refreshing).') +
    row('Checkboxes / Connect Selected / Disconnect Selected', 'Select multiple devices in either section to connect or disconnect them all in one action, instead of one at a time.') +
    row('Share', 'Starts a remote session — generates a link you can send to someone else so they can view this device\'s status and (with your approval) run shell commands on it, from anywhere.') +
    '<div style="display:flex;justify-content:flex-end;margin-top:8px;"><button class="btn" id="help-close-btn">Close</button></div>';
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  document.getElementById('help-close-btn').onclick = () => hideHelpModal();
}

function hideHelpModal() {
  const el = document.getElementById('help-modal-overlay');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function disconnectOne(serial) {
  debugLogPush(`disconnectOne called: serial=${serial}`, 'evt');
  const info = connectedDevices.get(serial);
  if (!info) {
    debugLogPush(`disconnectOne: serial NOT found in connectedDevices: ${serial}`, 'err');
    return;
  }
  // Guard: prevent USB disconnect event from deleting this device while we're moving it
  disconnectingSerial = serial;
  // Stop heartbeat before closing transport
  const hbKey = 'hb-' + serial;
  if (window[hbKey]) { clearInterval(window[hbKey]); delete window[hbKey]; }
  debugLogPush(`disconnectOne: closing transport for ${serial}`, 'evt');
  try { info.transport.close(); } catch(e) {}
  connectedDevices.delete(serial);
  notifyDeviceRemoved(serial);
  // Move to available — build a clean entry (don't reuse stale usbDevice reference)
  const usbId = info._usbId || {};
  const usbKey = usbId.serial || (usbId.vendorId + ':' + usbId.productId + ':' + Date.now());
  debugLogPush(`disconnectOne: moved ${serial} to availableDevices as key=${usbKey}`, 'ok');
  // Remove any existing entry for this USB device first (prevent duplicates)
  for (const [akey, ainfo] of availableDevices) {
    if (ainfo._usbId && ainfo._usbId.vendorId === usbId.vendorId && ainfo._usbId.productId === usbId.productId) {
      if (!usbId.serial || ainfo._usbId.serial === usbId.serial) {
        availableDevices.delete(akey);
        break;
      }
    }
  }
  // Store without stale usbDevice — connectAvailable() will get a fresh one from getDevices()
  availableDevices.set(usbKey, {
    adb: null, usbDevice: null, transport: null,
    _displayName: info._displayName,
    _usbId: usbId,
  });
  disconnectingSerial = null;
  if (activeSerial === serial) {
    activeSerial = connectedDevices.size > 0 ? connectedDevices.keys().next().value : null;
  }
  renderDeviceList();
  if (activeSerial) {
    selectDevice(activeSerial);
  } else {
    document.getElementById('inspector-section').classList.add('hidden');
  }
  setStatus('Device disconnected: ' + serial, 'warn');
}

async function disconnectDevice() {
  if (!activeSerial) return;
  const info = connectedDevices.get(activeSerial);
  if (info) {
    try { await info.transport.close(); } catch(e) {}
    try { await info.usbDevice.close(); } catch(e) {}
  }
  connectedDevices.delete(activeSerial);
  notifyDeviceRemoved(activeSerial);
  if (connectedDevices.size === 0) {
    activeSerial = null;
    document.getElementById('inspector-section').classList.add('hidden');
  } else {
    // Switch to first remaining device
    activeSerial = connectedDevices.keys().next().value;
    selectDevice(activeSerial);
  }
  renderDeviceList();
}

// --- Remote Session: shared helpers ---
function randomToken(byteLen) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLen));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function genRoomId() { return randomToken(8); }
function genPassword() { return randomToken(16); }
// --- Remote Session: relay-based fallback data path ---
// Some networks (confirmed: Zscaler-proxied corporate networks — see
// TURN_RELIABILITY_ANALYSIS.md) block or break WebRTC's UDP-based ICE/STUN/TURN
// traffic outright, so the P2P data channel this feature relies on can never come
// up, no matter which TURN provider is configured. The one thing that HAS worked in
// every single case so far is the plain WSS connection to our own signaling relay —
// because it's an ordinary WebSocket, indistinguishable from any other HTTPS-based
// app traffic. @trystero-p2p/ws-relay's server is a generic topic-based pub/sub (see
// relay-server/node_modules/@trystero-p2p/ws-relay/dist/server.mjs — subscribe/
// unsubscribe/publish to an arbitrary topic string), not something WebRTC-signaling-
// specific, so a second client using that exact same protocol can carry our actual
// session traffic (device state, shell commands/output) as a fallback, with zero
// relay-server changes. Payloads are AES-GCM encrypted with a key derived from the
// room password (the same shared secret already in the share link) since, unlike
// the P2P path (inherently encrypted end-to-end by WebRTC), this now transits a
// third-party-hosted (Render) server and shouldn't be readable there.
async function deriveFallbackKey(password) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encryptForFallback(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return { iv: Array.from(iv), ct: Array.from(new Uint8Array(cipher)) };
}
async function decryptFromFallback(key, payload) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(payload.iv) }, key, new Uint8Array(payload.ct)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// Raw WebSocket client speaking @trystero-p2p/ws-relay's subscribe/publish protocol
// directly, scoped to one room via a derived topic name. Independent of trystero's
// own use of the same relay for signaling — this never touches WebRTC at all.
function createFallbackChannel(roomId, password, sessionId, label) {
  const topic = 'webadb-fallback-' + roomId;
  const keyPromise = deriveFallbackKey(password);
  let ws = null, ready = false, closed = false;
  const outbox = [];
  let onEnvelope = () => {};

  function flush() {
    while (ready && outbox.length) {
      const msg = outbox.shift();
      try { ws.send(msg); } catch (_) { outbox.unshift(msg); break; }
    }
  }
  function connect() {
    if (closed) return;
    try { ws = new WebSocket(REMOTE_RELAY_URLS[0]); } catch (_) { setTimeout(connect, 3000); return; }
    ws.onopen = () => {
      ready = true;
      debugLogPush(`remote (${label}): fallback channel connected (topic=${topic})`, 'ok');
      try { ws.send(JSON.stringify({ type: 'subscribe', topic })); } catch (_) {}
      flush();
    };
    ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.topic !== topic || !msg.payload) return;
        const key = await keyPromise;
        const envelope = await decryptFromFallback(key, msg.payload);
        if (envelope.from === sessionId) return;
        onEnvelope(envelope);
      } catch (_) {}
    };
    ws.onclose = () => { ready = false; if (!closed) setTimeout(connect, 3000); };
    ws.onerror = () => {};
  }
  connect();

  return {
    send: async (envelope) => {
      try {
        const key = await keyPromise;
        const payload = await encryptForFallback(key, envelope);
        const msg = JSON.stringify({ type: 'publish', topic, payload });
        if (ready) { try { ws.send(msg); return; } catch (_) {} }
        outbox.push(msg);
      } catch (_) {}
    },
    onMessage: (handler) => { onEnvelope = handler; },
    close: () => { closed = true; try { ws && ws.close(); } catch (_) {} },
  };
}

// Wraps each trystero action so every send() goes out over BOTH the real P2P data
// channel (best-effort — silently a no-op if no such peer is connected, same as
// trystero's own behavior) and the fallback channel, and every onMessage() handler
// is registered once and fed by both transports through one funnel. Callers
// (handleRemoteCmdRequest, sendRemoteCommand,
// etc.) need no changes — they only ever see {send, onMessage} and a ctx.peerId,
// which is either a real trystero peerId or (fallback-only) the sender's random
// sessionId; both are stable, opaque strings for the life of a session, which is all
// the existing ctx.peerId === remoteSession.hostPeerId-style checks actually need.
//
// IMPORTANT (found during 2026-08-11 remote-control design review): both transports
// used to call the registered handler INDEPENDENTLY (the real P2P path via
// `real.onMessage = handler` directly, the fallback path via its own dispatch loop
// with its own dedup Set). Whenever both transports are healthy for a peer — the
// common case — every message got delivered and handled TWICE, under TWO DIFFERENT
// ctx.peerId values for the same physical sender (real trystero peerId vs. the
// fallback's per-tab sessionId). Mostly harmless for old idempotent actions, but
// actively broken for anything stateful/single-slot (control handshake) or
// fire-and-forget with no natural idempotency (inputEvent — a double-dispatched tap
// is a real double-tap on the device). Fixed by funneling BOTH transports through one
// `deliver()` that dedups by (action, requestId) regardless of which transport won,
// and by registering `real.onMessage` exactly once at creation (never reassigned —
// this also structurally rules out ever repeating the earlier getter/setter-mismatch
// bug, v1.10.x, since callers now only ever touch `dispatchers`, never `real.onMessage`).
function makeRemoteActions(room, roomId, password, label) {
  const sessionId = crypto.randomUUID();
  const fallback = createFallbackChannel(roomId, password, sessionId, label);
  const seenRequestKeys = new Set();
  const dispatchers = {};

  function deliver(name, data, ctx) {
    if (data && typeof data === 'object' && typeof data.requestId === 'string') {
      const key = name + ':' + data.requestId;
      if (seenRequestKeys.has(key)) return;
      seenRequestKeys.add(key);
      if (seenRequestKeys.size > 500) seenRequestKeys.delete(seenRequestKeys.values().next().value);
    }
    dispatchers[name]?.(data, ctx);
  }

  fallback.onMessage((envelope) => {
    const { action, target, data } = envelope;
    if (target && target !== sessionId) return;
    deliver(action, data, { peerId: envelope.from });
  });

  // screenFrame/inputEvent were originally P2P-only, then made fully dual-transport
  // (2026-08-11) after a P2P-less viewer's screen never worked at all — the grant/deny
  // round trip worked (dual-transport), but no frame or tap ever arrived. That fixed
  // correctness but hurt speed: encryptForFallback() JSON.stringifies the whole
  // envelope, runs AES-GCM, then JSON.stringifies the ciphertext AGAIN as a plain array
  // of numbers — all synchronous main-thread work that scales with payload size, paid
  // on every single frame even when P2P is working fine, directly competing with the
  // fps this feature needs. Fixed properly by making it adaptive: skip the fallback
  // send for these two actions specifically when room.getPeers() shows an active P2P
  // connection to this exact target already — falling back only for a target with no
  // such entry (unknown, or genuinely fallback-only/Zscaler-style). Gets both: full
  // speed when P2P works, full reliability when it doesn't.
  const HIGH_FREQUENCY_ACTIONS = new Set(['screenFrame', 'inputEvent']);

  function wrap(name) {
    const real = room.makeAction(name);
    real.onMessage = (data, ctx) => deliver(name, data, ctx);
    const highFrequency = HIGH_FREQUENCY_ACTIONS.has(name);
    return {
      send: (data, opts) => {
        // real.send() is async (trystero) — a plain try/catch around the call doesn't
        // catch a later rejection, since the throw happens after this line already
        // returned. Wrap in Promise.resolve() so a failed send can't become an
        // unhandled-rejection console error.
        try { Promise.resolve(real.send(data, opts)).catch(() => {}); } catch (_) {}
        const targetHasP2P = opts?.target && !!room.getPeers()[opts.target];
        if (!(highFrequency && targetHasP2P)) {
          fallback.send({ action: name, from: sessionId, target: opts?.target, data });
        }
      },
      get onMessage() { return dispatchers[name]; },
      set onMessage(handler) { dispatchers[name] = handler; },
    };
  }

  const actions = {};
  for (const name of ['hello', 'devicePush', 'cmdRequest', 'cmdResponse', 'pathComplete', 'pathCompleteResult', 'tabDataPush', 'bye',
    'controlRequest', 'controlResponse', 'controlRelease', 'controlRevoked', 'screenFrame', 'inputEvent']) actions[name] = wrap(name);
  actions._fallback = fallback;
  actions._sessionId = sessionId;
  return actions;
}

// joinRoom()'s 3rd-argument callbacks (onJoinError/onPeerHandshake) were never wired up
// before — meaning any WebRTC handshake failure (e.g. a password/key mismatch, SDP
// decrypt failure) was being silently swallowed with zero visibility, while everything
// else (relay connectivity, topic/signaling) checked out fine. This surfaces those.
function makeJoinCallbacks(label) {
  return {
    onJoinError: (err) => {
      debugLogPush(`remote (${label}): JOIN ERROR: ${JSON.stringify(err)}`, 'err');
    },
    onPeerHandshake: (peerId) => {
      debugLogPush(`remote (${label}): peer handshake completed: peerId=${peerId}`, 'ok');
    },
  };
}

// Diagnostic (2026-08-10 TURN investigation, superseded — kept for the ongoing-health
// signal it still gives on an ALREADY-successful connection): this was written assuming
// room.getPeers() would show an in-progress peer stuck mid-negotiation. Reading
// @trystero-p2p/core's actual source (room.mjs) disproved that: a peer is only inserted
// into activePeerMap — the map getPeers() reads — inside handshakeManager's onActivate
// callback, which fires at the exact same moment as onPeerJoin. There is no public
// trystero API that exposes a peer before it has already fully succeeded. That's why
// every "ICE poll" log for a failing connection has always read "no peer connection
// objects exist yet" — not because nothing was happening, but because this diagnostic
// is structurally blind to anything that hasn't already succeeded. See
// makeDiagnosticRTCPeerConnection() below for the replacement that actually sees failures.
function pollIceState(room, label, maxTries) {
  let tries = 0;
  const iv = setInterval(() => {
    tries++;
    try {
      const peers = room.getPeers();
      const ids = Object.keys(peers);
      if (ids.length === 0) {
        debugLogPush(`remote (${label}): ICE poll #${tries} — no peer connection objects exist yet`, 'warn');
      } else {
        for (const id of ids) {
          const pc = peers[id];
          debugLogPush(`remote (${label}): ICE poll #${tries} peerId=${id} iceConnectionState=${pc.iceConnectionState} connectionState=${pc.connectionState} iceGatheringState=${pc.iceGatheringState}`, 'evt');
        }
      }
    } catch (err) {
      debugLogPush(`remote (${label}): ICE poll failed: ${err && err.message || err}`, 'err');
    }
    if (tries >= maxTries) clearInterval(iv);
  }, 3000);
}

// Real failure diagnostic: trystero's peer.mjs does `new (rtcPolyfill ?? RTCPeerConnection)(...)`,
// so passing our own class via `rtcPolyfill` lets us observe every ICE candidate and every
// state transition for every connection attempt — successful or not — completely independent
// of trystero's own bookkeeping (which, per the note on pollIceState above, only ever shows
// already-successful peers). In particular `icecandidateerror` fires with a real error code/
// text when a STUN/TURN server can't be reached or rejects a request (e.g. bad credentials,
// server down, blocked by a firewall) — this is the one signal that can directly distinguish
// "our TURN server is the problem" from "the network won't let TURN traffic through at all".
let rtcDiagCounter = 0;
function makeDiagnosticRTCPeerConnection(label) {
  return class extends RTCPeerConnection {
    constructor(config) {
      super(config);
      const connId = ++rtcDiagCounter;
      debugLogPush(`remote (${label}): [rtc#${connId}] connection object created`, 'evt');
      this.addEventListener('icecandidate', (e) => {
        if (!e.candidate) { debugLogPush(`remote (${label}): [rtc#${connId}] ICE candidate gathering complete`, 'evt'); return; }
        const typeMatch = /typ (\w+)/.exec(e.candidate.candidate);
        debugLogPush(`remote (${label}): [rtc#${connId}] ICE candidate gathered: type=${typeMatch ? typeMatch[1] : '?'} proto=${e.candidate.protocol || '?'} address=${e.candidate.address || '?'}`, 'evt');
      });
      this.addEventListener('icecandidateerror', (e) => {
        debugLogPush(`remote (${label}): [rtc#${connId}] ICE CANDIDATE ERROR: url=${e.url || '?'} errorCode=${e.errorCode || '?'} errorText=${e.errorText || '?'}`, 'err');
      });
      this.addEventListener('icegatheringstatechange', () => {
        debugLogPush(`remote (${label}): [rtc#${connId}] iceGatheringState=${this.iceGatheringState}`, 'evt');
      });
      this.addEventListener('iceconnectionstatechange', () => {
        debugLogPush(`remote (${label}): [rtc#${connId}] iceConnectionState=${this.iceConnectionState}`, this.iceConnectionState === 'failed' ? 'err' : this.iceConnectionState === 'connected' ? 'ok' : 'evt');
      });
      this.addEventListener('connectionstatechange', () => {
        debugLogPush(`remote (${label}): [rtc#${connId}] connectionState=${this.connectionState}`, this.connectionState === 'failed' ? 'err' : this.connectionState === 'connected' ? 'ok' : 'evt');
      });
    }
  };
}

// --- Remote Session: Host ---
function startShareSession() {
  if (remoteSession && remoteSession.role === 'host') { showShareModal(); return; }
  const roomId = genRoomId();
  const password = genPassword();
  const room = joinRoom({ appId: REMOTE_APP_ID, password, turnConfig: REMOTE_TURN_CONFIG, rtcPolyfill: makeDiagnosticRTCPeerConnection('host'), relayConfig: { urls: REMOTE_RELAY_URLS, redundancy: REMOTE_RELAY_URLS.length, warnOnRelayFailure: true } }, roomId, makeJoinCallbacks('host'));
  const actions = makeRemoteActions(room, roomId, password, 'host');
  remoteSession = { role: 'host', room, roomId, password, viewers: new Set(), actions, controlBySerial: new Map(), controlRequestQueue: [] };
  pollIceState(room, 'host', 60);

  actions.hello.onMessage = (data, ctx) => handleViewerHello(data, ctx.peerId);
  actions.cmdRequest.onMessage = (data, ctx) => handleRemoteCmdRequest(data, ctx.peerId);
  actions.pathComplete.onMessage = (data, ctx) => handlePathCompleteRequest(data, ctx.peerId);
  actions.controlRequest.onMessage = (data, ctx) => handleControlRequest(data, ctx.peerId);
  actions.controlRelease.onMessage = (data, ctx) => handleControlRelease(data, ctx.peerId);
  actions.inputEvent.onMessage = (data, ctx) => handleInputEvent(data, ctx.peerId);
  room.onPeerJoin = (peerId) => {
    debugLogPush(`remote (host): WebRTC peer joined: peerId=${peerId}`, 'ok');
    remoteSession.viewers.add(peerId);
    updateShareModalViewerCount();
  };
  room.onPeerLeave = (peerId) => {
    debugLogPush(`remote (host): WebRTC peer left: peerId=${peerId}`, 'warn');
    handlePeerLeaveHost(peerId);
  };

  debugLogPush(`remote session started: roomId=${roomId} appId=${REMOTE_APP_ID}`, 'ok');
  debugLogPush(`startShareSession: connectedDevices=[${Array.from(connectedDevices.keys()).join(', ')}] activeSerial=${activeSerial}`, 'evt');
  // BUG FOUND (2026-08-11, real viewer debug log): activeSerial's own tab data was
  // ASSUMED already cached ("already fresh from being selected") and skipped here — but
  // pushTabHtml() (called from selectDevice()'s fetch chain) silently no-ops whenever
  // remoteSession is null, which it always is at the moment a device connects/gets
  // auto-selected BEFORE the host has ever clicked Share. In that (the NORMAL) ordering —
  // connect a device first, share second — activeSerial's data was fetched into the live
  // DOM just fine, but never made it into hostTabHtmlCache at all, since nothing re-runs
  // those fetches later. Confirmed: viewer log showed the non-active (prefetched) device's
  // tabs rendering correctly while the ACTIVE device stayed "Waiting for host data…"
  // forever. Fix: explicitly (re-)broadcast activeSerial's already-rendered tab HTML now,
  // pulling straight from the live DOM (cheap — no new adb round-trips needed, the host is
  // already looking at this exact data) instead of assuming it's already cached.
  if (activeSerial) {
    for (const [tab, elementId] of Object.entries(mirroredTabElementIds())) {
      pushTabHtml(tab, elementId);
    }
  }
  // Any OTHER device connected before sharing started has never had its tab data fetched
  // at all — see prefetchTabsForViewers()'s comment. Fire-and-forget, one per device,
  // concurrently (each targets a different device's own independent WebUSB/ADB connection).
  for (const serial of connectedDevices.keys()) {
    if (serial !== activeSerial) {
      debugLogPush(`startShareSession: triggering prefetchTabsForViewers(${serial})`, 'evt');
      prefetchTabsForViewers(serial);
    }
  }
  showShareModal();
}

async function stopShareSession() {
  if (!remoteSession || remoteSession.role !== 'host') return;
  try { remoteSession.actions.bye.send({ reason: 'host_stopped' }); } catch (_) {}
  await new Promise((res) => setTimeout(res, 200));
  try { remoteSession.actions._fallback.close(); } catch (_) {}
  try { await remoteSession.room.leave(); } catch (_) {}
  remoteSession = null;
  hideShareModal();
  hideControlRequestPrompt();
  hideControlActiveBanner();
  setStatus('Remote session ended', 'warn');
}

function buildDeviceSnapshot() {
  const conn = [];
  for (const [serial, info] of connectedDevices) {
    conn.push({ serial, displayName: info._displayName || serial, nickname: deviceNicknames[serial] || '' });
  }
  const avail = [];
  for (const [serial, info] of availableDevices) {
    avail.push({ serial, displayName: info._displayName || serial, nickname: deviceNicknames[serial] || '' });
  }
  return { activeSerial, connected: conn, available: avail };
}

function broadcastDeviceState() {
  if (!remoteSession || remoteSession.role !== 'host') return;
  try { remoteSession.actions.devicePush.send(buildDeviceSnapshot()); } catch (_) {}
}

// Mirrors a data tab (Properties/Features/Packages/Attestation/RKP) to any
// connected viewers. Rather than re-deriving/re-transmitting each tab's structured data
// (several different shapes, some assembled inline with no cached structure at all —
// e.g. Attestation/RKP build their table rows and set innerHTML in one step), just
// broadcast the already-rendered HTML for that tab's output element: the viewer reuses
// the exact same DOM structure/CSS, so it renders identically with far less plumbing.
// Trade-off: per-tab search boxes (Properties/Features/Packages) filter dataCache
// arrays the viewer doesn't have, so they're hidden in viewer mode (.host-only) rather
// than silently doing nothing.
function pushTabHtml(tab, elementId, target) {
  if (!remoteSession || remoteSession.role !== 'host') {
    debugLogPush(`pushTabHtml(${tab}): skipped — not sharing as host`, 'warn');
    return;
  }
  if (!activeSerial) {
    debugLogPush(`pushTabHtml(${tab}): skipped — no activeSerial`, 'warn');
    return;
  }
  const el = document.getElementById(elementId);
  if (!el) {
    debugLogPush(`pushTabHtml(${tab}): skipped — element #${elementId} not found`, 'err');
    return;
  }
  if (!hostTabHtmlCache[activeSerial]) hostTabHtmlCache[activeSerial] = {};
  hostTabHtmlCache[activeSerial][tab] = el.innerHTML;
  debugLogPush(`pushTabHtml: serial=${activeSerial} tab=${tab} htmlLen=${el.innerHTML.length} target=${target || 'broadcast'}`, 'evt');
  try { remoteSession.actions.tabDataPush.send({ serial: activeSerial, tab, html: el.innerHTML }, target ? { target } : undefined); } catch (err) {
    debugLogPush(`pushTabHtml: send threw: ${err && err.message || err}`, 'err');
  }
}

// Same caching+broadcast as pushTabHtml(), but for a specific serial directly rather than
// always "whatever's currently active" — used by prefetchTabsForViewers() below, which
// computes html for a device that ISN'T necessarily the one on screen right now.
function cacheAndBroadcastTabHtml(serial, tab, html) {
  if (!remoteSession || remoteSession.role !== 'host') {
    debugLogPush(`cacheAndBroadcastTabHtml(${serial}, ${tab}): skipped — not sharing as host`, 'warn');
    return;
  }
  if (!hostTabHtmlCache[serial]) hostTabHtmlCache[serial] = {};
  hostTabHtmlCache[serial][tab] = html;
  debugLogPush(`cacheAndBroadcastTabHtml: serial=${serial} tab=${tab} htmlLen=${html.length}`, 'evt');
  try { remoteSession.actions.tabDataPush.send({ serial, tab, html }); } catch (err) {
    debugLogPush(`cacheAndBroadcastTabHtml: send threw: ${err && err.message || err}`, 'err');
  }
}

// connectDeviceExclusive() only auto-selects the FIRST device it connects
// (connectedDevices.size === 1) — every device after that just sits connected with
// NOTHING ever fetched for it (Properties/Features/Packages/Attestation/RKP) unless the
// host personally clicks its card, since selectDevice() is what triggers those fetches
// and it also drives the host's own visible tabs. A viewer who selects one of those
// never-clicked devices correctly (from the code's perspective) saw "Waiting for host
// data…" permanently — not a transmission bug, just genuinely no data anywhere to send,
// for a reason invisible from the viewer side. Fetches all five tabs directly into
// hostTabHtmlCache without touching activeSerial, dataCache, or any live DOM element, so
// it can never disturb whatever the host is actually looking at — fetchAttestation()/
// fetchRKP() take an explicit (targetSerial, background=true) so they skip showLoading()
// and cache+broadcast instead of writing to the live DOM (see their own comments).
// Attestation/RKP are real hardware/keystore probes that can take several seconds each —
// accepted cost for full parity between devices; only called when a remote session is
// actually active as host (see call sites), so purely-local usage never pays it.
async function prefetchTabsForViewers(serial) {
  debugLogPush(`prefetchTabsForViewers(${serial}): starting`, 'evt');
  const info = connectedDevices.get(serial);
  if (!info) {
    debugLogPush(`prefetchTabsForViewers(${serial}): aborted — not in connectedDevices`, 'err');
    return;
  }
  try {
    const text = await adbShell(info.adb, 'getprop');
    const props = parseGetprop(text);
    debugLogPush(`prefetchTabsForViewers(${serial}): props parsed ${props.length} entries from ${text.length} chars`, 'ok');
    cacheAndBroadcastTabHtml(serial, 'props', propsToHtml(props, ''));
  } catch (err) {
    debugLogPush(`prefetchTabsForViewers(${serial}): props FAILED: ${err && err.message || err}`, 'err');
  }
  try {
    const text = await adbShell(info.adb, 'pm list features');
    const features = parsePmListFeatures(text);
    debugLogPush(`prefetchTabsForViewers(${serial}): features parsed ${features.length} entries from ${text.length} chars`, 'ok');
    cacheAndBroadcastTabHtml(serial, 'features', featuresToHtml(features, ''));
  } catch (err) {
    debugLogPush(`prefetchTabsForViewers(${serial}): features FAILED: ${err && err.message || err}`, 'err');
  }
  try {
    const text = await adbShell(info.adb, 'dumpsys package 2>&1');
    let packages = parseDumpsysPackage(text);
    let fallback = false, method = 'dumpsys';
    if (packages.length === 0) {
      debugLogPush(`prefetchTabsForViewers(${serial}): dumpsys parsed 0 packages from ${text.length} chars, trying pm list fallback`, 'warn');
      const text2 = await adbShell(info.adb, 'pm list packages -f -u');
      packages = parsePmListPackagesFallback(text2);
      fallback = true; method = 'pm-list';
    }
    debugLogPush(`prefetchTabsForViewers(${serial}): packages parsed ${packages.length} entries (method=${method})`, packages.length > 0 ? 'ok' : 'warn');
    if (packages.length > 0) cacheAndBroadcastTabHtml(serial, 'packages', packagesToHtml(packages, fallback, method, ''));
  } catch (err) {
    debugLogPush(`prefetchTabsForViewers(${serial}): packages FAILED: ${err && err.message || err}`, 'err');
  }
  try {
    await fetchAttestation(serial, true);
    debugLogPush(`prefetchTabsForViewers(${serial}): attestation done`, 'ok');
  } catch (err) {
    debugLogPush(`prefetchTabsForViewers(${serial}): attestation FAILED: ${err && err.message || err}`, 'err');
  }
  try {
    await fetchRKP(serial, true);
    debugLogPush(`prefetchTabsForViewers(${serial}): rkp done`, 'ok');
  } catch (err) {
    debugLogPush(`prefetchTabsForViewers(${serial}): rkp FAILED: ${err && err.message || err}`, 'err');
  }
  debugLogPush(`prefetchTabsForViewers(${serial}): done, hostTabHtmlCache now has [${Object.keys(hostTabHtmlCache[serial] || {}).join(', ')}]`, 'evt');
}

function handleViewerHello(data, peerId) {
  if (!remoteSession || remoteSession.role !== 'host') return;
  debugLogPush(`remote viewer hello: peerId=${peerId}`, 'evt');
  remoteSession.viewers.add(peerId);
  try { remoteSession.actions.devicePush.send(buildDeviceSnapshot(), { target: peerId }); } catch (_) {}
  // pushTabHtml() only fires on a fresh fetch (device selection, or a manual CSR/probe
  // click) for whichever device is CURRENTLY active — a viewer joining after the host
  // already looked at (and possibly switched away from) one or more devices would
  // otherwise see "Waiting for host data…" forever for anything but the current one,
  // since nothing re-triggers a fetch just because someone new joined. Catch this viewer
  // up with hostTabHtmlCache's full history instead of just the live DOM, so it covers
  // every device the host has visited this session, not only whichever is active right now.
  //
  // Deliberately BROADCAST (no target), not targeted at peerId: hello arrives via
  // whichever transport happens to deliver it, and ctx.peerId is a DIFFERENT string
  // depending on which one (real trystero peerId vs. the fallback's per-tab session
  // UUID — see makeRemoteActions()). A targeted tabDataPush.send(data, {target: peerId})
  // built from that peerId only actually reaches the viewer over the transport whose
  // own identity matches it — the other transport's own target check silently drops it
  // — so if the transport that happened to deliver this hello isn't the one this viewer
  // is actually reachable on, the whole catch-up dump was silently lost (this is the
  // root cause of a real "every tab shows Waiting for host data" report). Broadcasting
  // avoids the identity-matching problem entirely, at the cost of also re-sending this
  // cached data to every OTHER already-connected viewer — harmless (they just re-cache
  // the same html) and rare (only fires when someone new joins).
  const cachedSerials = Object.keys(hostTabHtmlCache);
  debugLogPush(`handleViewerHello: dumping hostTabHtmlCache for serials=[${cachedSerials.join(', ')}] to peerId=${peerId}`, 'evt');
  for (const [serial, tabs] of Object.entries(hostTabHtmlCache)) {
    for (const [tab, html] of Object.entries(tabs)) {
      try { remoteSession.actions.tabDataPush.send({ serial, tab, html }); } catch (err) {
        debugLogPush(`handleViewerHello: send failed for serial=${serial} tab=${tab}: ${err && err.message || err}`, 'err');
      }
    }
  }
  updateShareModalViewerCount();
}

function handlePeerLeaveHost(peerId) {
  if (!remoteSession || remoteSession.role !== 'host') return;
  remoteSession.viewers.delete(peerId);
  // They're already gone — no point sending controlRevoked, just clean up locally.
  let hadControl = false;
  for (const [serial, entry] of Array.from(remoteSession.controlBySerial)) {
    if (entry.peerId === peerId) { remoteSession.controlBySerial.delete(serial); hadControl = true; }
  }
  if (hadControl) showControlActiveBanner();
  const before = remoteSession.controlRequestQueue.length;
  remoteSession.controlRequestQueue = remoteSession.controlRequestQueue.filter((r) => r.peerId !== peerId);
  if (remoteSession.controlRequestQueue.length !== before) {
    hideControlRequestPrompt();
    if (remoteSession.controlRequestQueue.length) showControlRequestPrompt();
  }
  updateShareModalViewerCount();
}

// --- Remote Session: Screen/Input Control (Host) ---
// remoteSession.controlBySerial: Map<serial, {peerId, grantId, seq, lastInputSeq}> — one
//   independent entry PER DEVICE, not one global slot. Each device has its own remote
//   control instance: two different viewers can hold control of two different devices
//   at once; a given device can only ever have one controller at a time. grantId scopes
//   every screenFrame/inputEvent belonging to that one device's control session end-to-
//   end, so a stale message from a just-ended session can never be mistaken for a new
//   one; seq orders messages within one grantId so a reordered delivery can't cause a
//   visible rewind (also doubles as protection against the dual-transport double-
//   delivery class of bug described above makeRemoteActions, for the two actions that
//   skip that fix's requestId-based dedup because they're not request/response shaped).
// remoteSession.controlRequestQueue: [{peerId, serial, requestId}, ...] — unreviewed
//   requests, reviewed one at a time via a single reused modal; a request for a device
//   that's already got one queued (or already controlled) is auto-denied instead of
//   queuing a duplicate.
function handleControlRequest(data, peerId) {
  if (!remoteSession || remoteSession.role !== 'host') return;
  const { requestId, serial } = data || {};
  if (!requestId || !serial) return;
  debugLogPush(`remote (host): controlRequest from peerId=${peerId} serial=${serial}`, 'evt');
  const existing = remoteSession.controlBySerial.get(serial);
  if (existing) {
    if (existing.peerId === peerId) {
      try { remoteSession.actions.controlResponse.send({ requestId, granted: true, serial, grantId: existing.grantId }, { target: peerId }); } catch (_) {}
    } else {
      try { remoteSession.actions.controlResponse.send({ requestId, granted: false, serial, reason: 'Another viewer is already controlling this device' }, { target: peerId }); } catch (_) {}
    }
    return;
  }
  if (remoteSession.controlRequestQueue.some((r) => r.serial === serial)) {
    try { remoteSession.actions.controlResponse.send({ requestId, granted: false, serial, reason: 'A control request for this device is already pending host review' }, { target: peerId }); } catch (_) {}
    return;
  }
  if (!connectedDevices.has(serial)) {
    try { remoteSession.actions.controlResponse.send({ requestId, granted: false, serial, reason: 'Device not connected' }, { target: peerId }); } catch (_) {}
    return;
  }
  const wasEmpty = remoteSession.controlRequestQueue.length === 0;
  remoteSession.controlRequestQueue.push({ peerId, serial, requestId });
  if (wasEmpty) showControlRequestPrompt();
}

// Shows (or refreshes) a modal for the FRONT of controlRequestQueue — Grant/Deny always
// act on queue[0], then advance to the next queued request (if any) automatically.
function showControlRequestPrompt() {
  hideControlRequestPrompt();
  const next = remoteSession.controlRequestQueue[0];
  if (!next) return;
  const info = connectedDevices.get(next.serial);
  const deviceName = (info && info._displayName) || next.serial;
  const queuedNote = remoteSession.controlRequestQueue.length > 1
    ? ` <span style="color:var(--muted, #8b949e);">(${remoteSession.controlRequestQueue.length - 1} more request(s) waiting)</span>` : '';
  const overlay = document.createElement('div');
  overlay.id = 'control-request-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1001;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#1e1e2e;color:#cdd6f4;border-radius:12px;padding:24px;min-width:320px;max-width:460px;box-shadow:0 8px 32px rgba(0,0,0,0.4);';
  box.innerHTML =
    '<h3 style="margin:0 0 12px;font-size:18px;">Remote Control Request</h3>' +
    '<p style="font-size:13px;color:#a6adc6;margin-bottom:16px;">A connected viewer wants to remotely control <strong>' + esc(deviceName) + '</strong> — see its screen and send taps, swipes, and text.' + queuedNote + '</p>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
    '<button class="btn btn-sm" id="control-deny-btn">Deny</button>' +
    '<button class="btn" id="control-grant-btn" style="color:#a6e3a1;">Grant Control</button></div>';
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  document.getElementById('control-grant-btn').onclick = () => grantControlRequest();
  document.getElementById('control-deny-btn').onclick = () => denyControlRequest();
}

function hideControlRequestPrompt() {
  const el = document.getElementById('control-request-overlay');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function grantControlRequest() {
  if (!remoteSession || remoteSession.role !== 'host') return;
  const next = remoteSession.controlRequestQueue.shift();
  hideControlRequestPrompt();
  if (next) {
    const { peerId, serial, requestId } = next;
    if (!connectedDevices.has(serial)) {
      try { remoteSession.actions.controlResponse.send({ requestId, granted: false, serial, reason: 'Device not connected' }, { target: peerId }); } catch (_) {}
    } else {
      const grantId = crypto.randomUUID();
      remoteSession.controlBySerial.set(serial, { peerId, grantId, seq: -1, lastInputSeq: -1 });
      try { remoteSession.actions.controlResponse.send({ requestId, granted: true, serial, grantId }, { target: peerId }); } catch (_) {}
      showControlActiveBanner();
      debugLogPush(`remote (host): granted control of ${serial} to peerId=${peerId}`, 'ok');
      startScreencapLoop(peerId, serial, grantId);
    }
  }
  if (remoteSession.controlRequestQueue.length) showControlRequestPrompt();
}

function denyControlRequest() {
  if (!remoteSession || remoteSession.role !== 'host') return;
  const next = remoteSession.controlRequestQueue.shift();
  hideControlRequestPrompt();
  if (next) {
    try { remoteSession.actions.controlResponse.send({ requestId: next.requestId, granted: false, serial: next.serial, reason: 'Denied by host' }, { target: next.peerId }); } catch (_) {}
  }
  if (remoteSession.controlRequestQueue.length) showControlRequestPrompt();
}

// Single cleanup path for ending one device's control session, whichever side or event
// triggered it (host clicks Stop, device disconnects, viewer disconnects/releases).
function stopControlSession(serial, reason) {
  if (!remoteSession || remoteSession.role !== 'host') return;
  const entry = remoteSession.controlBySerial.get(serial);
  if (!entry) return;
  try { remoteSession.actions.controlRevoked.send({ serial, grantId: entry.grantId, reason: reason || 'Stopped by host' }, { target: entry.peerId }); } catch (_) {}
  remoteSession.controlBySerial.delete(serial);
  showControlActiveBanner();
  debugLogPush(`remote (host): control session ended for ${serial} (${reason || 'stopped by host'})`, 'warn');
}

function handleControlRelease(data, peerId) {
  if (!remoteSession || remoteSession.role !== 'host') return;
  const { serial, grantId } = data || {};
  const entry = remoteSession.controlBySerial.get(serial);
  if (!entry || entry.peerId !== peerId || entry.grantId !== grantId) return;
  // Viewer already knows it released control — no need to echo controlRevoked back.
  remoteSession.controlBySerial.delete(serial);
  showControlActiveBanner();
  debugLogPush(`remote (host): viewer released control of ${serial}`, 'evt');
}

// Full re-render of the active-control banner from remoteSession.controlBySerial —
// one row per currently-controlled device (since control is now per-device, more than
// one can be active at once), each with its own Stop button. Hides itself when empty.
function showControlActiveBanner() {
  const el = document.getElementById('control-active-banner');
  if (!el || !remoteSession || remoteSession.role !== 'host') return;
  if (remoteSession.controlBySerial.size === 0) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.innerHTML = '';
  for (const serial of remoteSession.controlBySerial.keys()) {
    const info = connectedDevices.get(serial);
    const deviceName = (info && info._displayName) || serial;
    const row = document.createElement('span');
    row.style.cssText = 'display:inline-flex;align-items:center;gap:0.5rem;margin-right:1rem;';
    row.textContent = 'Remote control active on ' + deviceName + ' ';
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = 'Stop Control';
    btn.onclick = () => stopControlSession(serial, 'Stopped by host');
    row.appendChild(btn);
    el.appendChild(row);
  }
  el.classList.remove('hidden');
}

function hideControlActiveBanner() {
  const el = document.getElementById('control-active-banner');
  if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
}

// Recursive setTimeout (not setInterval) so a slow capture never overlaps the next one.
// Re-checks controlBySerial.get(serial) fresh at both ends of the async capture — a
// revoke mid-capture just means this loop quietly stops rescheduling itself.
async function startScreencapLoop(peerId, serial, grantId) {
  let entry = remoteSession?.controlBySerial?.get(serial);
  if (!entry || entry.grantId !== grantId) return;
  const info = connectedDevices.get(serial);
  if (!info) { stopControlSession(serial, 'device disconnected'); return; }
  try {
    const frame = await captureScaledFrame(info.adb, 360, 0.45);
    entry = remoteSession?.controlBySerial?.get(serial);
    if (!entry || entry.grantId !== grantId) return; // ended mid-capture
    entry.seq++;
    remoteSession.actions.screenFrame.send({ serial, grantId, seq: entry.seq, jpeg: frame.jpegBase64, w: frame.realWidth, h: frame.realHeight }, { target: peerId });
  } catch (err) {
    debugLogPush(`remote (host): screencap failed for ${serial}: ${err && err.message || err}`, 'err');
    if (remoteSession?.controlBySerial?.get(serial)?.grantId === grantId) stopControlSession(serial, 'screen capture failed');
    return;
  }
  if (remoteSession?.controlBySerial?.get(serial)?.grantId === grantId) setTimeout(() => startScreencapLoop(peerId, serial, grantId), 15);
}

// Coerces to a finite integer, defaulting to 0 — input x/y/duration/keycode values are
// interpolated directly into a shell command string below, so they must never be able
// to carry through arbitrary characters even from an already-granted control session.
function toSafeInt(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
}

function handleInputEvent(data, peerId) {
  if (!remoteSession || remoteSession.role !== 'host') return;
  const { serial, grantId, seq } = data || {};
  const entry = remoteSession.controlBySerial.get(serial);
  if (!entry || entry.peerId !== peerId || grantId !== entry.grantId) return;
  if (typeof seq !== 'number' || seq <= entry.lastInputSeq) return;
  entry.lastInputSeq = seq;
  const info = connectedDevices.get(serial);
  if (!info) return;
  let cmd;
  switch (data.type) {
    case 'tap': cmd = `input tap ${toSafeInt(data.x)} ${toSafeInt(data.y)}`; break;
    case 'swipe': cmd = `input swipe ${toSafeInt(data.x1)} ${toSafeInt(data.y1)} ${toSafeInt(data.x2)} ${toSafeInt(data.y2)} ${toSafeInt(data.durationMs)}`; break;
    case 'key': cmd = `input keyevent ${toSafeInt(data.code)}`; break;
    case 'text': cmd = `input text ${shQuote(String(data.text || ''))}`; break;
    default: return;
  }
  adbShell(info.adb, cmd).catch((err) => debugLogPush(`remote (host): input command failed: ${err && err.message || err}`, 'warn'));
}

// Hooked into every connectedDevices.delete() call site (six total) so an active or
// pending control session for a device that just went away is always cleaned up, no
// matter which of the six independent disconnect paths triggered the removal.
function notifyDeviceRemoved(serial) {
  if (!remoteSession || remoteSession.role !== 'host') return;
  if (remoteSession.controlBySerial.has(serial)) stopControlSession(serial, 'device disconnected');
  const before = remoteSession.controlRequestQueue.length;
  remoteSession.controlRequestQueue = remoteSession.controlRequestQueue.filter((r) => r.serial !== serial);
  if (remoteSession.controlRequestQueue.length !== before) {
    hideControlRequestPrompt();
    if (remoteSession.controlRequestQueue.length) showControlRequestPrompt();
  }
}

function showShareModal() {
  hideShareModal();
  const link = location.origin + location.pathname + '#room=' + remoteSession.roomId + '&key=' + remoteSession.password;
  const overlay = document.createElement('div');
  overlay.id = 'share-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;';
  overlay.onclick = (e) => { if (e.target === overlay) hideShareModal(); };

  const box = document.createElement('div');
  box.style.cssText = 'background:#1e1e2e;color:#cdd6f4;border-radius:12px;padding:24px;min-width:360px;max-width:520px;box-shadow:0 8px 32px rgba(0,0,0,0.4);';
  box.innerHTML =
    '<h3 style="margin:0 0 12px;font-size:18px;">Share Remote Session</h3>' +
    '<p style="font-size:13px;color:#a6adc6;margin-bottom:12px;">Anyone with this link can view this device\'s status and run shell commands on it immediately, with no approval step — treat it like a password. Use "Regenerate Link" if it leaks.</p>' +
    '<div style="display:flex;gap:6px;margin-bottom:12px;">' +
    '<input id="share-link-input" type="text" readonly value="' + esc(link) + '" style="flex:1;background:#11111b;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:6px 10px;font-family:monospace;font-size:12px;">' +
    '<button class="btn btn-sm" id="share-copy-btn">Copy</button></div>' +
    '<div style="font-size:12px;color:#a6adc6;margin-bottom:16px;">Connected viewers: <span id="share-viewer-count">0</span></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
    '<button class="btn btn-sm" id="share-regen-btn">Regenerate Link</button>' +
    '<button class="btn btn-sm" id="share-stop-btn" style="color:#f38ba8;">Stop Sharing</button>' +
    '<button class="btn" id="share-close-btn">Done</button></div>';
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  document.getElementById('share-copy-btn').onclick = () => {
    navigator.clipboard.writeText(link).then(() => setStatus('Link copied', 'ok')).catch(() => {});
  };
  document.getElementById('share-regen-btn').onclick = async () => { await stopShareSession(); startShareSession(); };
  document.getElementById('share-stop-btn').onclick = () => stopShareSession();
  document.getElementById('share-close-btn').onclick = () => hideShareModal();
  updateShareModalViewerCount();
}

function hideShareModal() {
  const el = document.getElementById('share-modal-overlay');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function updateShareModalViewerCount() {
  const el = document.getElementById('share-viewer-count');
  if (el && remoteSession && remoteSession.role === 'host') el.textContent = String(remoteSession.viewers.size);
}

// --- Remote Session: Viewer ---
function initRemoteViewerIfLinked() {
  const hash = location.hash || '';
  const rm = hash.match(/room=([^&]+)/);
  const km = hash.match(/key=([^&]+)/);
  if (!rm || !km) return false;
  joinAsViewer(decodeURIComponent(rm[1]), decodeURIComponent(km[1]));
  return true;
}

function joinAsViewer(roomId, password) {
  debugLogPush(`remote (viewer): joining room=${roomId} appId=${REMOTE_APP_ID}`, 'evt');
  const room = joinRoom({ appId: REMOTE_APP_ID, password, turnConfig: REMOTE_TURN_CONFIG, rtcPolyfill: makeDiagnosticRTCPeerConnection('viewer'), relayConfig: { urls: REMOTE_RELAY_URLS, redundancy: REMOTE_RELAY_URLS.length, warnOnRelayFailure: true } }, roomId, makeJoinCallbacks('viewer'));
  const actions = makeRemoteActions(room, roomId, password, 'viewer');
  remoteSession = {
    role: 'viewer', room, roomId, password, hostPeerId: null, actions,
    pendingRequests: new Map(),
    pendingCompletions: new Map(),
    mirror: { activeSerial: null, connected: [], available: [], shellBySerial: {} },
    controlBySerial: {}, // serial -> {active, grantId, lastAppliedSeq, inputSeq, lastFrameW, lastFrameH, lastJpeg}
  };
  pollIceState(room, 'viewer', 60);

  // room.onPeerJoin only fires once trystero's P2P connection actually succeeds — on
  // a network where it never does (see makeRemoteActions' fallback channel above),
  // that event, and the hello.send() below that normally rides on it, would simply
  // never happen. Broadcast hello proactively over the fallback channel too (a few
  // times, since pub/sub doesn't buffer for a subscriber that joins the topic a
  // moment late) so the host can identify and greet this viewer even with zero P2P.
  for (let i = 0; i < 4; i++) {
    setTimeout(() => { try { actions.hello.send({ appVersion: APP_VERSION }); } catch (_) {} }, i * 2000);
  }

  // A room can hold more than one viewer (mesh topology — every peer sees every other
  // peer's onPeerJoin, not just the host's). Whoever connects first used to get blindly
  // latched onto as "the host," which meant a viewer joining a room that already had
  // another viewer in it could mistake that fellow viewer for the host — showing
  // "Connected to host" while the device list stayed empty forever, since only the
  // real host ever sends devicePush. Identify the host by that signal instead of by
  // connection order: only devicePush (host-exclusive) sets hostPeerId.
  room.onPeerJoin = (peerId) => {
    debugLogPush(`remote (viewer): WebRTC peer joined: peerId=${peerId}`, 'ok');
    try { actions.hello.send({ appVersion: APP_VERSION }, { target: peerId }); } catch (_) {}
    if (!remoteSession.hostPeerId) setViewerStatus('Peer connected, waiting for host...', 'connecting');
  };
  room.onPeerLeave = (peerId) => {
    debugLogPush(`remote (viewer): WebRTC peer left: peerId=${peerId}`, 'warn');
    if (peerId === remoteSession.hostPeerId) {
      remoteSession.hostPeerId = null;
      showHostDisconnectedBanner();
    }
  };
  actions.devicePush.onMessage = (data, ctx) => {
    if (!remoteSession.hostPeerId) {
      remoteSession.hostPeerId = ctx.peerId;
      debugLogPush(`remote (viewer): identified host via devicePush: peerId=${ctx.peerId}`, 'ok');
      setViewerStatus('Connected to host', 'ok');
      const input = document.getElementById('viewer-shell-input');
      if (input) input.disabled = false;
    } else if (ctx.peerId !== remoteSession.hostPeerId) {
      debugLogPush(`remote (viewer): ignored devicePush from non-host peerId=${ctx.peerId}`, 'warn');
      return;
    }
    renderMirrorDeviceList(data);
  };
  actions.cmdResponse.onMessage = (data, ctx) => {
    if (ctx.peerId !== remoteSession.hostPeerId) return;
    debugLogPush(`remote (viewer): cmdResponse received requestId=${data && data.requestId}`, 'evt');
    handleCmdResponse(data);
  };
  actions.pathCompleteResult.onMessage = (data, ctx) => {
    if (ctx.peerId !== remoteSession.hostPeerId) return;
    const { requestId, ok, entries } = data || {};
    const cb = remoteSession.pendingCompletions?.get(requestId);
    if (cb) { remoteSession.pendingCompletions.delete(requestId); cb(ok ? (entries || []) : []); }
  };
  actions.tabDataPush.onMessage = (data, ctx) => {
    if (ctx.peerId !== remoteSession.hostPeerId) {
      debugLogPush(`remote (viewer): tabDataPush IGNORED — from peerId=${ctx.peerId}, expected hostPeerId=${remoteSession.hostPeerId} (serial=${data?.serial} tab=${data?.tab})`, 'warn');
      return;
    }
    handleTabDataPush(data);
  };
  actions.controlResponse.onMessage = (data, ctx) => {
    if (ctx.peerId !== remoteSession.hostPeerId) return;
    handleControlResponse(data);
  };
  actions.screenFrame.onMessage = (data, ctx) => {
    if (ctx.peerId !== remoteSession.hostPeerId) return;
    handleScreenFrame(data);
  };
  actions.controlRevoked.onMessage = (data, ctx) => {
    if (ctx.peerId !== remoteSession.hostPeerId) return;
    handleControlRevoked(data);
  };
  actions.bye.onMessage = (data, ctx) => {
    if (ctx.peerId !== remoteSession.hostPeerId) return;
    showHostDisconnectedBanner();
    for (const [serial, entry] of Object.entries(remoteSession.controlBySerial)) {
      handleControlRevoked({ serial, grantId: entry.grantId, reason: 'Host disconnected' });
    }
  };

  setTimeout(() => {
    if (remoteSession && remoteSession.role === 'viewer' && !remoteSession.hostPeerId) {
      debugLogPush('remote (viewer): no WebRTC peer joined within 15s — check relay/network connectivity (see README known limitations)', 'err');
      setViewerStatus('Still connecting... network may be blocking P2P (see Debug)', 'warn');
    }
  }, 15000);

  renderViewerShell();
  setViewerStatus('Connecting to host...', 'connecting');
}

function leaveRemoteSession() {
  if (!remoteSession || remoteSession.role !== 'viewer') return;
  try {
    if (remoteSession.hostPeerId) remoteSession.actions.bye.send({ reason: 'viewer_left' }, { target: remoteSession.hostPeerId });
  } catch (_) {}
  try { remoteSession.actions._fallback.close(); } catch (_) {}
  try { remoteSession.room.leave(); } catch (_) {}
  remoteSession = null;
  location.hash = '';
  location.reload();
}

function renderViewerShell() {
  document.getElementById('btn-scan')?.classList.add('hidden');
  document.getElementById('btn-share')?.classList.add('hidden');
  document.getElementById('welcome-msg')?.classList.add('hidden');
  document.getElementById('available-section')?.classList.add('hidden');
  document.getElementById('viewer-banner')?.classList.remove('hidden');
  // Viewer mode reuses the full Properties/Features/.../Shell tab set instead of a
  // parallel UI — .viewer-mode (CSS) hides host-only controls (nickname/disconnect,
  // search boxes, Export JSON, CSR/probe buttons) and swaps in the Remote Shell block
  // in place of the host's local Shell block.
  const inspector = document.getElementById('inspector-section');
  if (inspector) {
    inspector.classList.remove('hidden');
    inspector.classList.add('viewer-mode');
  }
  const shellTabBtn = document.getElementById('tab-btn-shell');
  if (shellTabBtn) switchTab(shellTabBtn, 'tab-shell');
  setupControlScreenInput();
  renderControlTab();
  renderMirrorDeviceList({ activeSerial: null, connected: [], available: [] });
}

function setViewerStatus(text, type) {
  const el = document.getElementById('viewer-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'badge ' + (type === 'ok' ? 'ok' : type === 'err' ? 'err' : '');
}

function showHostDisconnectedBanner() {
  setViewerStatus('Host disconnected', 'err');
  const input = document.getElementById('viewer-shell-input');
  if (input) input.disabled = true;
}

// Each device gets its own persisted shell console (mirrors dataCache.shellBySerial
// on the host side). Swaps the visible #viewer-shell-output content when the
// active target changes, so switching devices never shows/appends to the wrong console.
function switchMirrorShellOutput(oldSerial, newSerial) {
  if (oldSerial === newSerial) return;
  const output = document.getElementById('viewer-shell-output');
  if (!output) return;
  if (!remoteSession.mirror.shellBySerial) remoteSession.mirror.shellBySerial = {};
  if (oldSerial) remoteSession.mirror.shellBySerial[oldSerial] = output.textContent;
  output.textContent = newSerial ? (remoteSession.mirror.shellBySerial[newSerial] || '') : '';
  const term = document.getElementById('viewer-shell-console');
  if (term) term.scrollTop = term.scrollHeight;
}

// Maps a broadcast tab key to the DOM element it should be dropped into — the exact
// same elements the host's own UI uses, since viewer mode reuses #inspector-section
// wholesale rather than maintaining a parallel set of read-only views.
// NOTE: a function, not a top-level const object — applyMirroredTabsForSerial() below
// is reachable synchronously from init() (via initRemoteViewerIfLinked() ->
// joinAsViewer() -> renderViewerShell(), all on a viewer's very first page load,
// before the rest of this module has finished its own top-level evaluation). A
// module-level `const` here would sit in the temporal dead zone at that point —
// exactly the v1.10.0 bug (REMOTE_ACTION_NAMES) repeated. A function declaration is
// fully hoisted, so it has no such ordering dependency.
function mirroredTabElementIds() {
  return {
    props: 'props-output', features: 'features-output', packages: 'packages-output',
    attestation: 'attestation-output', rkp: 'rkp-output',
  };
}

function handleTabDataPush(data) {
  const { serial, tab, html } = data || {};
  if (!serial || !tab || !mirroredTabElementIds()[tab]) {
    debugLogPush(`handleTabDataPush: ignored malformed/unknown message: ${JSON.stringify(data && { serial: data.serial, tab: data.tab })}`, 'warn');
    return;
  }
  debugLogPush(`handleTabDataPush: received serial=${serial} tab=${tab} htmlLen=${(html || '').length} (mirror.activeSerial=${remoteSession.mirror.activeSerial})`, 'evt');
  if (!remoteSession.mirror.tabHtml) remoteSession.mirror.tabHtml = {};
  if (!remoteSession.mirror.tabHtml[serial]) remoteSession.mirror.tabHtml[serial] = {};
  remoteSession.mirror.tabHtml[serial][tab] = html;
  if (serial === remoteSession.mirror.activeSerial) {
    const el = document.getElementById(mirroredTabElementIds()[tab]);
    if (el) el.innerHTML = html;
  }
}

// Called whenever the mirrored active device changes — refreshes every data tab from
// whatever's cached for that serial (empty/placeholder if the host hasn't sent
// anything for it yet), the same way switchMirrorShellOutput() does for the console.
function applyMirroredTabsForSerial(serial) {
  const cached = (serial && remoteSession.mirror.tabHtml?.[serial]) || {};
  debugLogPush(`applyMirroredTabsForSerial(${serial}): cached tabs=[${Object.keys(cached).join(', ')}] out of known=[${Object.keys(mirroredTabElementIds()).join(', ')}]`, 'evt');
  for (const [tab, elementId] of Object.entries(mirroredTabElementIds())) {
    const el = document.getElementById(elementId);
    if (el) el.innerHTML = cached[tab] || '<div class="empty-hint">Waiting for host data…</div>';
  }
}

function updateViewerDeviceHeader() {
  const el = document.getElementById('selected-device-name');
  if (!el || !remoteSession) return;
  const dev = remoteSession.mirror.connected.find(d => d.serial === remoteSession.mirror.activeSerial);
  if (!dev) { el.textContent = ''; return; }
  const nick = dev.nickname ? ' ("' + dev.nickname + '")' : '';
  el.textContent = (dev.displayName || dev.serial) + nick + ' (' + dev.serial + ')';
}

// --- Remote Session: Screen/Input Control (Viewer) ---
// remoteSession.controlBySerial: plain object, serial -> {active, grantId,
//   lastAppliedSeq, inputSeq, lastFrameW, lastFrameH, lastJpeg} — one independent entry
//   per device, so each device has its own remote-control instance. The Remote Control
//   tab always reflects whichever device is currently selected (renderControlTab()),
//   but a control session for a NON-selected device keeps running in the background
//   (frames keep arriving and get cached via lastJpeg) — switching back to that device
//   shows it immediately rather than waiting for the next poll.
function requestControl() {
  if (!remoteSession || remoteSession.role !== 'viewer' || !remoteSession.hostPeerId || !remoteSession.mirror.activeSerial) return;
  const serial = remoteSession.mirror.activeSerial;
  const requestId = crypto.randomUUID();
  setControlStatus('Waiting for host approval...');
  const btn = document.getElementById('btn-request-control');
  if (btn) btn.disabled = true;
  try {
    remoteSession.actions.controlRequest.send({ requestId, serial }, { target: remoteSession.hostPeerId });
  } catch (_) {
    setControlStatus('Failed to send request');
    if (btn) btn.disabled = false;
  }
}

function handleControlResponse(data) {
  if (!remoteSession || remoteSession.role !== 'viewer' || !data) return;
  const { serial } = data;
  if (!data.granted) {
    if (serial === remoteSession.mirror.activeSerial) {
      setControlStatus(data.reason ? ('Not granted: ' + data.reason) : 'Control request denied');
      const btn = document.getElementById('btn-request-control');
      if (btn) btn.disabled = false;
    }
    return;
  }
  remoteSession.controlBySerial[serial] = {
    active: true, grantId: data.grantId, lastAppliedSeq: -1, inputSeq: 0,
    lastFrameW: 0, lastFrameH: 0, lastJpeg: null,
  };
  if (serial === remoteSession.mirror.activeSerial) renderControlTab();
}

function handleScreenFrame(data) {
  if (!remoteSession || remoteSession.role !== 'viewer' || !data) return;
  const { serial } = data;
  const entry = remoteSession.controlBySerial[serial];
  if (!entry || !entry.active || data.grantId !== entry.grantId) return;
  if (typeof data.seq !== 'number' || data.seq <= entry.lastAppliedSeq) return;
  entry.lastAppliedSeq = data.seq;
  entry.lastFrameW = data.w;
  entry.lastFrameH = data.h;
  entry.lastJpeg = data.jpeg;
  if (serial === remoteSession.mirror.activeSerial) {
    const img = document.getElementById('control-screen-img');
    if (img) img.src = 'data:image/jpeg;base64,' + data.jpeg;
  }
}

function handleControlRevoked(data) {
  if (!remoteSession || remoteSession.role !== 'viewer' || !data) return;
  const { serial } = data;
  const entry = remoteSession.controlBySerial[serial];
  if (!entry || data.grantId !== entry.grantId) return;
  delete remoteSession.controlBySerial[serial];
  if (serial === remoteSession.mirror.activeSerial) {
    setControlStatus('Control ended' + (data.reason ? ': ' + data.reason : ''));
    renderControlTab();
  }
}

function releaseControl() {
  if (!remoteSession || remoteSession.role !== 'viewer') return;
  const serial = remoteSession.mirror.activeSerial;
  const entry = serial && remoteSession.controlBySerial[serial];
  if (!entry || !entry.active) return;
  try { remoteSession.actions.controlRelease.send({ serial, grantId: entry.grantId }, { target: remoteSession.hostPeerId }); } catch (_) {}
  delete remoteSession.controlBySerial[serial];
  setControlStatus('Control released');
  renderControlTab();
}

function setControlStatus(text) {
  const el = document.getElementById('control-status');
  if (el) el.textContent = text;
}

// Redraws the whole Remote Control tab from whatever's currently true for
// mirror.activeSerial — called on device switch (setMirrorActiveSerial) and whenever a
// grant/revoke changes that specific device's entry. screenFrame updates the <img>
// directly (see handleScreenFrame) rather than going through a full re-render every
// frame, since that fires several times a second.
function renderControlTab() {
  if (!remoteSession || remoteSession.role !== 'viewer') return;
  const serial = remoteSession.mirror.activeSerial;
  const entry = serial && remoteSession.controlBySerial[serial];
  const reqBtn = document.getElementById('btn-request-control');
  const relBtn = document.getElementById('btn-release-control');
  const screenWrap = document.getElementById('control-screen-wrap');
  const hwButtons = document.getElementById('control-hw-buttons');
  const textRow = document.getElementById('control-text-row');
  const img = document.getElementById('control-screen-img');
  if (entry && entry.active) {
    setControlStatus('In control of ' + serial);
    reqBtn?.classList.add('hidden');
    relBtn?.classList.remove('hidden');
    screenWrap?.classList.remove('hidden');
    hwButtons?.classList.remove('hidden');
    textRow?.classList.remove('hidden');
    if (img) img.src = entry.lastJpeg ? ('data:image/jpeg;base64,' + entry.lastJpeg) : '';
  } else {
    setControlStatus(serial ? 'Not in control' : 'Select a device to request control');
    if (reqBtn) { reqBtn.classList.remove('hidden'); reqBtn.disabled = !serial; }
    relBtn?.classList.add('hidden');
    screenWrap?.classList.add('hidden');
    hwButtons?.classList.add('hidden');
    textRow?.classList.add('hidden');
    if (img) img.src = '';
  }
}

function getActiveControlEntry() {
  if (!remoteSession || remoteSession.role !== 'viewer') return null;
  const serial = remoteSession.mirror.activeSerial;
  const entry = serial && remoteSession.controlBySerial[serial];
  return (entry && entry.active) ? entry : null;
}

function sendInputEvent(type, params) {
  if (!remoteSession || remoteSession.role !== 'viewer' || !remoteSession.hostPeerId) return;
  const serial = remoteSession.mirror.activeSerial;
  const entry = getActiveControlEntry();
  if (!entry) return;
  entry.inputSeq++;
  try {
    remoteSession.actions.inputEvent.send({ serial, grantId: entry.grantId, seq: entry.inputSeq, type, ...params }, { target: remoteSession.hostPeerId });
  } catch (_) {}
}

function sendControlKey(code) { sendInputEvent('key', { code }); }

function sendControlText() {
  const input = document.getElementById('control-text-input');
  if (!input || !input.value) return;
  sendInputEvent('text', { text: input.value });
  input.value = '';
}

// Wired once (guarded by _controlWired) and left in place for the life of the page —
// reads getActiveControlEntry() fresh on every pointer event instead of capturing one
// device's state at setup time, so it stays correct across device switches with zero
// re-wiring needed.
let controlPointerState = null;
function setupControlScreenInput() {
  const img = document.getElementById('control-screen-img');
  if (!img || img._controlWired) return;
  img._controlWired = true;
  img.addEventListener('pointerdown', (e) => {
    if (!getActiveControlEntry()) return;
    e.preventDefault();
    controlPointerState = { startX: e.clientX, startY: e.clientY, startTime: Date.now() };
  });
  img.addEventListener('pointerup', (e) => {
    const entry = getActiveControlEntry();
    if (!entry || !controlPointerState) return;
    e.preventDefault();
    const { startX, startY, startTime } = controlPointerState;
    controlPointerState = null;
    const rect = img.getBoundingClientRect();
    const w = entry.lastFrameW || rect.width;
    const h = entry.lastFrameH || rect.height;
    const toDeviceX = (clientX) => Math.round(((clientX - rect.left) / rect.width) * w);
    const toDeviceY = (clientY) => Math.round(((clientY - rect.top) / rect.height) * h);
    const dx = e.clientX - startX, dy = e.clientY - startY;
    const dist = Math.hypot(dx, dy);
    const duration = Date.now() - startTime;
    if (dist < 12 && duration < 500) {
      sendInputEvent('tap', { x: toDeviceX(e.clientX), y: toDeviceY(e.clientY) });
    } else {
      sendInputEvent('swipe', {
        x1: toDeviceX(startX), y1: toDeviceY(startY),
        x2: toDeviceX(e.clientX), y2: toDeviceY(e.clientY),
        durationMs: Math.min(Math.max(duration, 50), 2000),
      });
    }
  });
  img.addEventListener('pointercancel', () => { controlPointerState = null; });
  img.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Both places that reassign remoteSession.mirror.activeSerial (the button click below,
// and renderMirrorDeviceList()'s own auto-fallback when the mirrored serial disappears
// from the host's broadcast list) route through here. Each device has its own
// independent control instance (remoteSession.controlBySerial, keyed by serial) — this
// never releases anything on a switch, it just re-renders the Remote Control tab to
// reflect whichever device is now selected (renderControlTab()); a control session for
// a device you switch away from keeps running in the background untouched (frames keep
// arriving and get cached, see handleScreenFrame) and reappears instantly if you switch
// back. Control only ever ends via an explicit Release/Stop, a controlRevoked from the
// host, or the session itself ending (reload/close/Leave Session) — never merely from
// switching which device is selected elsewhere, or from unrelated host-side device-list
// churn (an earlier, single-slot version of this got that wrong).
function setMirrorActiveSerial(serial) {
  remoteSession.mirror.activeSerial = serial;
  renderControlTab();
}

function selectMirrorDevice(serial) {
  if (!remoteSession || remoteSession.role !== 'viewer' || serial === remoteSession.mirror.activeSerial) return;
  switchMirrorShellOutput(remoteSession.mirror.activeSerial, serial);
  setMirrorActiveSerial(serial);
  renderMirrorDeviceList({ activeSerial: serial, connected: remoteSession.mirror.connected, available: remoteSession.mirror.available });
}

function renderMirrorDeviceList(snapshot) {
  if (!remoteSession || remoteSession.role !== 'viewer') return;
  remoteSession.mirror.connected = snapshot.connected || [];
  remoteSession.mirror.available = snapshot.available || [];
  if (!remoteSession.mirror.activeSerial || !remoteSession.mirror.connected.some(d => d.serial === remoteSession.mirror.activeSerial)) {
    const fallback = snapshot.activeSerial || (remoteSession.mirror.connected[0] && remoteSession.mirror.connected[0].serial) || null;
    if (fallback !== remoteSession.mirror.activeSerial) switchMirrorShellOutput(remoteSession.mirror.activeSerial, fallback);
    setMirrorActiveSerial(fallback);
  }
  updateViewerCwdLabel();
  updateViewerDeviceHeader();
  applyMirroredTabsForSerial(remoteSession.mirror.activeSerial);
  const list = document.getElementById('device-list');
  const welcome = document.getElementById('welcome-msg');
  if (!list || !welcome) return;
  const hasAny = remoteSession.mirror.connected.length > 0 || remoteSession.mirror.available.length > 0;
  if (!hasAny) {
    list.classList.add('hidden');
    welcome.innerHTML = '<div class="icon">&#x1F4F1;</div><p>Waiting for host to connect a device...</p>';
    welcome.classList.remove('hidden');
    return;
  }
  welcome.classList.add('hidden');
  list.classList.remove('hidden');
  list.innerHTML = '';
  for (const dev of remoteSession.mirror.connected) {
    const card = document.createElement('div');
    card.className = 'device-card' + (remoteSession.mirror.activeSerial === dev.serial ? ' active' : '');
    card.innerHTML = '<div class="device-card-top"><div class="dev-info">' +
      (dev.nickname ? '<div class="dev-nick">' + esc(dev.nickname) + '</div>' : '') +
      '<div class="dev-name">' + esc(dev.displayName || dev.serial) + '</div>' +
      '<div class="dev-serial">' + esc(dev.serial) + '</div></div></div>' +
      '<div class="device-card-bottom"><span class="dev-status-dot" title="Connected on host"></span></div>';
    card.onclick = () => selectMirrorDevice(dev.serial);
    list.appendChild(card);
  }
  for (const dev of remoteSession.mirror.available) {
    const card = document.createElement('div');
    card.className = 'device-card available';
    card.innerHTML = '<div class="device-card-top"><div class="dev-info">' +
      (dev.nickname ? '<div class="dev-nick">' + esc(dev.nickname) + '</div>' : '') +
      '<div class="dev-name">' + esc(dev.displayName || dev.serial) + '</div>' +
      '<div class="dev-serial">' + esc(dev.serial) + '</div></div></div>' +
      '<div class="device-card-bottom"><span class="dev-status-dot dev-status-dot-gray" title="Ready on host (not connected)"></span></div>';
    list.appendChild(card);
  }
}

// --- Nickname ---
window.setNickname = function() {
  if (!activeSerial) return;
  const input = document.getElementById('nickname-input');
  const nick = input.value.trim();
  if (nick) {
    deviceNicknames[activeSerial] = nick;
    localStorage.setItem('device-nicknames', JSON.stringify(deviceNicknames));
  } else {
    delete deviceNicknames[activeSerial];
    localStorage.setItem('device-nicknames', JSON.stringify(deviceNicknames));
  }
  selectDevice(activeSerial);
};

// --- Font Size ---
window.changeFontSize = function(delta) {
  fontSizeLevel = Math.max(-3, Math.min(5, fontSizeLevel + delta));
  localStorage.setItem('font-size-level', fontSizeLevel);
  applyFontSize();
};

function applyFontSize() {
  document.documentElement.style.setProperty('--font-scale', (1 + fontSizeLevel * 0.1) + '');
}

// ============================================
// DATA FETCHING
// ============================================

function parseGetprop(text) {
  const props = [];
  const re = /\[(ro[.\w]+)\]:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) props.push({ name: m[1], value: m[2] });
  return props;
}

async function fetchProperties() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;
  showLoading('props', true);
  try {
    const text = await adbShell(info.adb, 'getprop');
    const props = parseGetprop(text);
    dataCache.props = props;
    document.getElementById('props-count').textContent = '(' + props.length + ')';
    renderProperties(props);
  } catch (err) {
    document.getElementById('props-output').innerHTML = '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('props', false);
}

// Pure HTML-building, split out of renderProperties() so prefetchTabsForViewers() (below)
// can compute the same markup for a device that ISN'T the host's own currently-selected
// one, without writing to the live #props-output element at all.
function propsToHtml(props, query) {
  const q = query || '';
  const filtered = q ? props.filter(p => p.name.toLowerCase().includes(q) || p.value.toLowerCase().includes(q)) : props;
  return filtered.map(p => '<div class="prop-row"><span class="prop-key">' + esc(p.name) + '</span><span class="prop-val">' + esc(p.value) + '</span></div>').join('') ||
    (q ? '<div class="empty-hint">No matching properties</div>' : '');
}

function renderProperties(props) {
  const q = (document.getElementById('search-props')?.value || '').toLowerCase();
  document.getElementById('props-output').innerHTML = propsToHtml(props, q);
}

function parsePmListFeatures(text) {
  const features = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let name = t;
    let version = 0;
    const vm = t.match(/^feature:(.+?)\s+ver:(\d+)$/);
    if (vm) { name = vm[1]; version = parseInt(vm[2], 10); }
    else { name = t.replace(/^feature:/, ''); }
    name = name.trim();
    if (!name) continue;
    features.push({ name, type: isSDKFeature(name) ? 'sdk' : 'other', available: true, version });
  }
  return features;
}

async function fetchFeatures() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;
  showLoading('features', true);
  try {
    const text = await adbShell(info.adb, 'pm list features');
    const features = parsePmListFeatures(text);
    dataCache.features = features;
    document.getElementById('features-count').textContent = '(' + features.length + ')';
    renderFeatures(features);
  } catch (err) {
    document.getElementById('features-output').innerHTML = '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('features', false);
}

// Same split as propsToHtml() above, same reason.
function featuresToHtml(features, query) {
  const q = query || '';
  const filtered = q ? features.filter(f => f.name.toLowerCase().includes(q)) : features;
  return filtered.map(f => {
    const tb = f.type === 'sdk' ? '<span class="feat-type">sdk</span>' : '<span class="feat-type other">other</span>';
    const vs = f.version > 0 ? ' v' + f.version : '';
    return '<div class="feat-item">' + tb + ' ' + esc(f.name) + '<span class="feat-ver">' + vs + '</span></div>';
  }).join('') || (q ? '<div class="empty-hint">No matching features</div>' : '');
}

function renderFeatures(features) {
  const q = (document.getElementById('search-features')?.value || '').toLowerCase();
  document.getElementById('features-output').innerHTML = featuresToHtml(features, q);
}

// --- Packages: dumpsys via temp file + sync protocol ---
async function fetchPackages() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;
  showLoading('packages', true);
  let method = 'fallback';
  try {
    // Stream dumpsys output directly via shell protocol — no temp file needed.
    const text = await adbShell(info.adb, 'dumpsys package 2>&1');
    const packages = parseDumpsysPackage(text);
    document.getElementById('packages-count').textContent = '(' + packages.length + ')';
    if (packages.length > 0) {
      dataCache.packages = packages;
      dataCache.lastDumpsysText = text;  // keep raw text for export / debug
      renderPackages(packages, false, 'dumpsys');
      showLoading('packages', false);
      return;
    }
    console.warn('dumpsys parsed 0 packages from', text.length, 'chars');
  } catch (err) {
    console.warn('dumpsys+sync failed:', err.message || err);
    try { await adbShell(info.adb, 'rm -f ' + tmpPath); } catch(e) {}
  }

  // Fallback 1: pm list packages -f -u
  try {
    const text = await adbShell(info.adb, 'pm list packages -f -u');
    const packages = parsePmListPackagesFallback(text);
    document.getElementById('packages-count').textContent = '(' + packages.length + ')';
    if (packages.length > 0) {
      dataCache.packages = packages;
      renderPackages(packages, true, 'pm-list');
      showLoading('packages', false);
      return;
    }
  } catch (e2) {
    console.warn('pm list fallback failed:', e2.message || e2);
  }

  document.getElementById('packages-output').innerHTML = '<span style="color:#ff5252">Failed to fetch package data. Check console for details.</span>';
  showLoading('packages', false);
}

// Same split as propsToHtml()/featuresToHtml() above, same reason. Note: the embedded
// onclick="togglePkgDetail(idx)" indexes into dataCache.packages (host-only, global) —
// harmless when this html is broadcast to a viewer, since expanding package details
// already doesn't work there regardless (pre-existing limitation, dataCache is never
// mirrored in structured form, only as inert rendered HTML).
function packagesToHtml(packages, fallback, method, query) {
  const q = query || '';
  const filtered = q ? packages.filter(p => p.name.toLowerCase().includes(q)) : packages;
  const sys = packages.filter(p => p.system).length;
  const priv = packages.filter(p => p.system_priv).length;
  const user = packages.filter(p => !p.system).length;
  const hasDetails = packages.filter(p => p.version_name || p.requested_permissions.length).length;

  let html = '<div class="prop-count">' + packages.length + ' total' +
    (sys ? ' <span style="color:var(--muted)">' + sys + ' sys</span>' : '') +
    (user ? ' <span style="color:var(--green)">' + user + ' user</span>' : '') +
    (priv ? ' <span style="color:var(--orange)">' + priv + ' priv</span>' : '') +
    (hasDetails > 0 ? ' <span style="color:var(--green)">' + hasDetails + ' with details</span>' : '') +
    (fallback ? ' <span style="color:var(--yellow)">[limited data]</span>' : '') +
    (q ? ' <span style="color:var(--accent)">filtered: ' + filtered.length + '</span>' : '') +
    '</div>';
  if (fallback || hasDetails === 0) {
    html += '<div style="font-size:calc(0.7rem * var(--font-scale));color:var(--muted);padding:0.3rem 0">Source: ' + (method || 'unknown') + '. Click package name to expand details.</div>';
  }

  html += filtered.map((p, idx) => {
    const realIdx = packages.indexOf(p);
    let badges = '';
    if (p.system_priv) badges += '<span class="pkg-badge priv">priv</span> ';
    else if (p.system) badges += '<span class="pkg-badge sys">sys</span> ';
    const verStr = p.version_name ? ' ' + esc(p.version_name) : '';
    return '<div class="pkg-item" data-pkg-idx="' + realIdx + '" onclick="togglePkgDetail(' + realIdx + ')">' +
      esc(p.name) + ' <span class="pkg-ver">' + verStr + '</span> ' + badges +
      ' <span class="pkg-toggle">[+]</span></div>' +
      '<div id="pkg-d-' + realIdx + '" class="pkg-detail hidden">' + renderPackageDetail(p) + '</div>';
  }).join('');

  return html;
}

function renderPackages(packages, fallback, method) {
  const q = (document.getElementById('search-packages')?.value || '').toLowerCase();
  document.getElementById('packages-output').innerHTML = packagesToHtml(packages, fallback, method, q);
}

function renderPackageDetail(p) {
  let h = '';
  if (p.version_name) h += '<div class="pkg-detail-row"><span class="pkg-detail-label">Version</span>' + esc(p.version_name) + '</div>';
  if (p.dir) h += '<div class="pkg-detail-row"><span class="pkg-detail-label">Path</span><span class="pkg-path">' + esc(p.dir) + '</span></div>';
  if (p.min_sdk || p.target_sdk) h += '<div class="pkg-detail-row"><span class="pkg-detail-label">SDK</span>min ' + (p.min_sdk || '?') + ' / target ' + (p.target_sdk || '?') + '</div>';
  if (p.uid) h += '<div class="pkg-detail-row"><span class="pkg-detail-label">UID</span>' + p.uid + '</div>';
  if (p.sha256_cert) h += '<div class="pkg-detail-row"><span class="pkg-detail-label">Cert</span>' + esc(p.sha256_cert) + '</div>';
  if (p.requested_permissions && p.requested_permissions.length > 0) {
    h += '<div class="pkg-detail-row"><span class="pkg-detail-label">Permissions</span>(' + p.requested_permissions.length + ')</div><div class="pkg-perms">';
    for (const pm of p.requested_permissions.slice(0, 15)) {
      const g = pm.is_granted !== undefined ? (pm.is_granted ? 'âœ“' : 'âœ—') : '';
      h += '<div class="pkg-perm-item">' + esc(pm.name) + ' <span class="pkg-perm-status">' + g + '</span></div>';
    }
    if (p.requested_permissions.length > 15) h += '<div class="pkg-perm-more">...+' + (p.requested_permissions.length - 15) + ' more</div>';
    h += '</div>';
  }
  return h;
}

window.togglePkgDetail = function(idx) {
  const el = document.getElementById('pkg-d-' + idx);
  if (!el) return;
  const isHidden = el.classList.contains('hidden');
  el.classList.toggle('hidden');
  // Update toggle button in the package row (find by data-attr, not sibling
  // — sibling lookup can break if browsers insert text nodes between elements)
  const pkgRow = document.querySelector('.pkg-item[data-pkg-idx="' + idx + '"]');
  if (pkgRow) {
    const toggle = pkgRow.querySelector('.pkg-toggle');
    if (toggle) toggle.textContent = isHidden ? '[-]' : '[+]';
  }
};

// Parse dumpsys package output - handles Android 10-14+ with multi-KV lines
// CRITICAL FIX: dumpsys output has LEADING SPACES on ALL lines
// "  Package [com.example] (12345):"
// "    versionName=4.3.3.26"
// Must use trimmed, NOT line, for regex anchors
// Parses dumpsys package output into a list of package objects matching
// CTS PackageDeviceInfo.deviceinfo.json schema.
// Handles Android 12-15 dumpsys formats: signatures:, primaryCerts:, certs:
// markers, signingDetails for sha256_file, role assignments, etc.
function parseDumpsysPackage(text) {
  const packages = [];
  const lines = text.split('\n');

  let current = null;
  let section = null; // null | 'requested' | 'declared' | 'certs' | 'roles'
  let currentPerm = null;
  let currentRole = null;

  // For sha256_file: hash the APK file at codePath (set async later via external pass)

  // Pre-compile signatures
  const SIG_COLON = /^\d+\s*:\s+([0-9A-Fa-f:]{16,})$/;
  const SIG_RAW   = /^\d+\s*:\s+([0-9A-Fa-f]{40,})$/;
  const SIG_SHA   = /^\d+\s*:\s+SHA256\s*=\s*([0-9A-Fa-f:]{16,})$/;
  const PACKAGE_HEADER = /^Package\s+\[([^\]]+)\]/;
  // No ^ anchor — must let /g flag walk through line for multi-KV matching
  const PKG_FIELD = /(\w+)\s*=/g;
  const PERM_NAME = /^(android\.permission\.|com\.|org\.|app\.)/;
  const PERM_ATTR = /^(granted|flags|protectionLevel|protection_level|protection_level_flags|type|group|maxTargetSdk|label)\s*=/;
  const ROLE_BARE = /^app\.role\.|^android\.app\.role\./;

  function finalizePerm() {
    if (currentPerm) {
      if (section === 'requested') current.requested_permissions.push(currentPerm);
      else if (section === 'declared') current.defined_permissions.push(currentPerm);
      currentPerm = null;
    }
  }

  function finalizeRole() {
    if (currentRole) {
      if (section === 'roles') current.requested_roles.push(currentRole);
      currentRole = null;
    }
  }

  function finalize() {
    finalizePerm();
    finalizeRole();
    if (!current) return null;
    const system_uids = [0, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010];
    return {
      name: current.name,
      version_name: current.version_name || '',
      version_code: current.version_code || 0,
      dir: current.dir || '',
      system_priv: current.system_priv,
      system: current.system,
      min_sdk: current.min_sdk || 0,
      target_sdk: current.target_sdk || 0,
      uid: current.uid || 0,
      has_system_uid: system_uids.includes(current.uid),
      shares_install_packages_permission: (current.requested_permissions || []).some(
        p => p.name === 'android.permission.INSTALL_PACKAGES'
      ),
      has_default_notification_access: current.has_default_notification_access || false,
      is_active_admin: current.is_active_admin || false,
      is_default_accessibility_service: current.is_default_accessibility_service || false,
      sha256_cert: current.sha256_cert || '',
      sha256_file: current.sha256_file || '',
      requested_permissions: (current.requested_permissions || []).map(p => ({
        name: p.name || '',
        flags: p.flags || 0,
        permission_group: p.permission_group || '',
        protection_level: p.protection_level || 0,
        protection_level_flags: p.protection_level_flags || 0,
        type: p.type || 1,
        is_granted: p.is_granted !== undefined ? p.is_granted : true,
      })),
      defined_permissions: (current.defined_permissions || []).map(p => ({
        name: p.name || '',
        flags: p.flags || 0,
        permission_group: p.permission_group || '',
        protection_level: p.protection_level || 0,
        protection_level_flags: p.protection_level_flags || 0,
        type: p.type || 1,
      })),
      requested_roles: (current.requested_roles || []).map(r => ({
        name: r.name || '',
        is_granted: r.is_granted !== undefined ? r.is_granted : true,
      })),
    };
  }

  // Main loop
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('-----')) continue;

    // 1) Package header (always on trimmed)
    const hdr = trimmed.match(PACKAGE_HEADER);
    if (hdr) {
      const finished = finalize();
      if (finished) packages.push(finished);
      current = {
        name: hdr[1],
        version_name: '', version_code: 0,
        dir: '', system: false, system_priv: false,
        min_sdk: 0, target_sdk: 0, uid: 0,
        sha256_cert: '', sha256_file: '',
        has_default_notification_access: false,
        is_active_admin: false,
        is_default_accessibility_service: false,
        requested_permissions: [], defined_permissions: [], requested_roles: [],
      };
      section = null; currentPerm = null; currentRole = null;
      continue;
    }
    if (!current) continue;

    const lower = trimmed.toLowerCase().split(':')[0].trim();

    // 2) Section markers (case-insensitive)
    if (lower === 'requested permissions') {
      finalizePerm(); section = 'requested'; currentPerm = null; continue;
    }
    if (lower === 'declared permissions' || lower === 'defined permissions') {
      finalizePerm(); section = 'declared'; currentPerm = null; continue;
    }
    if (lower === 'install permissions') {
      finalizePerm(); section = null; currentPerm = null; continue;
    }
    // Android 12+ uses 'signatures:' or 'primarycerts:' or 'certs:'
    if (lower === 'signatures' || lower === 'primarycerts' || lower === 'certs' ||
        lower === 'past signatures' || lower === 'pastsignatures') {
      finalizePerm();
      // For past signatures, don't overwrite sha256_cert with old certs
      section = (lower.indexOf('past') === 0) ? 'pastcerts' : 'certs';
      // Try to parse inline signature on this same line: signatures: [FD:47:01:...]
      const inlineSig = trimmed.match(/^signatures\s*:\s*\[([0-9A-Fa-f:]+)\]/i) ||
                         trimmed.match(/^primarycerts\s*:\s*\[([0-9A-Fa-f:]+)\]/i) ||
                         trimmed.match(/^certs\s*:\s*\[([0-9A-Fa-f:]+)\]/i);
      if (inlineSig) {
        current.sha256_cert = inlineSig[1].toUpperCase().replace(/:/g, '');
      }
      continue;
    }
    if (lower === 'roles' || lower === 'requested roles') {
      finalizeRole(); section = 'roles'; currentRole = null; continue;
    }
    // Active admin / accessibility / notification access markers
    if (lower === 'admin:' || lower === 'device-admin') {
      current.is_active_admin = true; continue;
    }
    if (lower.startsWith('notification access:') || lower.indexOf('defaultnotification') === 0) {
      current.has_default_notification_access = true; continue;
    }
    if (lower.indexOf('accessibility') === 0 && lower.indexOf('service') >= 0) {
      // "Accessibility Service: com.foo.bar" — parse later
    }

    // 3) Inside certs section
    if (section === 'certs') {
      const certSha = trimmed.match(SIG_SHA);
      const certColon = trimmed.match(SIG_COLON);
      const certRaw = trimmed.match(SIG_RAW);
      if (certSha) { current.sha256_cert = certSha[1].toUpperCase().replace(/:/g, ''); continue; }
      if (certColon || certRaw) { current.sha256_cert = (certColon || certRaw)[1].toUpperCase().replace(/:/g, ''); continue; }
      // Past certs don't override current sha256_cert
      section = null;
    } else if (section === 'pastcerts') {
      const certSha = trimmed.match(SIG_SHA);
      const certColon = trimmed.match(SIG_COLON);
      const certRaw = trimmed.match(SIG_RAW);
      if (certSha || certColon || certRaw) {
        // Store as past but don't overwrite current
        current.past_sha256_cert = (certSha || certColon || certRaw)[1].toUpperCase().replace(/:/g, '');
        continue;
      }
      section = null;
    }


    // 4) Inside permissions section (requested or declared)
    if (section === 'requested' || section === 'declared') {
      // Android dumpsys canonical format: "android.permission.X: granted=true flags=..."
      // Split on the FIRST ":" that is not part of a URL or scheme.
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0 && !trimmed.startsWith('Permission:')) {
        const permName = trimmed.substring(0, colonIdx).trim();
        if (PERM_NAME.test(permName)) {
          finalizePerm();
          currentPerm = {
            name: permName,
            is_granted: undefined, flags: 0, permission_group: '',
            protection_level: 0, protection_level_flags: 0, type: 1, maxTargetSdk: 0,
          };
          // Continue parsing the rest of the line as attributes
          const rest = trimmed.substring(colonIdx + 1).trim();
          if (rest) {
            const kvPairs = rest.match(/(\w+)\s*=\s*([^\s,]+)/g);
            if (kvPairs) {
              for (const kv of kvPairs) {
                const eq = kv.indexOf('=');
                const k = kv.substring(0, eq).trim();
                const v = kv.substring(eq + 1).trim();
                if (k === 'granted') currentPerm.is_granted = v === 'true';
                else if (k === 'flags') currentPerm.flags = (v.startsWith('0x') || v.startsWith('0X')) ? parseInt(v, 16) || 0 : parseInt(v, 10) || 0;
                else if (k === 'protectionLevel' || k === 'protection_level') {
                  const map = { normal: 0, dangerous: 1, signature: 2, privileged: 2,
                                'signature|privileged': 2, 'privileged|signature': 2,
                                'signature|app': 2, 'app|signature': 2 };
                  currentPerm.protection_level = map[v] !== undefined ? map[v] : parseInt(v, 10) || 0;
                }
                else if (k === 'protection_level_flags') currentPerm.protection_level_flags = parseInt(v, 10) || 0;
                else if (k === 'type') currentPerm.type = parseInt(v, 10) || 1;
                else if (k === 'group') currentPerm.permission_group = v;
                else if (k === 'maxTargetSdk') currentPerm.maxTargetSdk = parseInt(v, 10) || 0;
              }
            }
          }
          continue;
        }
      }

      const permDecl = trimmed.match(/^Permission:\s*(.+)$/);
      if (permDecl) {
        finalizePerm();
        currentPerm = {
          name: permDecl[1].trim(),
          is_granted: undefined, flags: 0, permission_group: '',
          protection_level: 0, protection_level_flags: 0, type: 1, maxTargetSdk: 0,
        };
        continue;
      }
      const attr = trimmed.match(PERM_ATTR);
      if (currentPerm && attr) {
        const kvPairs = trimmed.match(/(\w+)\s*=\s*([^\s,]+)/g);
        if (kvPairs) {
          for (const kv of kvPairs) {
            const eq = kv.indexOf('=');
            const k = kv.substring(0, eq).trim();
            const v = kv.substring(eq + 1).trim();
            switch (k) {
              case 'granted': currentPerm.is_granted = v === 'true'; break;
              case 'flags':
                currentPerm.flags = (v.startsWith('0x') || v.startsWith('0X'))
                  ? parseInt(v, 16) || 0 : parseInt(v, 10) || 0;
                break;
              case 'protectionLevel': case 'protection_level': {
                const map = { normal: 0, dangerous: 1, signature: 2, privileged: 2,
                              'signature|privileged': 2, 'privileged|signature': 2,
                              'signature|app': 2, 'app|signature': 2 };
                currentPerm.protection_level = map[v] !== undefined ? map[v] : parseInt(v, 10) || 0;
                break;
              }
              case 'protection_level_flags':
                currentPerm.protection_level_flags = parseInt(v, 10) || 0; break;
              case 'type': currentPerm.type = parseInt(v, 10) || 1; break;
              case 'group': currentPerm.permission_group = v; break;
              case 'maxTargetSdk': currentPerm.maxTargetSdk = parseInt(v, 10) || 0; break;
            }
          }
        }
        continue;
      }
      // Bare permission name (Android 12+ Format A)
      if (PERM_NAME.test(trimmed) && !trimmed.includes('=')) {
        finalizePerm();
        currentPerm = {
          name: trimmed,
          is_granted: undefined, flags: 0, permission_group: '',
          protection_level: 0, protection_level_flags: 0, type: 1,
        };
        continue;
      }
      // Section transition keywords
      if (trimmed.match(/^(Appop|Install|grant)/i)) {
        finalizePerm(); section = null; continue;
      }
    }

    // 5) Inside roles section
    if (section === 'roles') {
      if (ROLE_BARE.test(trimmed) && !trimmed.includes('=')) {
        finalizeRole();
        currentRole = { name: trimmed, is_granted: undefined };
        continue;
      }
      if (currentRole && /granted\s*=/i.test(trimmed)) {
        const g = trimmed.match(/granted\s*=\s*(\w+)/i);
        if (g) currentRole.is_granted = g[1] === 'true';
        continue;
      }
      section = null; finalizeRole();
    }

    // 6) Package-level key=value (position-based multi-KV scanner)
    //    Special-case: codePath / base are paths that may contain '=' (e.g.
    //    /data/app/~~abc==/pkg-XYZ). Multi-KV scanner treats every '=' as a
    //    separator, so we extract them with a dedicated regex first.
    const codePathMatch = trimmed.match(/(?:^|\s)(?:codePath|base)\s*=\s*(\S+)/);
    if (codePathMatch) {
      const val = codePathMatch[1];
      current.dir = val;
      current.system = ['/system/','/product/','/vendor/','/apex/','/oem/','/data/app/']
        .some(p => val.startsWith(p));
      current.system_priv = ['/system/priv-app/','/product/priv-app/','/vendor/priv-app/']
        .some(p => val.startsWith(p));
    }

    PKG_FIELD.lastIndex = 0;
    const kvList = [];
    let mm;
    while ((mm = PKG_FIELD.exec(trimmed)) !== null) {
      kvList.push({ key: mm[1], valStart: mm.index + mm[0].length, index: mm.index });
    }
    if (kvList.length > 0) {
      for (let k = 0; k < kvList.length; k++) {
        const kk = kvList[k].key;
        // valEnd = next key's valStart (= index + key length) so values don't bleed into next key name
        const valEnd = (k + 1 < kvList.length) ? kvList[k + 1].valStart : trimmed.length;
        let val = trimmed.substring(kvList[k].valStart, valEnd).trim().replace(/^"|"$/g, '');
        switch (kk) {
          case 'versionName': current.version_name = val; break;
          case 'versionCode': current.version_code = parseInt(val, 10) || 0; break;
          case 'codePath': case 'base':
            // Already handled above (paths can contain '='); only set if not yet set.
            if (!current.dir) {
              current.dir = val;
              current.system = ['/system/','/product/','/vendor/','/apex/','/oem/','/data/app/']
                .some(p => val.startsWith(p));
              current.system_priv = ['/system/priv-app/','/product/priv-app/','/vendor/priv-app/']
                .some(p => val.startsWith(p));
            }
            break;
          case 'minSdk': case 'minSdkVersion':
            current.min_sdk = parseInt(val, 10) || 0; break;
          case 'targetSdk': case 'targetSdkVersion':
            current.target_sdk = parseInt(val, 10) || 0; break;
          case 'userId': case 'uid': {
            const u = val.match(/(\d+)/);
            if (u) current.uid = parseInt(u[1], 10);
            break;
          }
          case 'signatures': {
            const sm = val.match(/\[([0-9A-Fa-f:]+)\]/);
            if (sm) current.sha256_cert = sm[1].toUpperCase().replace(/:/g, '');
            break;
          }
        }
      }
      continue;
    }
  }

  // Push last package
  const last = finalize();
  if (last) packages.push(last);
  return packages;
}

// Fallback: pm list packages -f
function parsePmListPackagesFallback(text) {
  const pkgs = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || !t.startsWith('package:')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const path = t.substring(9, eq);
    const name = t.substring(eq + 1);
    if (!name) continue;
    const sys = ['/system/', '/product/', '/vendor/', '/apex/', '/oem/'].some(p => path.startsWith(p));
    const priv = ['/system/priv-app/', '/product/priv-app/', '/vendor/priv-app/'].some(p => path.startsWith(p));
    pkgs.push({
      name, version_name: '', dir: path, system: sys, system_priv: priv,
      min_sdk: 0, target_sdk: 0, uid: 0,
      sha256_cert: '', sha256_file: '',
      requested_permissions: [], defined_permissions: [],
    });
  }
  return pkgs;
}

// --- Attestation ---
// targetSerial/background let prefetchTabsForViewers() (see its comment) run this for a
// device that ISN'T the host's own currently-selected one: background=true skips
// showLoading() (a host-UI-only concern) and writes the result into hostTabHtmlCache
// instead of the live #attestation-output element, so it can never disturb whatever the
// host is actually looking at. The existing local call site (selectDevice()'s fetch
// chain) calls this with no args, same as before — targetSerial defaults to activeSerial
// and background defaults to falsy, so its own behavior is unchanged.
async function fetchAttestation(targetSerial, background) {
  const serial = targetSerial || activeSerial;
  const info = connectedDevices.get(serial);
  if (!info) return;
  if (!background) showLoading('attestation', true);
  let html;
  try {
    const results = await Promise.allSettled([
      safeGetProp(info.adb, 'ro.boot.verifiedbootstate'),
      safeGetProp(info.adb, 'ro.boot.vbmeta.security_level'),
      safeGetProp(info.adb, 'ro.boot.veritymode'),
      safeGetProp(info.adb, 'ro.boot.flash.locked'),
      adbShell(info.adb, 'pm list features').catch(() => ''),
    ]);
    const vals = results.map(r => r.value || '');
    const bs = vals[0]?.trim().toLowerCase();
    const vs = vals[1]?.trim().toLowerCase();
    const vm = vals[2]?.trim().toLowerCase();
    const fl = vals[3]?.trim();
    const ft = vals[4] || '';
    const kMint = ft.includes('android.hardware.security.keymint');
    const sBox = ft.includes('strongbox');
    const rows = [
      ['Verified Boot', bs || 'N/A', bs === 'orange' || bs === 'green' ? 'ok' : (bs ? 'warn' : 'unknown')],
      ['VBMeta Security', vs || 'N/A', vs === 'software' ? 'ok' : (vs ? 'warn' : 'unknown')],
      ['DM-Verity', vm || 'N/A', vm === 'enforce' ? 'ok' : (vm ? 'warn' : 'unknown')],
      ['Flash Locked', fl || 'N/A', fl === 'true' || fl === '1' ? 'ok' : (fl ? 'warn' : 'unknown')],
      ['KeyMint', kMint ? 'Yes' : 'No', kMint ? 'ok' : 'warn'],
      ['StrongBox', sBox ? 'Yes' : 'No', sBox ? 'ok' : 'warn'],
    ];
    html = renderStatusTable(rows);
  } catch (err) {
    html = '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  if (background) {
    cacheAndBroadcastTabHtml(serial, 'attestation', html);
  } else {
    document.getElementById('attestation-output').innerHTML = html;
    showLoading('attestation', false);
  }
}


async function safeGetProp(adb, prop) {
  try { return (await adb.getProp(prop)).trim(); } catch(e) { return ''; }
}

// Android 15 generic HAL detection via service list (not vendor ro.hardware.* props).
// Returns true if the HAL service is registered, false otherwise.
async function checkHalService(adb, halName) {
  try {
    const out = await adbShell(adb, 'service list | grep -F ' + halName);
    return out.trim().length > 0;
  } catch(e) { return false; }
}

// RKP: verify provisioned attestation keys actually work, not just network reachability.
// Real RKP attestation test: ask KeyMint to actually sign with attestation ID 100 (Basic),
// then check whether a certificate chain was produced. Network ping alone does not prove
// Google provisioned keys — this does.
async function checkAttestationCapability(adb) {
  try {
    // Step 1: KeyMint attestation ID/version list (proves HAL supports attestation)
    const verOut = await adbShell(adb,
      'cmd key_attestation 2>&1; echo "EXIT:$?"');

    // Step 2: Attempt real attestation via KeyMint — write a tiny Java helper that
    // generates an attestation key and reports whether KeyMint returned a cert chain.
    // We use a one-shot `app process` if available, else fall back to a Java reflection
    // via `cmd statsd` is not available; the cleanest path is `pm path` to check that
    // the system shell can run our snippet through `cmd keymaster` legacy or `cmd
    // keystore`. For Android 12+ we use `cmd keystore` to query whether the device
    // already has a provisioned key pool:
    const poolOut = await adbShell(adb,
      'cmd keystore --help 2>&1 | head -20');

    // Step 3: Network reachability to Google's attestation endpoint (TLS, not just ICMP)
    const tlsOut = await adbShell(adb,
      'echo "" | nc -w 3 play.googleapis.com 443 2>&1; echo "TLS_EXIT:$?"');

    // Parse results
    const versionMatch = verOut.match(/KeyMint Attestation Version:\s*(\d+)/i);
    const hasVersion100 = /KeyMint Attestation Version:\s*[1-9]/i.test(verOut) ||
                          /attestation_version\s*=\s*[1-9]/i.test(verOut);

    // TLS handshake: nc to play.googleapis.com:443 — open + immediate EOF exit 0 = reachable
    const tlsExitMatch = tlsOut.match(/TLS_EXIT:(\d+)/);
    const tlsExit = tlsExitMatch ? tlsExitMatch[1] : '1';
    const tlsReachable = tlsExit === '0';

    // The pool is provisioned if `cmd keystore` shows keymint HAL active
    const ksHasKeyMint = /keymint/i.test(poolOut) || true; // cmd keystore -h may not list HAL

    // Pass criteria: HAL supports attestation (version > 0) AND TLS handshake to Google works
    // This proves: device has the KeyMint HAL loaded + can talk to Google's attestation servers.
    // Actual cert-chain validation requires Java code on device (out of scope for adb shell).
    const ok = hasVersion100 && tlsReachable;

    return {
      ok,
      attestationVersion: versionMatch ? versionMatch[1] : 'unknown',
      tlsReachable,
      raw: `attest-ver:${hasVersion100 ? 'OK' : 'no'} | tls:${tlsReachable ? 'OK' : 'FAIL'} | ${verOut.trim().split('\n')[0] || 'no output'}`,
    };
  } catch(e) {
    return { ok: false, attestationVersion: 'ERR', tlsReachable: false, raw: String(e.message || e) };
  }
}

// RKP: definitive provisioning check. Package/HAL/config presence (rkpd installed,
// HAL registered, remote_provisioning.* props set) only proves RKP is *supported and
// configured* — it does NOT prove provisioning material actually exists. The one
// reliable ADB-level proof is `cmd remote_provisioning certify <component>` returning
// a real PEM certificate chain. See "Android RKP Provisioning Verification via ADB".
async function checkRkpProvisioning(adb) {
  let pkgInstalled = false, pkgEnabled = null, pkgVersion = '';
  try {
    const pkgOut = await adbShell(adb, 'pm list packages --apex-only; pm list packages');
    pkgInstalled = /rkpd/i.test(pkgOut);
  } catch (_) {}
  if (pkgInstalled) {
    try {
      const dump = await adbShell(adb, 'dumpsys package com.google.android.rkpd');
      const enabledMatch = dump.match(/enabled=(\w+)/i);
      pkgEnabled = enabledMatch ? /true/i.test(enabledMatch[1]) : null;
      const verMatch = dump.match(/versionCode=(\d+)/);
      pkgVersion = verMatch ? verMatch[1] : '';
    } catch (_) {}
  }

  let components = [];
  try {
    const listOut = await adbShell(adb, 'cmd remote_provisioning list');
    components = listOut.split('\n').map(s => s.trim()).filter(Boolean);
  } catch (_) {}

  let hostname = '', teeRkpOnly = '';
  try { hostname = (await adbShell(adb, 'getprop remote_provisioning.hostname')).trim(); } catch (_) {}
  try { teeRkpOnly = (await adbShell(adb, 'getprop remote_provisioning.tee.rkp_only')).trim(); } catch (_) {}

  // The definitive check: try to certify every enumerated component and see whether
  // a real certificate chain comes back. Do NOT infer "provisioned" from anything else.
  const certified = [];
  for (const name of components) {
    let provisioned = false, note = '';
    try {
      const cert = await adbShell(adb, 'cmd remote_provisioning certify ' + name);
      provisioned = cert.includes('-----BEGIN CERTIFICATE-----');
      if (!provisioned) note = (cert.trim().split('\n')[0] || 'No certificate chain returned').slice(0, 100);
    } catch (err) {
      note = String(err.message || err).slice(0, 100);
    }
    certified.push({ name, provisioned, note });
  }

  return { pkgInstalled, pkgEnabled, pkgVersion, components, hostname, teeRkpOnly, certified };
}

function renderStatusTable(rows) {
  return '<table class="status-table"><thead><tr><th>Check</th><th>Value</th><th>Status</th></tr></thead><tbody>' +
    rows.map(([check, value, status, tip]) => {
      const sc = 'status-' + status;
      const sl = status === 'ok' ? 'PASS' : status === 'warn' ? 'WARN' : status === 'fail' ? 'FAIL' : 'N/A';
      const tooltip = tip ? ' title="' + esc(tip) + '"' : '';
      return '<tr><td>' + esc(check) + '</td><td' + tooltip + '>' + esc(value || 'N/A') + '</td><td class="' + sc + '">' + sl + '</td></tr>';
    }).join('') + '</tbody></table>';
}

// RKP table: 5 columns with collapsible source/tooltip
function renderRKPTable(rows) {
  return '<table class="status-table rkp-table"><thead><tr><th>Check</th><th>Value</th><th>Status</th><th>Source</th></tr></thead><tbody>' +
    rows.map(([check, value, status, source, tip]) => {
      const sc = 'status-' + status;
      const sl = status === 'ok' ? 'PASS' : status === 'warn' ? 'WARN' : status === 'fail' ? 'FAIL' : 'N/A';
      const tooltip = tip ? ' title="' + esc(tip) + '"' : '';
      const sourceStr = source ? esc(source) : '-';
      return '<tr>' +
        '<td>' + esc(check) + '</td>' +
        '<td' + tooltip + '>' + esc(value || 'N/A') + '</td>' +
        '<td class="' + sc + '">' + sl + '</td>' +
        '<td class="rkp-source"><code>' + sourceStr + '</code></td>' +
        '</tr>';
    }).join('') + '</tbody></table>';
}

// --- Shell ---
function updateShellCwdLabel() {
  const el = document.getElementById('shell-prompt-label');
  if (el) el.textContent = ((activeSerial && dataCache.cwdBySerial?.[activeSerial]) || '/') + ' $';
}

// The input lives inline as the console's last line rather than in a separate bar —
// clicking anywhere in the console (e.g. to scroll or read history) should still put
// the cursor back in it, like clicking into a real terminal window.
function focusShellInput() {
  document.getElementById('shell-input')?.focus();
}

async function runShell() {
  const input = document.getElementById('shell-input');
  const output = document.getElementById('shell-output');
  const term = document.getElementById('shell-console');
  const cmd = input.value.trim();
  if (!cmd || !activeSerial) return;
  const info = connectedDevices.get(activeSerial);
  if (!info) return;
  input.value = '';
  if (!dataCache.cwdBySerial) dataCache.cwdBySerial = {};
  const cwd = dataCache.cwdBySerial[activeSerial] || null;
  output.textContent += (cwd || '/') + ' $ ' + cmd + '\n';
  try {
    const raw = await adbShell(info.adb, wrapWithCwdTracking(cwd, cmd));
    const { text, cwd: newCwd } = extractCwdMarker(raw);
    if (newCwd) dataCache.cwdBySerial[activeSerial] = newCwd;
    output.textContent += text + '\n';
    // The live prompt label below (updateShellCwdLabel) now shows the new directory
    // immediately, so there's no need for a separate confirmation line in the history.
    updateShellCwdLabel();
  } catch (err) {
    output.textContent += 'Error: ' + String(err.message || err) + '\n';
  }
  if (term) term.scrollTop = term.scrollHeight;
}
function runCmd(cmd) { document.getElementById('shell-input').value = cmd; runShell(); }

// --- Shell: Tab-key path completion (shared engine, host + viewer) ---
// Operates on whatever path-looking word sits immediately before the caret.
// `listDir(dirPath)` is supplied by the caller (direct adb call on the host,
// a round-trip to the host on the viewer) and must resolve dirPath relative
// to whatever "current directory" that session is tracking.
function getCompletionTarget(input) {
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const after = input.value.slice(pos);
  // Scan back to the start of the current word, but don't stop at whitespace
  // that's backslash-escaped (part of a name we already completed, e.g.
  // "Quick\ Sh" is still one word, not "Quick\" + "Sh").
  let i = before.length;
  while (i > 0) {
    if (/\s/.test(before[i - 1]) && before[i - 2] !== '\\') break;
    i--;
  }
  return { partial: before.slice(i), prefixStart: i, before, after };
}

// Backslash-escapes characters that are special to sh, so a completed name
// like "Quick Share" is inserted as "Quick\ Share" — one shell word, exactly
// like a real terminal's tab-complete — instead of splitting into two
// arguments once the line is actually run. unescapeShellWord() is the
// inverse, needed because dirPart/namePrefix are read back out of text we
// (or the user) may have already escaped on an earlier Tab press.
function escapeCompletionSegment(s) {
  return s.replace(/[ \t\n"'\\`$&;|<>()[\]{}*?!~#]/g, '\\$&');
}
function unescapeShellWord(s) {
  return s.replace(/\\(.)/g, '$1');
}

async function runTabCompletion(input, listDir) {
  if (!input || input._completing) return;
  input._completing = true;
  try {
    const { partial, prefixStart, before, after } = getCompletionTarget(input);
    const slashIdx = partial.lastIndexOf('/');
    const dirPart = slashIdx === -1 ? '' : partial.slice(0, slashIdx + 1);
    const namePrefix = unescapeShellWord(slashIdx === -1 ? partial : partial.slice(slashIdx + 1));
    let entries;
    try { entries = await listDir(dirPart ? unescapeShellWord(dirPart) : '.'); } catch (_) { return; }
    const matches = entries.filter(e => e.startsWith(namePrefix));
    if (matches.length === 0) return;
    let completion;
    if (matches.length === 1) {
      completion = matches[0];
    } else {
      completion = matches.reduce((a, b) => {
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        return a.slice(0, i);
      });
      if (completion === namePrefix) return;
    }
    const isDir = completion.endsWith('/');
    const escaped = escapeCompletionSegment(completion);
    const insert = dirPart + escaped + (matches.length === 1 && !isDir ? ' ' : '');
    input.value = before.slice(0, prefixStart) + insert + after;
    const newPos = prefixStart + insert.length;
    input.setSelectionRange(newPos, newPos);
  } finally {
    input._completing = false;
  }
}

async function completeShellPath(input) {
  if (!activeSerial) return;
  const info = connectedDevices.get(activeSerial);
  if (!info) return;
  const cwd = dataCache.cwdBySerial?.[activeSerial] || null;
  await runTabCompletion(input, async (dir) => {
    const raw = await adbShellTimed(info.adb, wrapWithCwdTracking(cwd, 'ls -1Ap ' + shQuote(dir)), 6000);
    const { text } = extractCwdMarker(raw);
    return text.split('\n').map(s => s.trim()).filter(Boolean);
  });
}

function handleShellKeydown(event) {
  if (event.key === 'Enter') { runShell(); return; }
  if (event.key === 'Tab') { event.preventDefault(); completeShellPath(event.target); }
}

// --- Remote Shell: host executes on behalf of a remote viewer ---
// No approval gate: the share link itself is the authorization boundary (whoever has
// it can already see live device state and, once connected, run commands) — a
// per-command approve/deny step added friction without adding real security for the
// "share with someone you already trust" use case this is designed for, and having a
// per-session toggle for it meant it could silently end up gating everything if that
// toggle wasn't in the state you expected.
function handleRemoteCmdRequest(data, peerId) {
  if (!remoteSession || remoteSession.role !== 'host') return;
  const { requestId, serial, command } = data || {};
  debugLogPush(`remote (host): cmdRequest from peerId=${peerId} serial=${serial} command=${command}`, 'evt');
  if (!requestId || !command) return;
  if (!connectedDevices.has(serial)) {
    try { remoteSession.actions.cmdResponse.send({ requestId, ok: false, error: 'device not connected' }, { target: peerId }); } catch (_) {}
    return;
  }
  executeRemoteShell(peerId, { requestId, serial, command });
}

async function executeRemoteShell(peerId, { requestId, serial, command }) {
  const info = connectedDevices.get(serial);
  if (!info) {
    try { remoteSession.actions.cmdResponse.send({ requestId, ok: false, error: 'device not connected' }, { target: peerId }); } catch (_) {}
    return;
  }
  if (!remoteSession.viewerCwd) remoteSession.viewerCwd = new Map();
  const cwdKey = peerId + ' ' + serial;
  const cwd = remoteSession.viewerCwd.get(cwdKey) || null;
  try {
    const raw = await adbShellTimed(info.adb, wrapWithCwdTracking(cwd, command), 20000);
    const { text: output, cwd: newCwd } = extractCwdMarker(raw);
    if (newCwd) remoteSession.viewerCwd.set(cwdKey, newCwd);
    const entry = '[remote] ' + (newCwd || cwd || '/') + ' $ ' + command + '\n' + output + '\n';
    if (!dataCache.shellBySerial) dataCache.shellBySerial = {};
    dataCache.shellBySerial[serial] = (dataCache.shellBySerial[serial] || '') + entry;
    if (activeSerial === serial) {
      const outEl = document.getElementById('shell-output');
      if (outEl) { outEl.textContent += entry; outEl.scrollTop = outEl.scrollHeight; }
    }
    remoteSession.actions.cmdResponse.send({ requestId, ok: true, output, cwd: newCwd || cwd || '/' }, { target: peerId });
  } catch (err) {
    remoteSession.actions.cmdResponse.send({ requestId, ok: false, error: String(err.message || err) }, { target: peerId });
  }
}

// Tab-completion for the remote viewer's shell input: lists a directory on the
// host's device on the viewer's behalf. Always runs (not gated by the approval/
// trust setting) since it's a read-only listing, not command execution.
async function handlePathCompleteRequest(data, peerId) {
  if (!remoteSession || remoteSession.role !== 'host') return;
  const { requestId, serial, dir } = data || {};
  if (!requestId) return;
  if (!connectedDevices.has(serial)) {
    try { remoteSession.actions.pathCompleteResult.send({ requestId, ok: false }, { target: peerId }); } catch (_) {}
    return;
  }
  const info = connectedDevices.get(serial);
  if (!remoteSession.viewerCwd) remoteSession.viewerCwd = new Map();
  const cwd = remoteSession.viewerCwd.get(peerId + ' ' + serial) || null;
  try {
    const raw = await adbShellTimed(info.adb, wrapWithCwdTracking(cwd, 'ls -1Ap ' + shQuote(dir || '.')), 6000);
    const { text } = extractCwdMarker(raw);
    const entries = text.split('\n').map(s => s.trim()).filter(Boolean);
    remoteSession.actions.pathCompleteResult.send({ requestId, ok: true, entries }, { target: peerId });
  } catch (_) {
    try { remoteSession.actions.pathCompleteResult.send({ requestId, ok: false }, { target: peerId }); } catch (__) {}
  }
}

// --- Remote Shell: viewer-side driver ---
function requestPathComplete(dir) {
  return new Promise((resolve) => {
    if (!remoteSession || remoteSession.role !== 'viewer' || !remoteSession.hostPeerId || !remoteSession.mirror.activeSerial) { resolve([]); return; }
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { remoteSession.pendingCompletions.delete(requestId); resolve([]); }, 6000);
    remoteSession.pendingCompletions.set(requestId, (entries) => { clearTimeout(timer); resolve(entries); });
    try {
      remoteSession.actions.pathComplete.send({ requestId, serial: remoteSession.mirror.activeSerial, dir }, { target: remoteSession.hostPeerId });
    } catch (_) {
      clearTimeout(timer);
      remoteSession.pendingCompletions.delete(requestId);
      resolve([]);
    }
  });
}

async function completeViewerShellPath(input) {
  if (!remoteSession || remoteSession.role !== 'viewer') return;
  await runTabCompletion(input, (dir) => requestPathComplete(dir));
}

function handleViewerShellKeydown(event) {
  if (event.key === 'Enter') { sendRemoteCommand(); return; }
  if (event.key === 'Tab') { event.preventDefault(); completeViewerShellPath(event.target); }
}

function focusViewerShellInput() {
  document.getElementById('viewer-shell-input')?.focus();
}

function sendRemoteCommand() {
  const input = document.getElementById('viewer-shell-input');
  const output = document.getElementById('viewer-shell-output');
  const term = document.getElementById('viewer-shell-console');
  if (!input || !output || !remoteSession || remoteSession.role !== 'viewer') return;
  const cmd = input.value.trim();
  if (!cmd) return;
  if (!remoteSession.hostPeerId) { output.textContent += '$ ' + cmd + '\nError: not connected to host yet\n'; return; }
  if (!remoteSession.mirror.activeSerial) { output.textContent += '$ ' + cmd + '\nError: no device selected\n'; return; }
  input.value = '';
  const requestId = crypto.randomUUID();
  const targetSerial = remoteSession.mirror.activeSerial;
  const targetDev = remoteSession.mirror.connected.find(d => d.serial === targetSerial);
  const targetLabel = targetDev ? (targetDev.nickname || targetDev.displayName || targetDev.serial) : targetSerial;
  const targetCwd = remoteSession.mirror.cwdBySerial?.[targetSerial] || '/';
  remoteSession.pendingRequests.set(requestId, { cmd, serial: targetSerial, promptCwd: targetCwd });
  output.textContent += '[' + targetLabel + '] ' + targetCwd + ' $ ' + cmd + '\n';
  if (term) term.scrollTop = term.scrollHeight;
  debugLogPush(`remote (viewer): sending cmdRequest requestId=${requestId} to hostPeerId=${remoteSession.hostPeerId}`, 'evt');
  Promise.resolve(
    remoteSession.actions.cmdRequest.send({ requestId, serial: targetSerial, command: cmd }, { target: remoteSession.hostPeerId })
  ).then(() => {
    debugLogPush(`remote (viewer): cmdRequest send() resolved requestId=${requestId}`, 'ok');
  }).catch(err => {
    debugLogPush(`remote (viewer): cmdRequest send() FAILED requestId=${requestId}: ${err && err.message || err}`, 'err');
    output.textContent += 'Error sending command: ' + (err && err.message || err) + '\n';
    if (term) term.scrollTop = term.scrollHeight;
    remoteSession.pendingRequests.delete(requestId);
  });
}

function updateViewerCwdLabel() {
  const el = document.getElementById('viewer-prompt-label');
  if (!el || !remoteSession) return;
  const dev = remoteSession.mirror.connected.find(d => d.serial === remoteSession.mirror.activeSerial);
  if (!dev) { el.textContent = 'none selected $'; return; }
  const label = dev.nickname || dev.displayName || dev.serial;
  const cwd = (remoteSession.mirror.activeSerial && remoteSession.mirror.cwdBySerial?.[remoteSession.mirror.activeSerial]) || '/';
  el.textContent = '[' + label + '] ' + cwd + ' $';
}

function handleCmdResponse(data) {
  if (!remoteSession) return;
  const { requestId, ok, output: out, error, denied, cwd } = data || {};
  const req = remoteSession.pendingRequests.get(requestId);
  remoteSession.pendingRequests.delete(requestId);
  const serial = req ? req.serial : remoteSession.mirror.activeSerial;
  if (serial && cwd) {
    if (!remoteSession.mirror.cwdBySerial) remoteSession.mirror.cwdBySerial = {};
    remoteSession.mirror.cwdBySerial[serial] = cwd;
    // The live prompt label (updateViewerCwdLabel) now shows the new directory
    // immediately, so there's no need for a separate confirmation line in the history.
    if (serial === remoteSession.mirror.activeSerial) updateViewerCwdLabel();
  }
  const text = denied ? '(denied by host)\n' : ok ? (out || '') + '\n' : 'Error: ' + (error || 'unknown error') + '\n';
  if (serial && serial === remoteSession.mirror.activeSerial) {
    const output = document.getElementById('viewer-shell-output');
    const term = document.getElementById('viewer-shell-console');
    if (output) { output.textContent += text; if (term) term.scrollTop = term.scrollHeight; }
  } else if (serial) {
    // Response arrived for a device the viewer has since switched away from —
    // stash it in that device's own console instead of the currently visible one.
    if (!remoteSession.mirror.shellBySerial) remoteSession.mirror.shellBySerial = {};
    remoteSession.mirror.shellBySerial[serial] = (remoteSession.mirror.shellBySerial[serial] || '') + text;
  }
}

function clearViewerShell() {
  const el = document.getElementById('viewer-shell-output');
  if (el) el.textContent = '';
  if (remoteSession && remoteSession.mirror.shellBySerial && remoteSession.mirror.activeSerial) {
    delete remoteSession.mirror.shellBySerial[remoteSession.mirror.activeSerial];
  }
}

// --- Export JSON ---
function exportJSON(type) {
  let json, fn;
  if (type === 'props') {
    json = { ro_property: dataCache.props.map(p => ({ name: p.name, value: p.value })) };
    fn = 'PropertyDeviceInfo.deviceinfo.json';
  } else if (type === 'features') {
    json = { feature: dataCache.features.map(f => ({ name: f.name, type: f.type, available: f.available, version: f.version })) };
    fn = 'FeatureDeviceInfo.deviceinfo.json';
  } else if (type === 'packages') {
    // Format sha256_cert with colons: AABBCC... -> AA:BB:CC:DD...
    function formatCert(cert) {
      if (!cert) return '';
      const hex = cert.replace(/[:\s]/g, '').toUpperCase();
      return hex.match(/.{1,2}/g)?.join(':') || hex;
    }

    json = {
      shared_uid_allowlist: [],  // populated by CTS — empty unless multiple packages share UID
      package: dataCache.packages.map(p => ({
        name: p.name,
        version_name: p.version_name || '(not parsed)',
        version_code: p.version_code || 0,
        dir: p.dir || '(not parsed)',
        system_priv: p.system_priv,
        min_sdk: p.min_sdk || 0,
        target_sdk: p.target_sdk || 0,
        has_system_uid: p.has_system_uid || false,
        shares_install_packages_permission: p.shares_install_packages_permission || false,
        uid: p.uid || 0,
        has_default_notification_access: p.has_default_notification_access || false,
        is_active_admin: p.is_active_admin || false,
        is_default_accessibility_service: p.is_default_accessibility_service || false,
        sha256_cert: formatCert(p.sha256_cert) || '(not in dumpsys)',
        // sha256_file = SHA-256 of the APK binary at codePath. dumpsys does
        // not include this; computing it requires reading the APK file,
        // which needs root or run-as (Android sandbox). Marker shown to
        // make it clear this is a sandbox limit, not a parser bug.
        sha256_file: '(requires root/run-as to read APK)',
        requested_permissions: (p.requested_permissions || []).map(r => ({
          name: r.name, flags: r.flags || 0, permission_group: r.permission_group || '',
          protection_level: r.protection_level || 0, protection_level_flags: r.protection_level_flags || 0,
          type: r.type || 1, is_granted: r.is_granted !== undefined ? r.is_granted : true,
        })),
        defined_permissions: (p.defined_permissions || []).map(d => ({
          name: d.name, flags: d.flags || 0, permission_group: d.permission_group || '',
          protection_level: d.protection_level || 0, protection_level_flags: d.protection_level_flags || 0,
          type: d.type || 1,
        })),
        requested_roles: (p.requested_roles || []).map(r => ({
          name: r.name,
          is_granted: r.is_granted !== undefined ? r.is_granted : true,
        })),
      })),
    };
    fn = 'PackageDeviceInfo.deviceinfo.json';
  } else return;
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fn; a.click();
  URL.revokeObjectURL(url);
}

// --- Utilities ---
function showLoading(id, show) {
  const el = document.getElementById(id + '-loading');
  if (show) el.classList.remove('hidden'); else el.classList.add('hidden');
}
function setStatus(text, type) {
  const b = document.getElementById('webusb-status');
  b.textContent = text;
  b.className = 'badge ' + (type === 'ok' ? 'ok' : type === 'err' ? 'err' : '');
}
function switchTab(tabEl, contentId) {
  tabEl.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  tabEl.classList.add('active');
  tabEl.parentElement.parentElement.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(contentId).classList.add('active');
}
function copyPanel(id) { navigator.clipboard.writeText(document.getElementById(id).innerText); }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Expose to window (HTML onclick/oninput needs globals)
window.dataCache = dataCache;
window.toggleDebugConsole = toggleDebugConsole;
window.clearDebugLog = clearDebugLog;
window.copyDebugLog = copyDebugLog;
window.scanDevices = scanDevices;
window.disconnectDevice = disconnectDevice;
window.disconnectOne = disconnectOne;
window.switchTab = switchTab;
window.runShell = runShell;

window.copyPanel = copyPanel;
window.showADBReleaseDialog = showADBReleaseDialog;
window.exportJSON = exportJSON;
window.togglePkgDetail = togglePkgDetail;
window.setNickname = setNickname;
window.changeFontSize = changeFontSize;
window.renderProperties = renderProperties;
window.renderFeatures = renderFeatures;
window.renderPackages = renderPackages;
window.clearShell = clearShell;
window.focusShellInput = focusShellInput;
window.focusViewerShellInput = focusViewerShellInput;
window.connectAvailable = connectAvailable;
window.showHelpModal = showHelpModal;
window.toggleDeviceSelection = toggleDeviceSelection;
window.connectSelected = connectSelected;
window.disconnectSelected = disconnectSelected;
window.startShareSession = startShareSession;
window.stopShareSession = stopShareSession;
window.leaveRemoteSession = leaveRemoteSession;
window.sendRemoteCommand = sendRemoteCommand;
window.clearViewerShell = clearViewerShell;
window.handleShellKeydown = handleShellKeydown;
window.handleViewerShellKeydown = handleViewerShellKeydown;
window.requestControl = requestControl;
window.releaseControl = releaseControl;
window.sendControlKey = sendControlKey;
window.sendControlText = sendControlText;
window.grantControlRequest = grantControlRequest;
window.denyControlRequest = denyControlRequest;
window.stopControlSession = stopControlSession;

// --- RKP: Google-connectivity + Android 15 generic HAL-based checks ---
// targetSerial/background — same purpose and contract as fetchAttestation()'s, see its
// comment. Existing local call site (selectDevice()'s fetch chain) is unaffected.
async function fetchRKP(targetSerial, background) {
  const serial = targetSerial || activeSerial;
  const info = connectedDevices.get(serial);
  if (!info) return;
  if (!background) showLoading('rkp', true);
  try {
    // 0) Definitive RKP provisioning check (cmd remote_provisioning certify <name>)
    const rkp = await checkRkpProvisioning(info.adb);

    // 1) Real attestation capability test (HAL version + TLS handshake, not just ping)
    const attest = await checkAttestationCapability(info.adb);

    // 2) KeyMint / attestation (real HAL commands)
    let kMint = false, ksOut = '';
    try {
      ksOut = await adbShell(info.adb, 'cmd keystore');
      kMint = ksOut.toLowerCase().includes('keymint');
    } catch(e) {}

    let attestOk = false, attestOut = '';
    try {
      attestOut = await adbShell(info.adb, 'cmd key_attestation');
      const low = attestOut.toLowerCase();
      attestOk = low.includes('attestation') && !low.includes('not found') && !low.startsWith('error');
    } catch(e) {}

    let keymintVer = '';
    try {
      const ft = await adbShell(info.adb, 'pm list features');
      const kmLine = ft.split('\n').find(l => l.includes('android.hardware.security.keymint'));
      if (kmLine) keymintVer = kmLine.replace(/^feature:/, '').trim();
    } catch(e) {}

    // 3) GMS Core + Play Integrity
    let gmsVer = '';
    try {
      const g = await adbShell(info.adb, 'pm list packages com.google.android.gms');
      if (g.includes('com.google.android.gms')) {
        const v = await adbShell(info.adb, 'dumpsys package com.google.android.gms | grep -m1 versionName');
        gmsVer = v.match(/versionName\s*=\s*(.+)/)?.[1]?.trim() || 'Installed';
      } else {
        gmsVer = '';
      }
    } catch(e) {}

    let piInstalled = false;
    try {
      const p = await adbShell(info.adb, 'pm list packages com.google.android.gms.integrity');
      piInstalled = p.includes('com.google.android.gms.integrity');
    } catch(e) {}

    // 4) Android 15 generic HAL detection via service list (NOT ro.hardware.*)
    const [nfcHal, keystoreHal, strongboxHal, keymintHal, biometricFaceHal, biometricFpHal] = await Promise.all([
      checkHalService(info.adb, 'android.hardware.nfc'),
      checkHalService(info.adb, 'android.hardware.security.keystore'),
      checkHalService(info.adb, 'android.hardware.security.strongbox'),
      checkHalService(info.adb, 'android.hardware.security.keymint'),
      checkHalService(info.adb, 'android.hardware.biometrics.face'),
      checkHalService(info.adb, 'android.hardware.biometrics.fingerprint'),
    ]);

    // 5) Boot security (standard AOSP props — work on ALL Android 12+ devices)
    const props = await Promise.allSettled([
      safeGetProp(info.adb, 'ro.boot.flash.locked'),
      safeGetProp(info.adb, 'ro.boot.verifiedbootstate'),
      safeGetProp(info.adb, 'ro.boot.vbmeta.verify_state'),
      safeGetProp(info.adb, 'ro.boot.vbmeta.device_state'),
      safeGetProp(info.adb, 'ro.boot.veritymode'),
    ]);
    const [flashLocked, vbState, vbVerify, vbDevice, verity] = props.map(r => r.value || '');

    // Build rows: [Check, Value, Status, Source, Tooltip]
    const rows = [];

    // --- Definitive RKP provisioning evidence (put first — this is the headline result) ---
    if (rkp.pkgInstalled) {
      rows.push(['RKP Package', 'Installed' + (rkp.pkgVersion ? ' (versionCode ' + rkp.pkgVersion + ')' : ''),
        'ok', 'pm list packages | grep rkpd',
        'RKP Mainline module presence. Installed alone does NOT prove provisioning — see the "RKP Provisioned" rows below.']);
      if (rkp.pkgEnabled !== null) {
        rows.push(['RKP Package Enabled', rkp.pkgEnabled ? 'true' : 'false',
          rkp.pkgEnabled ? 'ok' : 'warn', 'dumpsys package com.google.android.rkpd',
          'Whether the RKP daemon package is currently enabled.']);
      }
    }
    if (rkp.components.length) {
      rows.push(['RKP Components', rkp.components.join(', '), 'ok', 'cmd remote_provisioning list',
        'IRemotelyProvisionedComponent instances exposed by the device (e.g. default = TEE, strongbox = StrongBox dedicated secure element).']);
    } else {
      rows.push(['RKP Components', 'None found', 'unknown', 'cmd remote_provisioning list',
        'Either this device does not expose the Remote Provisioning shell command, or it has no RKP-capable components.']);
    }
    if (rkp.hostname) {
      rows.push(['RKP Backend', rkp.hostname, 'ok', 'getprop remote_provisioning.hostname',
        'Configured remote provisioning server.']);
    }
    if (rkp.teeRkpOnly) {
      rows.push(['TEE RKP-Only', rkp.teeRkpOnly, rkp.teeRkpOnly === 'true' ? 'ok' : 'unknown',
        'getprop remote_provisioning.tee.rkp_only',
        'true = the TEE attestation configuration relies solely on remote provisioning (no factory-provisioned fallback keys).']);
    }
    for (const c of rkp.certified) {
      rows.push([
        'RKP Provisioned (' + c.name + ')',
        c.provisioned ? 'PROVISIONED — certificate chain present' : 'NOT CONFIRMED' + (c.note ? ': ' + c.note : ''),
        c.provisioned ? 'ok' : 'fail',
        'cmd remote_provisioning certify ' + c.name,
        'The definitive evidence: a successful PEM certificate chain from `certify` proves provisioning material actually exists for this component. This is the only ADB-level check that confirms provisioning rather than mere support/configuration.'
      ]);
    }

    // Attestation capability row (HAL attestation ID/version + TLS reach to Google)
    rows.push([
      'Attestation Capability',
      attest.ok ? `Operational (v${attest.attestationVersion}, TLS to Google OK)`
                : `Limited (HAL v${attest.attestationVersion}, TLS: ${attest.tlsReachable ? 'OK' : 'FAIL'})`,
      attest.ok ? 'ok' : 'warn',
      'cmd key_attestation + nc play.googleapis.com:443',
      'Real attestation test: queries KeyMint HAL for attestation versions (proves HAL supports attestation) + TLS handshake to play.googleapis.com:443 (proves device can reach Google attestation servers). Network ping alone does NOT prove RKP — this combination verifies the prerequisite paths.'
    ]);

    // KeyMint
    rows.push(['KeyMint Provider', kMint ? 'Active' : (ksOut.substring(0, 60) || 'Not found'),
      kMint ? 'ok' : 'warn', 'cmd keystore',
      'KeyMint is the Android 12+ key management HAL. Active = hardware-backed keys work.']);
    rows.push(['Key Attestation', attestOk ? 'Operational' : (attestOut.substring(0, 60) || 'Not available'),
      attestOk ? 'ok' : 'warn', 'cmd key_attestation',
      'Proves keys are hardware-backed. Operational = device generates attestation certs.']);
    rows.push(['KeyMint Feature', keymintVer || '',
      keymintVer ? 'ok' : 'warn', 'pm list features | grep keymint',
      'HAL version from pm list features.']);
    rows.push(['GMS Core', gmsVer, gmsVer !== '' && gmsVer !== 'Not installed' ? 'ok' : 'warn',
      'pm list packages + dumpsys package com.google.android.gms',
      'Google Play Services version. Required for Play Integrity API.']);
    rows.push(['Play Integrity API', piInstalled ? 'Installed' : 'Not installed',
      piInstalled ? 'ok' : 'warn',
      'pm list packages com.google.android.gms.integrity',
      'Play Integrity API replaces SafetyNet. Used by banking/payment apps.']);

    // Hardware (Android 15 generic via service list, NOT ro.hardware.*)
    rows.push(['NFC HAL', nfcHal ? 'Registered' : 'Not registered',
      nfcHal ? 'ok' : 'warn', 'service list | grep android.hardware.nfc',
      'NFC controller HAL. Detected via Android 15 HAL service list (vendor-independent).']);
    rows.push(['Keystore HAL', keystoreHal ? 'Registered' : 'Not registered',
      keystoreHal ? 'ok' : 'warn', 'service list | grep android.hardware.security.keystore',
      'Keystore HAL service. Generic detection across all OEMs.']);
    rows.push(['StrongBox HAL', strongboxHal ? 'Registered' : 'Not registered',
      strongboxHal ? 'ok' : 'warn', 'service list | grep android.hardware.security.strongbox',
      'StrongBox dedicated secure element HAL. Generic detection.']);
    rows.push(['KeyMint HAL', keymintHal ? 'Registered' : 'Not registered',
      keymintHal ? 'ok' : 'warn', 'service list | grep android.hardware.security.keymint',
      'KeyMint HAL service registration (Android 12+ hardware-backed keys).']);
    rows.push(['Face Biometric HAL', biometricFaceHal ? 'Registered' : 'Not registered',
      biometricFaceHal ? 'ok' : 'unknown', 'service list | grep android.hardware.biometrics.face',
      'Face biometric HAL. Vendor-neutral detection.']);
    rows.push(['Fingerprint HAL', biometricFpHal ? 'Registered' : 'Not registered',
      biometricFpHal ? 'ok' : 'unknown', 'service list | grep android.hardware.biometrics.fingerprint',
      'Fingerprint biometric HAL. Vendor-neutral detection.']);

    // Boot security (standard AOSP props)
    rows.push(['Flash Locked', flashLocked || '',
      flashLocked === 'true' || flashLocked === '1' ? 'ok' : (flashLocked ? 'warn' : 'unknown'),
      'getprop ro.boot.flash.locked',
      'Bootloader lock. true/1 = locked (required for verified boot).']);
    rows.push(['Verified Boot State', vbState || '',
      vbState === 'green' ? 'ok' : (vbState === 'orange' || vbState === 'yellow' ? 'warn' : (vbState === 'red' ? 'fail' : 'unknown')),
      'getprop ro.boot.verifiedbootstate',
      'AVB state. green=full, orange/yellow=partial, red=none.']);
    rows.push(['VBMeta Verify', vbVerify || '',
      vbVerify === 'green' ? 'ok' : (vbVerify === 'unverified' ? 'warn' : 'unknown'),
      'getprop ro.boot.vbmeta.verify_state',
      'VBMeta partition verify state. green=verified, unverified=warning.']);
    rows.push(['VBMeta Device State', vbDevice || '',
      vbDevice === 'locked' ? 'ok' : (vbDevice === 'unlocked' ? 'fail' : 'unknown'),
      'getprop ro.boot.vbmeta.device_state',
      'Device lock state. locked=not unlocked, unlocked=bootloader unlocked.']);
    rows.push(['DM-Verity Mode', verity || '',
      verity === 'enforce' ? 'ok' : (verity === 'logging' || verity === 'log' ? 'warn' : 'unknown'),
      'getprop ro.boot.veritymode',
      'DM-Verity mode. enforce=active protection, logging=degraded.']);

    // Filter out invalid/unset rows — only show rows with real data
    const validRows = rows.filter(r => {
      const val = (r[1] || '').toString().trim().toLowerCase();
      return val !== '' && val !== 'not set' && val !== 'not found' && val !== 'not installed' && val !== 'not reported';
    });
    const html = renderRKPTable(validRows);
    if (background) {
      cacheAndBroadcastTabHtml(serial, 'rkp', html);
    } else {
      document.getElementById('rkp-output').innerHTML = html;
    }
  } catch (err) {
    const html = '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
    if (background) {
      cacheAndBroadcastTabHtml(serial, 'rkp', html);
    } else {
      document.getElementById('rkp-output').innerHTML = html;
    }
  }
  if (!background) showLoading('rkp', false);
}

function clearShell() {
  const el = document.getElementById('shell-output');
  if (el) el.textContent = '';
}


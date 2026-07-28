// Web ADB Inspector - Pure WebUSB, runs entirely in browser
const APP_VERSION = '1.0.6';
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

// --- Global State ---
const credentialStore = new AdbWebCredentialStore('web-adb-inspector');
const connectedDevices = new Map();
let activeSerial = null;
const dataCache = { props: [], features: [], packages: [] };
const deviceNicknames = (() => { try { return JSON.parse(localStorage.getItem('device-nicknames') || '{}'); } catch { return {}; } })();
let fontSizeLevel = (() => { try { return parseInt(localStorage.getItem('font-size-level') || '0', 10); } catch { return 0; } })();

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
  credentialStore.iterateKeys().catch(() => credentialStore.generateKey());
  applyFontSize();
  // Show version in header
  const verEl = document.getElementById('header-version');
  if (verEl) verEl.textContent = 'v' + APP_VERSION;
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

function getOS() {
  const u = navigator.userAgent;
  if (/Windows/.test(u)) return 'windows';
  if (/Mac/.test(u)) return 'mac';
  if (/Linux/.test(u)) return 'linux';
  return 'unknown';
}

function showADBReleaseDialog() {
  const os = getOS();
  let t, b;
  if (os === 'windows') { t = 'Release ADB on Windows'; b = '1. Open Command Prompt\n2. Run: adb kill-server\n3. Or: taskkill /F /IM adb.exe\n4. Refresh page'; }
  else if (os === 'mac') { t = 'Release ADB on macOS'; b = '1. Terminal: adb kill-server\n2. If stuck: pkill -f adb'; }
  else { t = 'Release ADB on Linux'; b = 'echo "BUS-DEV" | sudo tee /sys/bus/usb/drivers/android_usb/unbind'; }
  alert(t + '\n\n' + b);
}

// --- Device Discovery ---
async function scanDevices() {
  const mgr = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!mgr) return;
  try {
    const device = await mgr.requestDevice({ filters: [AdbDefaultInterfaceFilter] });
    if (!device) return;
    await connectDevice(device);
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes('already in use')) showADBReleaseDialog();
    else alert('Failed: ' + msg);
  }
}

async function connectDevice(usbDevice) {
  try {
    setStatus('Connecting...', 'connecting');
    const connection = await usbDevice.connect();
    const transport = await AdbDaemonTransport.authenticate({
      serial: usbDevice.serial || 'usb', connection, credentialStore,
      features: ADB_DAEMON_DEFAULT_FEATURES,
      initialDelayedAckBytes: ADB_DAEMON_DEFAULT_INITIAL_PAYLOAD_SIZE,
    });
    const adb = new Adb(transport);
    let displayName = usbDevice.name || 'Android Device';
    try {
      const model = await adb.getProp('ro.product.model');
      const brand = await adb.getProp('ro.product.brand');
      displayName = brand + ' ' + model;
    } catch (_) {}
    connectedDevices.set(adb.serial, { adb, usbDevice, transport, _displayName: displayName });
    renderDeviceList();
    if (connectedDevices.size === 1) selectDevice(adb.serial);
    setStatus('Connected', 'ok');
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes('already in use')) showADBReleaseDialog();
    setStatus('Failed: ' + msg, 'err');
  }
}

// --- Shell ---
async function adbShell(adb, cmd) {
  const sp = adb.subprocess.shellProtocol;
  if (sp && sp.isSupported) return (await sp.spawnWaitText(cmd)).stdout;
  throw new Error('Shell protocol not supported');
}

// --- ADB Sync: read large files from device ---
async function readDeviceFile(adb, path) {
  const stream = adb.syncProtocol.recv(path);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buf = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return new TextDecoder().decode(buf);
}

// --- UI ---
function renderDeviceList() {
  const list = document.getElementById('device-list');
  const welcome = document.getElementById('welcome-msg');
  if (connectedDevices.size === 0) { list.classList.add('hidden'); welcome.classList.remove('hidden'); return; }
  welcome.classList.add('hidden'); list.classList.remove('hidden'); list.innerHTML = '';
  for (const [serial, info] of connectedDevices) {
    const nick = deviceNicknames[serial] || '';
    const card = document.createElement('div');
    card.className = 'device-card' + (activeSerial === serial ? ' active' : '');
    card.innerHTML = `<div>
      ${nick ? '<div class="dev-nick">' + esc(nick) + '</div>' : ''}
      <div class="dev-name">${esc(info._displayName || serial)}</div>
      <div class="dev-serial">${esc(serial)}</div>
    </div><span class="dev-status" style="color:var(--green)">Connected</span>`;
    card.onclick = () => selectDevice(serial);
    list.appendChild(card);
  }
}

function selectDevice(serial) {
  const info = connectedDevices.get(serial);
  if (!info) return;
  activeSerial = serial;
  document.getElementById('inspector-section').classList.remove('hidden');
  const nick = deviceNicknames[serial] || '';
  document.getElementById('selected-device-name').textContent =
    (info._displayName || serial) + (nick ? ' ("' + nick + '")' : '') + ' (' + serial + ')';
  renderDeviceList();
  document.getElementById('shell-output').textContent = '';
  document.getElementById('search-props').value = '';
  document.getElementById('search-features').value = '';
  document.getElementById('search-packages').value = '';
  fetchProperties();
  fetchFeatures();
  fetchPackages();
  fetchAttestation();
  fetchRKP();
}

async function disconnectDevice() {
  if (!activeSerial) return;
  const info = connectedDevices.get(activeSerial);
  if (info) { try { await info.transport.close(); } catch(e) {} try { await info.usbDevice.close(); } catch(e) {} }
  connectedDevices.delete(activeSerial);
  activeSerial = null;
  document.getElementById('inspector-section').classList.add('hidden');
  renderDeviceList();
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

async function fetchProperties() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;
  showLoading('props', true);
  try {
    const text = await adbShell(info.adb, 'getprop');
    const props = [];
    const re = /\[(ro[.\w]+)\]:\s*\[([^\]]*)\]/g;
    let m;
    while ((m = re.exec(text)) !== null) props.push({ name: m[1], value: m[2] });
    dataCache.props = props;
    document.getElementById('props-count').textContent = '(' + props.length + ')';
    renderProperties(props);
  } catch (err) {
    document.getElementById('props-output').innerHTML = '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('props', false);
}

function renderProperties(props) {
  const q = (document.getElementById('search-props')?.value || '').toLowerCase();
  const filtered = q ? props.filter(p => p.name.toLowerCase().includes(q) || p.value.toLowerCase().includes(q)) : props;
  document.getElementById('props-output').innerHTML =
    filtered.map(p => '<div class="prop-row"><span class="prop-key">' + esc(p.name) + '</span><span class="prop-val">' + esc(p.value) + '</span></div>').join('') ||
    (q ? '<div class="empty-hint">No matching properties</div>' : '');
}

async function fetchFeatures() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;
  showLoading('features', true);
  try {
    const text = await adbShell(info.adb, 'pm list features');
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
    dataCache.features = features;
    document.getElementById('features-count').textContent = '(' + features.length + ')';
    renderFeatures(features);
  } catch (err) {
    document.getElementById('features-output').innerHTML = '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('features', false);
}

function renderFeatures(features) {
  const q = (document.getElementById('search-features')?.value || '').toLowerCase();
  const filtered = q ? features.filter(f => f.name.toLowerCase().includes(q)) : features;
  document.getElementById('features-output').innerHTML =
    filtered.map(f => {
      const tb = f.type === 'sdk' ? '<span class="feat-type">sdk</span>' : '<span class="feat-type other">other</span>';
      const vs = f.version > 0 ? ' v' + f.version : '';
      return '<div class="feat-item">' + tb + ' ' + esc(f.name) + '<span class="feat-ver">' + vs + '</span></div>';
    }).join('') || (q ? '<div class="empty-hint">No matching features</div>' : '');
}

// --- Packages: dumpsys via temp file + sync protocol ---
async function fetchPackages() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;
  showLoading('packages', true);
  const tmpPath = '/data/local/tmp/webadb_dumpsys.txt';
  let method = 'fallback';
  try {
    await adbShell(info.adb, 'dumpsys package > ' + tmpPath + ' 2>&1');
    const text = await readDeviceFile(info.adb, tmpPath);
    try { await adbShell(info.adb, 'rm -f ' + tmpPath); } catch(e) {}
    const packages = parseDumpsysPackage(text);
    document.getElementById('packages-count').textContent = '(' + packages.length + ')';
    if (packages.length > 0) {
      dataCache.packages = packages;
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

function renderPackages(packages, fallback, method) {
  const q = (document.getElementById('search-packages')?.value || '').toLowerCase();
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
    // Always allow expansion if package has any detail-worthy data.
    // Previously: only expanded if version_name OR permissions present —
    // but if version_name failed to parse, the user couldn't see permissions.
    const hasDetail = true;
    return '<div class="pkg-item" data-pkg-idx="' + realIdx + '" onclick="togglePkgDetail(' + realIdx + ')">' +
      esc(p.name) + ' <span class="pkg-ver">' + verStr + '</span> ' + badges +
      ' <span class="pkg-toggle">[+]</span></div>' +
      '<div id="pkg-d-' + realIdx + '" class="pkg-detail hidden">' + renderPackageDetail(p) + '</div>';
  }).join('');

  document.getElementById('packages-output').innerHTML = html;
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
      const g = pm.is_granted !== undefined ? (pm.is_granted ? '✓' : '✗') : '';
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
function parseDumpsysPackage(text) {
  const packages = [];
  const allLines = text.split('\n');

  let current = null;
  let section = null; // null, 'requested', 'declared', 'certs'
  let currentPerm = null;

  for (let i = 0; i < allLines.length; i++) {
    const rawLine = allLines[i];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('-----')) continue;

    // Package header: CRITICAL - use trimmed, not rawLine
    // "  Package [com.example.name]:" or "  Package [com.example.name] (12345):"
    const pkgMatch = trimmed.match(/^Package\s+\[([^\]]+)\]/);
    if (pkgMatch) {
      if (current) packages.push(finalize(current));
      current = {
        name: pkgMatch[1], version_name: '', version_code: 0,
        dir: '', system: false, system_priv: false,
        min_sdk: 0, target_sdk: 0, uid: 0,
        sha256_cert: '', sha256_file: '',
        requested_permissions: [], defined_permissions: [],
      };
      section = null;
      currentPerm = null;
      continue;
    }

    if (!current) continue;

    // ---- Section detection (case insensitive) ----
    const lower = trimmed.toLowerCase().replace(/\s*:\s*$/, '');
    if (lower === 'requested permissions') {
      finalizePerm(); section = 'requested'; currentPerm = null; continue;
    }
    if (lower === 'declared permissions') {
      finalizePerm(); section = 'declared'; currentPerm = null; continue;
    }
    if (lower === 'primarycerts' || lower === 'certs') {
      finalizePerm(); section = 'certs'; currentPerm = null; continue;
    }

    // ---- Inside certs section ----
    if (section === 'certs') {
      // "  0: AB:CD:EF:..." or "  0: ABCDEF0123..." or "  0: SHA256=ABC..."
      const certColon = trimmed.match(/^\d+\s*:\s+([0-9A-Fa-f:]{16,})$/);
      const certRaw = trimmed.match(/^\d+\s*:\s+([0-9A-Fa-f]{40,})$/);
      const certSha = trimmed.match(/^\d+\s*:\s+SHA256\s*=\s*([0-9A-Fa-f:]{16,})$/);
      if (certSha) {
        current.sha256_cert = certSha[1].toUpperCase().replace(/:/g, '');
        continue;
      }
      if (certColon || certRaw) {
        current.sha256_cert = (certColon || certRaw)[1].toUpperCase().replace(/:/g, '');
        continue;
      }
      // No cert match - end of certs section
      section = null;
    }

    // ---- Inside permissions section ----
    if (section === 'requested' || section === 'declared') {
      // dumpsys format for permissions is EITHER:
      // Format A (newer):
      //   android.permission.X
      //   granted=true
      //   android.permission.Y
      //   granted=false
      // Format B (older, with full details):
      //   Permission: android.permission.X
      //     uid=1000 gids=...
      //     name=android.permission.X
      //     flags=0x40000000
      //     type=1
      //     protectionLevel=signature|privileged
      //     protectionLevelFlags=0x00400000

      // Check for "Permission:" block format
      const permBlock = trimmed.match(/^Permission:\s*(.+)$/);
      if (permBlock) {
        finalizePerm();
        currentPerm = {
          name: permBlock[1].trim(), is_granted: undefined, flags: 0,
          permission_group: '', protection_level: 0,
          protection_level_flags: 0, type: 1, maxTargetSdk: 0,
        };
        continue;
      }

      // Check for attribute lines (granted=, flags=, etc.)
      // CRITICAL: only match ATTRIBUTE-level keywords that are unambiguous
      // (NOT 'name' — versionName= would false-positive; NOT 'uid' — userId= would)
      const isPermAttr = trimmed.match(/^(granted|flags|protectionLevel|protection_level|protection_level_flags|type|group|maxTargetSdk|label)\s*=/);
      if (currentPerm && isPermAttr) {
        const kvPairs = trimmed.match(/(\w+)\s*=\s*([^\s,]+)/g);
        if (kvPairs) {
          for (const pair of kvPairs) {
            const eqIdx = pair.indexOf('=');
            const key = pair.substring(0, eqIdx).trim();
            const val = pair.substring(eqIdx + 1).trim();
            assignPermAttr(currentPerm, key, val);
          }
        }
        continue;
      }

      // Check for bare permission name (Format A)
      const isBarePerm = trimmed.match(/^(android\.permission\.|com\.|org\.)/);
      // But NOT if it's something like "sharedLibrary=false"
      if (isBarePerm && !trimmed.includes('=')) {
        finalizePerm();
        currentPerm = {
          name: trimmed, is_granted: undefined, flags: 0,
          permission_group: '', protection_level: 0,
          protection_level_flags: 0, type: 1,
        };
        continue;
      }

      // Check if line looks like it's outside permissions.
      // CRITICAL: Android 14 permissions section can end without a clear
      // indent transition (the indentation varies). Use KNOWN package-level
      // keys as a section terminator instead of relying on indent depth.
      const looksLikePackageField = trimmed.match(/^(versionName|versionCode|codePath|base|resourcePath|minSdk|minSdkVersion|targetSdk|targetSdkVersion|userId|uid|package|splitName|splitRevisionCode|primaryCertsRevision|isPrivApp|privateFlags|nativeLibraryDir|primaryCpuAbi|secondaryCpuAbi)\s*=/);
      if (looksLikePackageField) {
        finalizePerm();
        section = null;
        // Fall through to package-level parsing below
      } else {
        // Still inside permissions — could be a bare continuation line we
        // don't recognize. Skip rather than corrupting currentPerm.
        continue;
      }
    }

    // ---- Package-level field parsing ----
    // CRITICAL: Android 14 packs multiple KV on one line
    // Values can contain spaces/parens: versionName=4.3.3.26 (48e035de9de)
    // Strategy: find all key= positions, each value extends to next key= or end of line
    const kvRe = /(\w+)\s*=/g;
    let kvMatch;
    const kvList = [];
    while ((kvMatch = kvRe.exec(trimmed)) !== null) {
      kvList.push({ key: kvMatch[1], valStart: kvMatch.index + kvMatch[0].length, index: kvMatch.index });
    }
    if (kvList.length > 0) {
      for (let k = 0; k < kvList.length; k++) {
        const key = kvList[k].key;
        const valEnd = (k + 1 < kvList.length) ? kvList[k + 1].index : trimmed.length;
        let val = trimmed.substring(kvList[k].valStart, valEnd).trim().replace(/^"|"$/g, '');
        assignPkgField(current, key, val);
      }
      continue;
    }
  }

  if (current) packages.push(finalize(current));
  return packages;

  // --- Helpers for multi-KV parsing ---
  function assignPermAttr(p, key, val) {
    switch (key) {
      case 'granted': p.is_granted = val === 'true'; break;
      case 'flags':
        p.flags = (val.startsWith('0x') || val.startsWith('0X')) ? parseInt(val, 16) || 0 : parseInt(val, 10) || 0;
        break;
      case 'protectionLevel': case 'protection_level': {
        const map = {'signature|privileged':2,'privileged|signature':2,signature:2,dangerous:1,normal:0,privileged:2};
        p.protection_level = map[val] !== undefined ? map[val] : (parseInt(val, 10) || 0);
        break;
      }
      case 'protection_level_flags': p.protection_level_flags = parseInt(val, 10) || 0; break;
      case 'type': p.type = parseInt(val, 10) || 1; break;
      case 'group': p.permission_group = val; break;
      case 'maxTargetSdk': p.maxTargetSdk = parseInt(val, 10) || 0; break;
    }
  }

  function assignPkgField(pkg, key, val) {
    switch (key) {
      case 'versionName': pkg.version_name = val; break;
      case 'versionCode':
        // "123", "123 (123)", "0x123" → just the number
        pkg.version_code = parseInt(val, 10) || 0;
        break;
      case 'codePath': case 'base':
        pkg.dir = val;
        pkg.system = ['/system/','/product/','/vendor/','/apex/','/oem/','/data/app/'].some(p => val.startsWith(p));
        pkg.system_priv = ['/system/priv-app/','/product/priv-app/','/vendor/priv-app/'].some(p => val.startsWith(p));
        break;
      case 'resourcePath': break;
      case 'minSdk': case 'minSdkVersion': pkg.min_sdk = parseInt(val, 10) || 0; break;
      case 'targetSdk': case 'targetSdkVersion': pkg.target_sdk = parseInt(val, 10) || 0; break;
      case 'userId': case 'uid': {
        const m = val.match(/(\d+)/);
        pkg.uid = m ? parseInt(m[1], 10) : 0;
        break;
      }
      case 'package': case 'splitName': case 'splitRevisionCode': case 'primaryCertsRevision':
      case 'isPrivApp': case 'privateFlags': break; // skip
    }
  }

  function finalizePerm() {
    if (currentPerm) {
      if (section === 'requested') current.requested_permissions.push(currentPerm);
      else if (section === 'declared') current.defined_permissions.push(currentPerm);
      currentPerm = null;
    }
  }

  function finalize(pkg) {
    finalizePerm();
    const system_uids = [0, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010];
    return {
      name: pkg.name,
      version_name: pkg.version_name || '',
      dir: pkg.dir || '',
      system_priv: pkg.system_priv,
      min_sdk: pkg.min_sdk || 0,
      target_sdk: pkg.target_sdk || 0,
      has_system_uid: system_uids.includes(pkg.uid),
      shares_install_packages_permission: false, // checked from permissions if needed
      uid: pkg.uid || 0,
      has_default_notification_access: false,
      is_active_admin: false,
      is_default_accessibility_service: false,
      sha256_cert: pkg.sha256_cert || '',
      sha256_file: pkg.sha256_file || '',
      requested_permissions: pkg.requested_permissions.map(p => ({
        name: p.name || '',
        flags: p.flags || 0,
        permission_group: p.permission_group || '',
        protection_level: p.protection_level || 0,
        protection_level_flags: p.protection_level_flags || 0,
        type: p.type || 1,
        is_granted: p.is_granted !== undefined ? p.is_granted : true,
      })),
      defined_permissions: pkg.defined_permissions.map(p => ({
        name: p.name || '',
        flags: p.flags || 0,
        permission_group: p.permission_group || '',
        protection_level: p.protection_level || 0,
        protection_level_flags: p.protection_level_flags || 0,
        type: p.type || 1,
      })),
    };
  }
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
async function fetchAttestation() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;
  showLoading('attestation', true);
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
    document.getElementById('attestation-output').innerHTML = renderStatusTable(rows);
  } catch (err) {
    document.getElementById('attestation-output').innerHTML = '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('attestation', false);
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

// RKP: test actual Google server reachability from the device.
// play.googleapis.com is the Play Integrity / attestation endpoint.
async function checkGoogleConnectivity(adb) {
  try {
    const out = await adbShell(adb,
      'ping -c 1 -W 2 play.googleapis.com 2>&1; echo "PING_EXIT:$?"');
    const exitMatch = out.match(/PING_EXIT:(\d+)/);
    const exitCode = exitMatch ? exitMatch[1] : '1';
    // PASS: 0 received OR >=1 bytes from
    const received = out.match(/(\d+)\s+received/);
    const ok = exitCode === '0' && (!received || parseInt(received[1], 10) > 0)
      && /bytes from/.test(out);
    return { ok, exitCode, raw: out.trim().split('\n').slice(0, 3).join(' | ') };
  } catch(e) {
    return { ok: false, exitCode: 'ERR', raw: String(e.message || e) };
  }
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
async function runShell() {
  const input = document.getElementById('shell-input');
  const output = document.getElementById('shell-output');
  const cmd = input.value.trim();
  if (!cmd || !activeSerial) return;
  const info = connectedDevices.get(activeSerial);
  if (!info) return;
  input.value = '';
  output.textContent += '$ ' + cmd + '\n';
  try { output.textContent += (await adbShell(info.adb, cmd)) + '\n'; }
  catch (err) { output.textContent += 'Error: ' + String(err.message || err) + '\n'; }
  output.scrollTop = output.scrollHeight;
}
function runCmd(cmd) { document.getElementById('shell-input').value = cmd; runShell(); }

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

    json = { package: dataCache.packages.map(p => ({
      name: p.name,
      version_name: p.version_name || '',
      dir: p.dir || '',
      system_priv: p.system_priv,
      min_sdk: p.min_sdk || 0,
      target_sdk: p.target_sdk || 0,
      has_system_uid: p.has_system_uid || false,
      shares_install_packages_permission: p.shares_install_packages_permission || false,
      uid: p.uid || 0,
      has_default_notification_access: p.has_default_notification_access || false,
      is_active_admin: p.is_active_admin || false,
      is_default_accessibility_service: p.is_default_accessibility_service || false,
      sha256_cert: formatCert(p.sha256_cert),
      sha256_file: (p.sha256_file || '').toLowerCase(),
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
    }))};
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
window.scanDevices = scanDevices;
window.disconnectDevice = disconnectDevice;
window.switchTab = switchTab;
window.runShell = runShell;
window.runCmd = runCmd;
window.copyPanel = copyPanel;
window.showADBReleaseDialog = showADBReleaseDialog;
window.exportJSON = exportJSON;
window.togglePkgDetail = togglePkgDetail;
window.setNickname = setNickname;
window.changeFontSize = changeFontSize;
window.renderProperties = renderProperties;
window.renderFeatures = renderFeatures;
window.renderPackages = renderPackages;

// --- RKP: Google-connectivity + Android 15 generic HAL-based checks ---
async function fetchRKP() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;
  showLoading('rkp', true);
  try {
    // 1) Google server connectivity (replaces vendor ro.hardware.* / ro.vendor.* checks)
    const ping = await checkGoogleConnectivity(info.adb);

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
    let gmsVer = 'Not installed';
    try {
      const g = await adbShell(info.adb, 'pm list packages com.google.android.gms');
      if (g.includes('com.google.android.gms')) {
        const v = await adbShell(info.adb, 'dumpsys package com.google.android.gms | grep -m1 versionName');
        gmsVer = v.match(/versionName\s*=\s*(.+)/)?.[1]?.trim() || 'Installed';
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
      safeGetProp(info.adb, 'ro.boot.warranty_bit'),
      safeGetProp(info.adb, 'ro.warranty.void'),
    ]);
    const [flashLocked, vbState, vbVerify, vbDevice, verity, wBit, wVoid] = props.map(r => r.value || '');

    // Build rows: [Check, Value, Status, Source, Tooltip]
    const rows = [];

    // Connectivity
    rows.push([
      'Google Connectivity',
      ping.ok ? 'Reachable (play.googleapis.com)' : 'Unreachable',
      ping.ok ? 'ok' : 'fail',
      'ping -c 1 -W 2 play.googleapis.com',
      'Tests actual Google server reachability from the device. play.googleapis.com is the Play Integrity / attestation endpoint. RKP attestation flow requires this network path.'
    ]);

    // KeyMint
    rows.push(['KeyMint Provider', kMint ? 'Active' : (ksOut.substring(0, 60) || 'Not found'),
      kMint ? 'ok' : 'warn', 'cmd keystore',
      'KeyMint is the Android 12+ key management HAL. Active = hardware-backed keys work.']);
    rows.push(['Key Attestation', attestOk ? 'Operational' : (attestOut.substring(0, 60) || 'Not available'),
      attestOk ? 'ok' : 'warn', 'cmd key_attestation',
      'Proves keys are hardware-backed. Operational = device generates attestation certs.']);
    rows.push(['KeyMint Feature', keymintVer || 'Not reported',
      keymintVer ? 'ok' : 'warn', 'pm list features | grep keymint',
      'HAL version from pm list features.']);
    rows.push(['GMS Core', gmsVer, gmsVer !== 'Not installed' ? 'ok' : 'warn',
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
    rows.push(['Flash Locked', flashLocked || 'Not set',
      flashLocked === 'true' || flashLocked === '1' ? 'ok' : (flashLocked ? 'warn' : 'unknown'),
      'getprop ro.boot.flash.locked',
      'Bootloader lock. true/1 = locked (required for verified boot).']);
    rows.push(['Verified Boot State', vbState || 'Not set',
      vbState === 'green' ? 'ok' : (vbState === 'orange' || vbState === 'yellow' ? 'warn' : (vbState === 'red' ? 'fail' : 'unknown')),
      'getprop ro.boot.verifiedbootstate',
      'AVB state. green=full, orange/yellow=partial, red=none.']);
    rows.push(['VBMeta Verify', vbVerify || 'Not set',
      vbVerify === 'green' ? 'ok' : (vbVerify === 'unverified' ? 'warn' : 'unknown'),
      'getprop ro.boot.vbmeta.verify_state',
      'VBMeta partition verify state. green=verified, unverified=warning.']);
    rows.push(['VBMeta Device State', vbDevice || 'Not set',
      vbDevice === 'locked' ? 'ok' : (vbDevice === 'unlocked' ? 'fail' : 'unknown'),
      'getprop ro.boot.vbmeta.device_state',
      'Device lock state. locked=not unlocked, unlocked=bootloader unlocked.']);
    rows.push(['DM-Verity Mode', verity || 'Not set',
      verity === 'enforce' ? 'ok' : (verity === 'logging' || verity === 'log' ? 'warn' : 'unknown'),
      'getprop ro.boot.veritymode',
      'DM-Verity mode. enforce=active protection, logging=degraded.']);
    rows.push(['Warranty Bit (boot)', wBit === '1' ? 'VOID' : (wBit || 'Not set'),
      wBit === '1' ? 'fail' : 'ok', 'getprop ro.boot.warranty_bit',
      'Bootloader warranty void bit. 1=bootloader unlocked, void warranty.']);
    rows.push(['Warranty Void (user)', wVoid === '1' ? 'VOID' : (wVoid || 'Not set'),
      wVoid === '1' ? 'fail' : 'ok', 'getprop ro.warranty.void',
      'User-space warranty void indicator set by OEM on unlock.']);

    document.getElementById('rkp-output').innerHTML = renderRKPTable(rows);
  } catch (err) {
    document.getElementById('rkp-output').innerHTML = '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('rkp', false);
}

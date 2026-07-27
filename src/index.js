// Web ADB Inspector - Pure WebUSB, runs entirely in browser
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
document.addEventListener('DOMContentLoaded', () => {
  checkWebUSB();
  credentialStore.iterateKeys().catch(() => credentialStore.generateKey());
  applyFontSize();
});

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
  try {
    const tmpPath = '/data/local/tmp/webadb_dumpsys.txt';
    await adbShell(info.adb, 'dumpsys package > ' + tmpPath + ' 2>&1');
    const text = await readDeviceFile(info.adb, tmpPath);
    try { await adbShell(info.adb, 'rm -f ' + tmpPath); } catch(e) {}
    const packages = parseDumpsysPackage(text);
    dataCache.packages = packages;
    renderPackages(packages);
  } catch (err) {
    console.warn('dumpsys+sync failed, falling back:', err);
    try {
      const text = await adbShell(info.adb, 'pm list packages -f -u');
      const packages = parsePmListPackagesFallback(text);
      dataCache.packages = packages;
      renderPackages(packages, true);
    } catch (e2) {
      document.getElementById('packages-output').innerHTML = '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
    }
  }
  showLoading('packages', false);
}

function renderPackages(packages, fallback) {
  const q = (document.getElementById('search-packages')?.value || '').toLowerCase();
  const filtered = q ? packages.filter(p => p.name.toLowerCase().includes(q)) : packages;
  const sys = packages.filter(p => p.system).length;
  const priv = packages.filter(p => p.system_priv).length;
  const user = packages.filter(p => !p.system).length;

  let html = '<div class="prop-count">' + packages.length + ' total' +
    (sys ? ' <span style="color:var(--muted)">' + sys + ' sys</span>' : '') +
    (user ? ' <span style="color:var(--green)">' + user + ' user</span>' : '') +
    (priv ? ' <span style="color:var(--orange)">' + priv + ' priv</span>' : '') +
    (fallback ? ' <span style="color:var(--yellow)">[limited data]</span>' : '') +
    (q ? ' <span style="color:var(--accent)">filtered: ' + filtered.length + '</span>' : '') +
    '</div>';

  html += filtered.map((p, idx) => {
    // Find the real index in full array for the detail toggle
    const realIdx = packages.indexOf(p);
    let badges = '';
    if (p.system_priv) badges += '<span class="pkg-badge priv">priv</span> ';
    else if (p.system) badges += '<span class="pkg-badge sys">sys</span> ';
    const verStr = p.version_name ? ' ' + esc(p.version_name) : '';
    const hasDetail = p.version_name || (p.requested_permissions && p.requested_permissions.length > 0);
    return '<div class="pkg-item" onclick="togglePkgDetail(' + realIdx + ')">' +
      esc(p.name) + ' <span class="pkg-ver">' + verStr + '</span> ' + badges +
      (hasDetail ? ' <span class="pkg-toggle">[+]</span>' : '') + '</div>' +
      (hasDetail ? '<div id="pkg-d-' + realIdx + '" class="pkg-detail hidden">' + renderPackageDetail(p) + '</div>' : '');
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
  // Update toggle button in the package row
  const pkgRow = el.previousElementSibling;
  if (pkgRow) {
    const toggle = pkgRow.querySelector('.pkg-toggle');
    if (toggle) toggle.textContent = isHidden ? '[-]' : '[+]';
  }
};

// Parse dumpsys package output - matches actual Android dumpsys format
function parseDumpsysPackage(text) {
  const packages = [];
  const lines = text.split('\n');

  // State tracking
  let current = null;
  let section = null; // null, 'requested', 'declared'
  let currentPerm = null;
  let inCerts = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Package header: "Package [com.example.name]:"
    const pkgMatch = line.match(/^Package\s+\[([^\]]+)\]:\s*$/);
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
      inCerts = false;
      continue;
    }

    if (!current) continue;

    // Section transitions
    if (trimmed === 'Requested permissions:') { finalizePerm(); section = 'requested'; inCerts = false; continue; }
    if (trimmed === 'Declared permissions:') { finalizePerm(); section = 'declared'; inCerts = false; continue; }

    // Certs section: "primaryCerts:" or "certs:["
    if (trimmed === 'primaryCerts:' || trimmed.match(/^certs?[\[:]/)) {
      finalizePerm();
      section = null;
      inCerts = true;
      continue;
    }

    // Parse cert lines inside certs section: "  0: AB:CD:EF:..."
    if (inCerts) {
      const certMatch = trimmed.match(/^\d+:\s+([A-Fa-f0-9:]+)$/);
      if (certMatch && certMatch[1].split(':').length >= 8) {
        current.sha256_cert = certMatch[1].toUpperCase();
        continue;
      }
      // End of certs section
      inCerts = false;
    }

    // Permission name line (indented, starts with android.permission. or com.)
    if (section && line.match(/^\s{2,6}/) && trimmed.match(/^(android\.permission\.|com\.|org\.)/) && !trimmed.match(/^(granted|flags|protectionLevel|type|group|name)\s*=/)) {
      finalizePerm();
      currentPerm = {
        name: trimmed,
        is_granted: undefined,
        flags: 0,
        permission_group: '',
        protection_level: 0,
        protection_level_flags: 0,
        type: 1,
      };
      continue;
    }

    // Permission attributes (more indented)
    if (section && currentPerm && line.match(/^\s{6,10}/)) {
      const attrM = trimmed.match(/^(\w+)\s*=\s*(.+)/);
      if (attrM) {
        const key = attrM[1];
        const val = attrM[2];
        if (key === 'granted') currentPerm.is_granted = val === 'true';
        else if (key === 'flags') {
          // Flags can be hex: 0x40000000 or decimal
          currentPerm.flags = parseInt(val.replace(/^0x/, '').replace(/^0X/, ''), 16) || 0;
        }
        else if (key === 'protectionLevel' || key === 'protection_level') {
          // protectionLevel can be: 0, 1, 2, or "dangerous", "signature", etc.
          const plMap = { 'signature|privileged': 2, 'signature': 2, 'dangerous': 1, 'normal': 0, 'privileged': 2 };
          if (plMap[val]) currentPerm.protection_level = plMap[val];
          else currentPerm.protection_level = parseInt(val, 10) || 0;
        }
        else if (key === 'protection_level_flags') currentPerm.protection_level_flags = parseInt(val, 10) || 0;
        else if (key === 'type') currentPerm.type = parseInt(val, 10) || 1;
        else if (key === 'group') currentPerm.permission_group = val;
      }
      continue;
    }

    // Package field parsing - indented key=value lines
    if (line.match(/^\s{2,4}/) && !section && !inCerts) {
      const kv = trimmed.match(/^(\w+)\s*=\s*(.+)/);
      if (kv) {
        const key = kv[1];
        const val = kv[2];
        switch (key) {
          case 'versionName': current.version_name = val; break;
          case 'versionCode': current.version_code = parseInt(val, 10) || 0; break;
          case 'codePath':
            current.dir = val;
            current.system = ['/system/', '/product/', '/vendor/', '/apex/', '/oem/'].some(p => val.startsWith(p));
            current.system_priv = ['/system/priv-app/', '/product/priv-app/', '/vendor/priv-app/'].some(p => val.startsWith(p));
            break;
          case 'minSdk': current.min_sdk = parseInt(val, 10) || 0; break;
          case 'targetSdk': current.target_sdk = parseInt(val, 10) || 0; break;
          case 'userId':
          case 'uid': current.uid = parseInt(val, 10) || 0; break;
          case 'base': current.dir = val; break;
          case 'apk': current.dir = val; break;
        }
      }
    }
  }

  // Finalize last package
  if (current) packages.push(finalize(current));
  return packages;

  function finalizePerm() {
    if (currentPerm) {
      if (section === 'requested') current.requested_permissions.push(currentPerm);
      else if (section === 'declared') current.defined_permissions.push(currentPerm);
      currentPerm = null;
    }
  }

  function finalize(pkg) {
    finalizePerm();
    // Clean up undefined values
    return {
      name: pkg.name,
      version_name: pkg.version_name || '',
      version_code: pkg.version_code || 0,
      dir: pkg.dir || '',
      system: pkg.system || false,
      system_priv: pkg.system_priv || false,
      min_sdk: pkg.min_sdk || 0,
      target_sdk: pkg.target_sdk || 0,
      uid: pkg.uid || 0,
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

// --- RKP: Real checks with tooltips ---
async function fetchRKP() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;
  showLoading('rkp', true);
  try {
    // Real keystore check
    let ksOut = '';
    let kMint = false;
    try {
      ksOut = await adbShell(info.adb, 'cmd keystore');
      kMint = ksOut.toLowerCase().includes('keymint');
    } catch(e) {}

    // Real attestation check
    let attestOut = '';
    let attestOk = false;
    try {
      attestOut = await adbShell(info.adb, 'cmd key_attestation');
      attestOk = !attestOut.toLowerCase().includes('error') && !attestOut.toLowerCase().includes('not found');
    } catch(e) {}

    // GMS check
    let gms = 'Not installed';
    try {
      const g = await adbShell(info.adb, 'pm list packages com.google.android.gms');
      if (g.includes('com.google.android.gms')) gms = 'Installed';
    } catch(e) {}

    // Play Integrity
    let pi = 'Not installed';
    try {
      const p = await adbShell(info.adb, 'pm list packages com.google.android.gms.integrity');
      if (p.includes('com.google.android.gms.integrity')) pi = 'Installed';
    } catch(e) {}

    // RKP properties
    const props = await Promise.allSettled([
      safeGetProp(info.adb, 'ro.vendor.qti.security.rkp.enabled'),
      safeGetProp(info.adb, 'ro.hardware.nfc'),
      safeGetProp(info.adb, 'ro.rkp.enabled'),
      safeGetProp(info.adb, 'ro.boot.flash.locked'),
    ]);
    const rv = props.map(r => r.value || '');

    const rows = [
      ['KeyMint Provider',
       kMint ? 'Active (hardware-backed)' : (ksOut || 'Not found').substring(0, 80),
       kMint ? 'ok' : 'warn',
       'KeyMint is the modern Android key management API. Active means hardware-backed key storage is functional.'],
      ['Key Attestation',
       attestOk ? 'Operational' : (attestOut || 'Not available').substring(0, 80),
       attestOk ? 'ok' : 'warn',
       'Key Attestation lets apps verify that keys are hardware-backed. "Operational" means the device can generate attestation certificates.'],
      ['GMS Core', gms, gms === 'Installed' ? 'ok' : 'warn',
       'Google Play Services. Required for Google SafetyNet and Play Integrity checks.'],
      ['Play Integrity', pi, pi === 'Installed' ? 'ok' : 'warn',
       'Play Integrity API replaces SafetyNet. Used by apps like banking to verify device integrity.'],
      ['RKP Vendor Enabled', rv[0] || 'Not set', rv[0] === 'true' ? 'ok' : 'unknown',
       'Vendor-specific RKP (Remote Key Provisioning) enable flag. Used by Samsung and other OEMs for NFC payment key provisioning.'],
      ['NFC Hardware', rv[1] || 'Not set', rv[1] ? 'ok' : 'warn',
       'NFC chip identifier. Required for contactless payments and RKP provisioning workflows.'],
      ['RKP Enabled', rv[2] || 'Not set', rv[2] === 'true' ? 'ok' : 'unknown',
       'System-level RKP enable flag. When true, the device supports remote key provisioning for payment systems.'],
      ['Flash Locked', rv[3] || 'Not set', rv[3] === 'true' || rv[3] === '1' ? 'ok' : 'warn',
       'Bootloader lock status. Locked flash means the bootloader has not been unlocked, required for verified boot and attestation.'],
    ];
    document.getElementById('rkp-output').innerHTML = renderStatusTable(rows);
  } catch (err) {
    document.getElementById('rkp-output').innerHTML = '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('rkp', false);
}

async function safeGetProp(adb, prop) {
  try { return (await adb.getProp(prop)).trim(); } catch(e) { return ''; }
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
    json = { package: dataCache.packages.map(p => ({
      name: p.name,
      version_name: p.version_name || '',
      dir: p.dir || '',
      system_priv: p.system_priv,
      min_sdk: p.min_sdk || 0,
      target_sdk: p.target_sdk || 0,
      uid: p.uid || 0,
      sha256_cert: p.sha256_cert || '',
      sha256_file: p.sha256_file || '',
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

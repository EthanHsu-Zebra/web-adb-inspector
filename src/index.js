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

const dataCache = {
  props: [],
  features: [],
  packages: [],
};

const SDK_FEATURE_PREFIXES = [
  'android.hardware.', 'android.software.', 'android.feature.',
  'com.google.android.feature.',
];

function isSDKFeature(name) {
  return SDK_FEATURE_PREFIXES.some(p => name.startsWith(p));
}

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  checkWebUSB();
  credentialStore.iterateKeys().catch(() => credentialStore.generateKey());
});

function checkWebUSB() {
  const badge = document.getElementById('webusb-status');
  if (!AdbDaemonWebUsbDeviceManager.BROWSER) {
    badge.textContent = 'WebUSB: NOT supported';
    badge.className = 'badge err';
    document.getElementById('btn-scan').disabled = true;
    return;
  }
  badge.textContent = 'WebUSB: ready';
  badge.className = 'badge ok';
}

function getADBReleaseHelp() {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'windows';
  if (/Mac/.test(ua)) return 'mac';
  if (/Linux/.test(ua)) return 'linux';
  return 'unknown';
}

function showADBReleaseDialog() {
  const os = getADBReleaseHelp();
  let title, body;
  if (os === 'windows') {
    title = 'Release ADB on Windows';
    body = '1. Open Command Prompt\n2. Run: adb kill-server\n3. Or: taskkill /F /IM adb.exe\n4. Refresh page';
  } else if (os === 'mac') {
    title = 'Release ADB on macOS';
    body = '1. Terminal: adb kill-server\n2. If stuck: pkill -f adb';
  } else {
    title = 'Release ADB on Linux';
    body = 'echo "BUS-DEV" | sudo tee /sys/bus/usb/drivers/android_usb/unbind';
  }
  alert(title + '\n\n' + body);
}

// --- Device Discovery ---
async function scanDevices() {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) return;
  try {
    const device = await manager.requestDevice({ filters: [AdbDefaultInterfaceFilter] });
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
      serial: usbDevice.serial || 'usb',
      connection,
      credentialStore,
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
  if (sp && sp.isSupported) {
    const result = await sp.spawnWaitText(cmd);
    return result.stdout;
  }
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
  if (connectedDevices.size === 0) {
    list.classList.add('hidden');
    welcome.classList.remove('hidden');
    return;
  }
  welcome.classList.add('hidden');
  list.classList.remove('hidden');
  list.innerHTML = '';
  for (const [serial, info] of connectedDevices) {
    const card = document.createElement('div');
    card.className = 'device-card' + (activeSerial === serial ? ' active' : '');
    card.innerHTML = '<div><div class="dev-name">' + esc(info._displayName || serial) + '</div>' +
      '<div class="dev-serial">' + esc(serial) + '</div></div>' +
      '<span class="dev-status" style="color:var(--green)">Connected</span>';
    card.onclick = () => selectDevice(serial);
    list.appendChild(card);
  }
}

function selectDevice(serial) {
  const info = connectedDevices.get(serial);
  if (!info) return;
  activeSerial = serial;
  document.getElementById('inspector-section').classList.remove('hidden');
  document.getElementById('selected-device-name').textContent =
    (info._displayName || serial) + ' (' + serial + ')';
  renderDeviceList();
  document.getElementById('shell-output').textContent = '';
  fetchProperties();
  fetchFeatures();
  fetchPackages();
  fetchAttestation();
  fetchRKP();
}

async function disconnectDevice() {
  if (!activeSerial) return;
  const info = connectedDevices.get(activeSerial);
  if (info) {
    try { await info.transport.close(); } catch(e) {}
    try { await info.usbDevice.close(); } catch(e) {}
  }
  connectedDevices.delete(activeSerial);
  activeSerial = null;
  document.getElementById('inspector-section').classList.add('hidden');
  renderDeviceList();
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
    const regex = /\[(ro[.\w]+)\]:\s*\[([^\]]*)\]/g;
    let m;
    while ((m = regex.exec(text)) !== null) props.push({ name: m[1], value: m[2] });
    dataCache.props = props;
    document.getElementById('props-count').textContent = '(' + props.length + ')';
    document.getElementById('props-output').innerHTML =
      props.map(p => '<div class="prop-row"><span class="prop-key">' + esc(p.name) + '</span><span class="prop-val">' + esc(p.value) + '</span></div>').join('');
  } catch (err) {
    document.getElementById('props-output').innerHTML = '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('props', false);
}

async function fetchFeatures() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;
  showLoading('features', true);
  try {
    const text = await adbShell(info.adb, 'pm list features');
    const features = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let name = trimmed;
      let version = 0;
      const verMatch = trimmed.match(/^feature:(.+?)\s+ver:(\d+)$/);
      if (verMatch) { name = verMatch[1]; version = parseInt(verMatch[2], 10); }
      else { name = trimmed.replace(/^feature:/, ''); }
      name = name.trim();
      if (!name) continue;
      features.push({ name, type: isSDKFeature(name) ? 'sdk' : 'other', available: true, version });
    }
    dataCache.features = features;
    document.getElementById('features-count').textContent = '(' + features.length + ')';
    document.getElementById('features-output').innerHTML =
      features.map(f => {
        const tb = f.type === 'sdk' ? '<span class="feat-type">sdk</span>' : '<span class="feat-type other">other</span>';
        const vs = f.version > 0 ? ' v' + f.version : '';
        return '<div class="feat-item">' + tb + ' ' + esc(f.name) + '<span class="feat-ver">' + vs + '</span></div>';
      }).join('');
  } catch (err) {
    document.getElementById('features-output').innerHTML = '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('features', false);
}

// --- Packages: dumpsys via temp file + sync protocol ---
async function fetchPackages() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;
  showLoading('packages', true);
  try {
    const tmpPath = '/data/local/tmp/webadb_dumpsys.txt';
    // Write dumpsys output to file (bypasses shell buffer)
    await adbShell(info.adb, 'dumpsys package > ' + tmpPath + ' 2>&1');
    // Read via ADB sync protocol
    const text = await readDeviceFile(info.adb, tmpPath);
    // Cleanup
    try { await adbShell(info.adb, 'rm -f ' + tmpPath); } catch(e) {}

    const packages = parseDumpsysPackage(text);
    dataCache.packages = packages;
    renderPackages(packages);
  } catch (err) {
    // Fallback: use pm list packages
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
  const sys = packages.filter(p => p.system);
  const priv = packages.filter(p => p.system_priv);
  const user = packages.filter(p => !p.system);

  document.getElementById('packages-count').textContent = '(' + packages.length + ')';
  let html = '<div class="prop-count">' + packages.length + ' total' +
    (sys.length ? ' <span style="color:var(--muted)">' + sys.length + ' sys</span>' : '') +
    (user.length ? ' <span style="color:var(--green)">' + user.length + ' user</span>' : '') +
    (priv.length ? ' <span style="color:var(--orange)">' + priv.length + ' priv</span>' : '') +
    (fallback ? ' <span style="color:var(--yellow)">[fallback - limited data]</span>' : '') +
    '</div>';

  html += packages.map((p, i) => {
    let badges = '';
    if (p.system_priv) badges += '<span class="pkg-badge priv">priv</span> ';
    else if (p.system) badges += '<span class="pkg-badge sys">sys</span> ';
    const verStr = p.version_name ? ' v' + esc(p.version_name) : '';
    const permCount = p.requested_permissions ? p.requested_permissions.length : null;
    const expandable = p.version_name || permCount !== null;
    return '<div class="pkg-item">' + esc(p.name) + ' <span class="pkg-ver">' + verStr + '</span> ' + badges +
      (expandable ? '<button class="btn btn-sm pkg-expand" onclick="togglePkgDetail(' + i + ')">⌄</button>' : '') + '</div>' +
      (expandable ? '<div id="pkg-detail-' + i + '" class="pkg-detail hidden">' +
        renderPackageDetail(p) + '</div>' : '');
  }).join('');

  document.getElementById('packages-output').innerHTML = html;
}

function renderPackageDetail(p) {
  let html = '<div class="pkg-detail-row"><span class="pkg-detail-label">Version:</span>' + esc(p.version_name || '?') + '</div>';
  html += '<div class="pkg-detail-row"><span class="pkg-detail-label">Path:</span><span class="pkg-path">' + esc(p.dir || '?') + '</span></div>';
  html += '<div class="pkg-detail-row"><span class="pkg-detail-label">SDK:</span>min ' + (p.min_sdk || '?') + ' / target ' + (p.target_sdk || '?') + '</div>';
  html += '<div class="pkg-detail-row"><span class="pkg-detail-label">UID:</span>' + (p.uid || '?') + '</div>';
  html += '<div class="pkg-detail-row"><span class="pkg-detail-label">Cert (SHA256):</span>' + esc(p.sha256_cert || 'N/A') + '</div>';
  if (p.requested_permissions && p.requested_permissions.length > 0) {
    html += '<div class="pkg-detail-row"><span class="pkg-detail-label">Permissions (' + p.requested_permissions.length + '):</span>' +
      '<div class="pkg-perms">';
    for (const perm of p.requested_permissions.slice(0, 20)) {
      const granted = perm.is_granted !== undefined ? (perm.is_granted ? '✓' : '✗') : '';
      html += '<div class="pkg-perm-item">' + esc(perm.name) + '<span class="pkg-perm-status">' + granted + '</span></div>';
    }
    if (p.requested_permissions.length > 20) {
      html += '<div class="pkg-perm-more">...and ' + (p.requested_permissions.length - 20) + ' more</div>';
    }
    html += '</div></div>';
  }
  return html;
}

window.togglePkgDetail = function(idx) {
  const el = document.getElementById('pkg-detail-' + idx);
  if (el) el.classList.toggle('hidden');
};

// Parse dumpsys package output
function parseDumpsysPackage(text) {
  const packages = [];
  const lines = text.split('\n');
  let currentPkg = null;
  let inRequested = false;
  let inDeclared = false;
  let inPerm = false;
  let currentPerm = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Package header
    const pkgMatch = line.match(/^Package\s+([:\[])(\S+)/) || line.match(/^Package:\s+(\S+)/);
    if (pkgMatch) {
      if (currentPkg) finalizePerm();
      if (currentPkg) packages.push(currentPkg);
      currentPkg = {
        name: pkgMatch[2],
        version_name: '', version_code: 0,
        dir: '', system: false, system_priv: false,
        min_sdk: 0, target_sdk: 0, uid: 0,
        sha256_cert: '',
        requested_permissions: [],
        defined_permissions: [],
      };
      inRequested = false;
      inDeclared = false;
      inPerm = false;
      currentPerm = null;
      continue;
    }

    if (!currentPkg) continue;

    // Section headers
    if (trimmed === 'Requested permissions:') {
      finalizePerm();
      inRequested = true; inDeclared = false;
      continue;
    }
    if (trimmed === 'Declared permissions:') {
      finalizePerm();
      inDeclared = true; inRequested = false;
      continue;
    }
    if (trimmed.startsWith('install permissions:') || trimmed === '') {
      if (inPerm && trimmed !== '') finalizePerm();
      if (!trimmed.startsWith('Package')) {
        inRequested = false; inDeclared = false; inPerm = false;
      }
      continue;
    }

    // Permission names (indented)
    if ((inRequested || inDeclared) && line.match(/^\s+/) && !line.match(/^(\s{4,})(name|flags|protection|type|group)\s*=/)) {
      const permName = trimmed.replace(/^uses-?permission:\s*/, '');
      if (permName && permName.startsWith('android.permission.') || permName.startsWith('com.')) {
        finalizePerm();
        currentPerm = { name: permName };
        inPerm = true;
        continue;
      }
    }

    // Permission attributes
    if (inPerm && currentPerm) {
      const attr = parsePermAttr(trimmed);
      if (attr) Object.assign(currentPerm, attr);
      else if (!trimmed.startsWith('android.permission') && !trimmed.startsWith('com.')) {
        finalizePerm();
        inPerm = false;
      }
      continue;
    }

    // Package fields
    if (line.match(/^\s+/) && !inRequested && !inDeclared) {
      const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)/);
      if (kvMatch) {
        const key = kvMatch[1];
        const val = kvMatch[2];
        if (key === 'versionName' || key === 'versionName=' ) currentPkg.version_name = val;
        else if (key === 'versionCode' || key === 'versionCode=' ) currentPkg.version_code = parseInt(val, 10) || 0;
        else if (key === 'codePath' || key === 'codePath=') {
          currentPkg.dir = val;
          currentPkg.system = ['/system/', '/product/', '/vendor/', '/apex/', '/oem/'].some(p => val.startsWith(p));
          currentPkg.system_priv = ['/system/priv-app/', '/product/priv-app/', '/vendor/priv-app/'].some(p => val.startsWith(p));
        }
        else if (key === 'minSdk' || key === 'minSdk=') currentPkg.min_sdk = parseInt(val, 10) || 0;
        else if (key === 'targetSdk' || key === 'targetSdk=') currentPkg.target_sdk = parseInt(val, 10) || 0;
        else if (key === 'uid' || key === 'uid=') currentPkg.uid = parseInt(val, 10) || 0;
        else if (key === 'cert' || key === 'cert=' || key.startsWith('cert[0]') || key === 'primaryCerts:') {
          // Parse cert hash
          const certHash = val.match(/([A-F0-9:]+)/);
          if (certHash) currentPkg.sha256_cert = certHash[1];
        }
      }
    }
  }

  finalizePerm();
  if (currentPkg) packages.push(currentPkg);
  return packages;

  function finalizePerm() {
    if (currentPerm) {
      const p = {
        name: currentPerm.name || '',
        is_granted: currentPerm.is_granted !== undefined ? currentPerm.is_granted : true,
        protection_level: currentPerm.protection_level || 0,
        permission_group: currentPerm.permission_group || '',
      };
      if (inRequested) currentPkg.requested_permissions.push(p);
      else if (inDeclared) currentPkg.defined_permissions.push(p);
      currentPerm = null;
      inPerm = false;
    }
  }

  function parsePermAttr(line) {
    const m = line.match(/^(\w+)\s*=\s*(.+)/);
    if (!m) return null;
    const key = m[1];
    const val = m[2];
    if (key === 'name') return { name: val };
    if (key === 'flags') return { flags: parseInt(val, 10) || 0 };
    if (key === 'protectionLevel' || key === 'protection_level') return { protection_level: parseInt(val, 10) || 0 };
    if (key === 'type') return { type: parseInt(val, 10) || 0 };
    if (key === 'group') return { permission_group: val };
    if (key === 'granted') return { is_granted: val === 'true' };
    return null;
  }
}

// Fallback: pm list packages -f
function parsePmListPackagesFallback(text) {
  const packages = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('package:')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const pathPart = trimmed.substring(9, eqIdx);
    const name = trimmed.substring(eqIdx + 1);
    if (!name) continue;
    const system = ['/system/', '/product/', '/vendor/', '/apex/', '/oem/'].some(p => pathPart.startsWith(p));
    const system_priv = ['/system/priv-app/', '/product/priv-app/', '/vendor/priv-app/'].some(p => pathPart.startsWith(p));
    packages.push({
      name, version_name: '', dir: pathPart, system, system_priv,
      min_sdk: 0, target_sdk: 0, uid: 0,
      requested_permissions: [], defined_permissions: [],
    });
  }
  return packages;
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

    const bootState = vals[0]?.trim().toLowerCase();
    const vbmetaSec = vals[1]?.trim().toLowerCase();
    const verity = vals[2]?.trim().toLowerCase();
    const flashLocked = vals[3]?.trim();
    const featuresText = vals[4] || '';

    const hasKeyMint = featuresText.includes('android.hardware.security.keymint');
    const hasStrongbox = featuresText.includes('strongbox');

    const rows = [
      ['Verified Boot', bootState || 'N/A', bootState === 'orange' || bootState === 'green' ? 'ok' : (bootState ? 'warn' : 'unknown')],
      ['VBMeta Security', vbmetaSec || 'N/A', vbmetaSec === 'software' ? 'ok' : (vbmetaSec ? 'warn' : 'unknown')],
      ['DM-Verity', verity || 'N/A', verity === 'enforce' ? 'ok' : (verity ? 'warn' : 'unknown')],
      ['Flash Locked', flashLocked || 'N/A', flashLocked === 'true' || flashLocked === '1' ? 'ok' : (flashLocked ? 'warn' : 'unknown')],
      ['KeyMint', hasKeyMint ? 'Yes' : 'No', hasKeyMint ? 'ok' : 'warn'],
      ['StrongBox', hasStrongbox ? 'Yes' : 'No', hasStrongbox ? 'ok' : 'warn'],
    ];
    document.getElementById('attestation-output').innerHTML = renderStatusTable(rows);
  } catch (err) {
    document.getElementById('attestation-output').innerHTML = '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('attestation', false);
}

// --- RKP: Real hardware checks via cmd keystore / key_attestation ---
async function fetchRKP() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;
  showLoading('rkp', true);
  try {
    // Real keystore check
    let keystoreProviders = '';
    let keymintPresent = false;
    try {
      const keystoreOut = await adbShell(info.adb, 'cmd keystore');
      keystoreProviders = keystoreOut;
      keymintPresent = keystoreOut.toLowerCase().includes('keymint');
    } catch(e) {}

    // Real attestation check
    let attestationOutput = '';
    let attestationWorks = false;
    try {
      attestationOutput = await adbShell(info.adb, 'cmd key_attestation');
      attestationWorks = !attestationOutput.toLowerCase().includes('error') &&
                         !attestationOutput.toLowerCase().includes('not found');
    } catch(e) {}

    // Check GMS / SafetyNet
    let gmsPackage = 'Not installed';
    try {
      const gmsCheck = await adbShell(info.adb, 'pm list packages com.google.android.gms');
      if (gmsCheck.includes('com.google.android.gms')) gmsPackage = 'Installed';
    } catch(e) {}

    // Check Play Integrity
    let playIntegrity = 'Not installed';
    try {
      const piCheck = await adbShell(info.adb, 'pm list packages com.google.android.gms.integrity');
      if (piCheck.includes('com.google.android.gms.integrity')) playIntegrity = 'Installed';
    } catch(e) {}

    // RKP properties
    const props = await Promise.allSettled([
      safeGetProp(info.adb, 'ro.vendor.qti.security.rkp.enabled'),
      safeGetProp(info.adb, 'ro.hardware.nfc'),
      safeGetProp(info.adb, 'ro.rkp.enabled'),
      safeGetProp(info.adb, 'ro.boot.flash.locked'),
    ]);
    const rkpVals = props.map(r => r.value || '');

    const rows = [
      ['KeyMint Provider', keymintPresent ? 'Active (hardware-backed)' : keystoreProviders || 'Not found', keymintPresent ? 'ok' : 'warn'],
      ['Key Attestation', attestationWorks ? 'Operational' : (attestationOutput || 'Not available'), attestationWorks ? 'ok' : 'warn'],
      ['GMS Core', gmsPackage, gmsPackage === 'Installed' ? 'ok' : 'warn'],
      ['Play Integrity', playIntegrity, playIntegrity === 'Installed' ? 'ok' : 'warn'],
      ['RQP Vendor Enabled', rkpVals[0] || 'Not set', rkpVals[0] === 'true' ? 'ok' : 'unknown'],
      ['NFC Hardware', rkpVals[1] || 'Not set', rkpVals[1] ? 'ok' : 'warn'],
      ['RKP Enabled', rkpVals[2] || 'Not set', rkpVals[2] === 'true' ? 'ok' : 'unknown'],
      ['Flash Locked', rkpVals[3] || 'Not set', rkpVals[3] === 'true' || rkpVals[3] === '1' ? 'ok' : 'warn'],
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
    rows.map(([check, value, status]) => {
      const sc = 'status-' + status;
      const sl = status === 'ok' ? 'PASS' : status === 'warn' ? 'WARN' : status === 'fail' ? 'FAIL' : 'N/A';
      return '<tr><td>' + esc(check) + '</td><td>' + esc(value || 'N/A') + '</td><td class="' + sc + '">' + sl + '</td></tr>';
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
function runCmd(cmd) {
  document.getElementById('shell-input').value = cmd;
  runShell();
}

// --- Export JSON (CTS format) ---
function exportJSON(type) {
  let json, filename;
  if (type === 'props') {
    json = { ro_property: dataCache.props.map(p => ({ name: p.name, value: p.value })) };
    filename = 'PropertyDeviceInfo.deviceinfo.json';
  } else if (type === 'features') {
    json = { feature: dataCache.features.map(f => ({ name: f.name, type: f.type, available: f.available, version: f.version })) };
    filename = 'FeatureDeviceInfo.deviceinfo.json';
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
      requested_permissions: (p.requested_permissions || []).map(rp => ({
        name: rp.name,
        flags: rp.flags || 0,
        permission_group: rp.permission_group || '',
        protection_level: rp.protection_level || 0,
        type: rp.type || 0,
        is_granted: rp.is_granted !== undefined ? rp.is_granted : true,
      })),
      defined_permissions: (p.defined_permissions || []).map(dp => ({
        name: dp.name,
        flags: dp.flags || 0,
        permission_group: dp.permission_group || '',
        protection_level: dp.protection_level || 0,
        type: dp.type || 0,
      })),
    }))};
    filename = 'PackageDeviceInfo.deviceinfo.json';
  } else return;
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// --- Utilities ---
function showLoading(id, show) {
  const el = document.getElementById(id + '-loading');
  if (show) el.classList.remove('hidden');
  else el.classList.add('hidden');
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
function copyPanel(id) {
  navigator.clipboard.writeText(document.getElementById(id).innerText);
}
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Expose to window
window.scanDevices = scanDevices;
window.disconnectDevice = disconnectDevice;
window.switchTab = switchTab;
window.runShell = runShell;
window.runCmd = runCmd;
window.copyPanel = copyPanel;
window.showADBReleaseDialog = showADBReleaseDialog;
window.exportJSON = exportJSON;
window.togglePkgDetail = togglePkgDetail;

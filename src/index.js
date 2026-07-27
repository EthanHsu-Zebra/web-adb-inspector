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

// Cached data for export (CTS-compatible format)
const dataCache = {
  props: [],      // { name, value } - ro.* only
  features: [],   // { name, type, available, version }
  packages: [],   // { name, version_name, system_priv, min_sdk, target_sdk, ... }
};

// SDK feature prefixes for type detection
const SDK_FEATURE_PREFIXES = [
  'android.hardware.',
  'android.software.',
  'android.feature.',
  'com.google.android.feature.',
];

function isSDKFeature(name) {
  for (const prefix of SDK_FEATURE_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  // Also check for well-known SDK features that don't follow the pattern
  return false;
}

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  checkWebUSB();
  credentialStore.iterateKeys().catch(() => credentialStore.generateKey());
});

function checkWebUSB() {
  const badge = document.getElementById('webusb-status');
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) {
    badge.textContent = 'WebUSB: NOT supported (use Chrome/Edge)';
    badge.className = 'badge err';
    document.getElementById('btn-scan').disabled = true;
    return;
  }
  badge.textContent = 'WebUSB: ready';
  badge.className = 'badge ok';
}

// --- OS detection for ADB release help ---
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
  switch (os) {
    case 'windows':
      title = 'Release ADB access on Windows';
      body = 'Your Windows adb.exe is holding the USB device.\n\n' +
             '1. Open Command Prompt or PowerShell\n' +
             '2. Run: adb kill-server\n' +
             '3. Or kill the process: taskkill /F /IM adb.exe\n\n' +
             'Then refresh this page and connect again.';
      break;
    case 'mac':
      title = 'Release ADB access on macOS';
      body = 'Your macOS ADB daemon is holding the USB device.\n\n' +
             '1. Open Terminal\n' +
             '2. Run: adb kill-server\n' +
             '3. If that fails:\n' +
             '   pkill -f adb\n' +
             '   sudo killall -9 ADB\\ Monitor\n\n' +
             'Then refresh this page and connect again.';
      break;
    case 'linux':
      title = 'Release ADB access on Linux';
      body = 'Linux kernel android_usb driver is holding the device.\n\n' +
             '1. Find your device: lsusb | grep -i android\n' +
             '2. Unbind: echo "BUS-DEV" | sudo tee /sys/bus/usb/drivers/android_usb/unbind\n\n' +
             'Example: echo "1-1.3" | sudo tee /sys/bus/usb/drivers/android_usb/unbind\n\n' +
             'To restore: echo "1-1.3" | sudo tee /sys/bus/usb/drivers/android_usb/bind';
      break;
    default:
      title = 'Release ADB access';
      body = 'Close any ADB server or process holding the device, then try again.';
  }
  alert(title + '\n\n' + body);
}

// --- Device Discovery ---
async function scanDevices() {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) return;

  try {
    const device = await manager.requestDevice({
      filters: [AdbDefaultInterfaceFilter],
    });
    if (!device) return;

    await connectDevice(device);
  } catch (err) {
    console.error('Scan failed:', err);
    const msg = err.message || String(err);
    if (msg.includes('already in use')) {
      showADBReleaseDialog();
    } else {
      alert('Failed to connect: ' + msg);
    }
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
    const serial = adb.serial;

    let displayName = usbDevice.name || 'Android Device';
    try {
      const model = await adb.getProp('ro.product.model');
      const brand = await adb.getProp('ro.product.brand');
      displayName = brand + ' ' + model;
    } catch (_) {}

    connectedDevices.set(serial, { adb, usbDevice, transport, _displayName: displayName });
    renderDeviceList();

    if (connectedDevices.size === 1) {
      selectDevice(serial);
    }

    setStatus('Connected', 'ok');
  } catch (err) {
    console.error('Connection failed:', err);
    const msg = err.message || String(err);
    if (msg.includes('already in use')) {
      showADBReleaseDialog();
    }
    setStatus('Connection failed: ' + msg, 'err');
  }
}

// --- Shell helper ---
async function adbShell(adb, cmd) {
  const sp = adb.subprocess.shellProtocol;
  if (sp && sp.isSupported) {
    const result = await sp.spawnWaitText(cmd);
    return result.stdout;
  }
  throw new Error('Shell protocol not supported on this device');
}

// --- UI Rendering ---
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
    const model = info._displayName || serial;
    card.innerHTML = `
      <div>
        <div class="dev-name">${esc(model)}</div>
        <div class="dev-serial">${esc(serial)}</div>
      </div>
      <span class="dev-status" style="color:var(--green)">Connected</span>
    `;
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

  // Clear shell output on device switch
  document.getElementById('shell-output').textContent = '';

  // Fetch all data
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
// DATA FETCHING - CTS-compatible shell commands
// ============================================

// --- Properties (ro.* only, matching CTS PropertyDeviceInfo) ---
async function fetchProperties() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;

  showLoading('props', true);
  try {
    const text = await adbShell(info.adb, 'getprop');

    // CTS PropertyDeviceInfo: only collects ro.* properties
    // Pattern: \[ro.+\]: \[(.+)\]
    const props = [];
    const regex = /\[(ro[.\w]+)\]:\s*\[([^\]]*)\]/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      props.push({ name: m[1], value: m[2] });
    }
    dataCache.props = props;

    document.getElementById('props-count').textContent = '(' + props.length + ')';
    document.getElementById('props-output').innerHTML =
      props.map(p =>
        '<div class="prop-row"><span class="prop-key">' + esc(p.name) + '</span><span class="prop-val">' + esc(p.value) + '</span></div>'
      ).join('');
  } catch (err) {
    document.getElementById('props-output').innerHTML =
      '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('props', false);
}

// --- Features (pm list features with version parsing) ---
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

      // Parse: feature:name or feature:name ver:XX
      const verMatch = trimmed.match(/^feature:(.+?)\s+ver:(\d+)$/);
      if (verMatch) {
        name = verMatch[1];
        version = parseInt(verMatch[2], 10);
      } else {
        name = trimmed.replace(/^feature:/, '');
      }

      name = name.trim();
      if (!name) continue;

      features.push({
        name,
        type: isSDKFeature(name) ? 'sdk' : 'other',
        available: true,
        version,
      });
    }
    dataCache.features = features;

    document.getElementById('features-count').textContent = '(' + features.length + ')';
    document.getElementById('features-output').innerHTML =
      features.map(f => {
        const typeBadge = f.type === 'sdk' ? '<span class="feat-type">sdk</span>' : '<span class="feat-type other">other</span>';
        const verStr = f.version > 0 ? ' v' + f.version : '';
        return '<div class="feat-item">' + typeBadge + ' ' + esc(f.name) + '<span class="feat-ver">' + verStr + '</span></div>';
      }).join('');
  } catch (err) {
    document.getElementById('features-output').innerHTML =
      '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('features', false);
}

// --- Packages (dumpsys package for rich data) ---
async function fetchPackages() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;

  showLoading('packages', true);
  try {
    // Use dumpsys package to get ALL packages with version info in one call
    const text = await adbShell(info.adb, 'dumpsys package');

    const packages = parseDumpsysPackage(text);
    dataCache.packages = packages;

    // Count third-party only for display
    const thirdParty = packages.filter(p => !p.system_priv && !p.dir.startsWith('/system/') && !p.dir.startsWith('/apex/'));

    document.getElementById('packages-count').textContent = '(' + packages.length + ')';
    document.getElementById('packages-output').innerHTML =
      '<div class="prop-count">' + packages.length + ' total packages' + (thirdParty.length !== packages.length ? ' (' + thirdParty.length + ' third-party)' : '') + '</div>' +
      packages.map(p => {
        const privBadge = p.system_priv ? '<span class="pkg-badge priv">priv</span>' : '';
        return '<div class="pkg-item">' + esc(p.name) + ' <span class="pkg-ver">v' + esc(p.version_name || '?') + '</span> ' + privBadge + '</div>';
      }).join('');
  } catch (err) {
    document.getElementById('packages-output').innerHTML =
      '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('packages', false);
}

// Parse dumpsys package output
function parseDumpsysPackage(text) {
  const packages = [];
  const lines = text.split('\n');
  let currentPkg = null;
  let inPermissions = false;
  let inDeclaredPermissions = false;

  for (const line of lines) {
    // New package block: "Package: com.example.app" or "Package [com.example.app]:"
    const pkgMatch = line.match(/^Package\s+\[?([^\]\s]+)\]?[:\s]/);
    if (pkgMatch) {
      // Save previous package
      if (currentPkg) packages.push(currentPkg);
      currentPkg = {
        name: pkgMatch[1],
        version_name: '',
        system_priv: false,
        min_sdk: 0,
        target_sdk: 0,
        uid: 0,
        dir: '',
        requested_permissions: [],
        defined_permissions: [],
      };
      inPermissions = false;
      inDeclaredPermissions = false;
      continue;
    }

    if (!currentPkg) continue;

    // Version name
    const verNameMatch = line.match(/^\s+versionName=(.+?)\s*$/);
    if (verNameMatch) {
      currentPkg.version_name = verNameMatch[1].trim();
    }

    // Code path (for system_priv detection)
    const codePathMatch = line.match(/^\s+codePath=(.+?)\s*$/);
    if (codePathMatch) {
      currentPkg.dir = codePathMatch[1].trim();
      currentPkg.system_priv = currentPkg.dir.startsWith('/system/priv-app/');
    }

    // SDK versions
    const minSdkMatch = line.match(/^\s+minSdk=(\d+)/);
    if (minSdkMatch) currentPkg.min_sdk = parseInt(minSdkMatch[1], 10);
    const targetSdkMatch = line.match(/^\s+targetSdk=(\d+)/);
    if (targetSdkMatch) currentPkg.target_sdk = parseInt(targetSdkMatch[1], 10);

    // UID
    const uidMatch = line.match(/^\s+uid=(\d+)/);
    if (uidMatch) currentPkg.uid = parseInt(uidMatch[1], 10);

    // Section headers
    if (line.includes('requested permissions:')) {
      inPermissions = true;
      inDeclaredPermissions = false;
      continue;
    }
    if (line.includes('declared permissions:')) {
      inDeclaredPermissions = true;
      inPermissions = false;
      continue;
    }
    if (line.includes('install permissions:')) {
      inPermissions = false;
      inDeclaredPermissions = false;
      continue;
    }

    // Permission lines: "  uses-permission: android.permission.XXX" or "  permission: android.permission.XXX"
    if (inPermissions || inDeclaredPermissions) {
      const permMatch = line.match(/^\s+(?:uses-)?permission:\s*(\S+)/);
      if (permMatch) {
        const permName = permMatch[1];
        const perm = { name: permName };
        if (inPermissions) {
          currentPkg.requested_permissions.push(perm);
        } else if (inDeclaredPermissions) {
          currentPkg.defined_permissions.push(perm);
        }
      }
    }
  }

  // Don't forget the last package
  if (currentPkg) packages.push(currentPkg);

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
      safeGetProp(info.adb, 'ro.hardware.keystore'),
      safeGetProp(info.adb, 'ro.security.keystore'),
      safeGetProp(info.adb, 'ro.hardware.av'),
      safeGetProp(info.adb, 'ro.boot.flash.locked'),
      adbShell(info.adb, 'pm list features').catch(() => ''),
    ]);

    const vals = results.map(r => r.value || '');
    const bootStateVal = vals[0].trim().toLowerCase();
    const securityLevelVal = vals[1].trim().toLowerCase();
    const verityVal = vals[2].trim().toLowerCase();
    const keystoreHW = vals[3].trim();
    const keystoreSec = vals[4].trim();
    const avHW = vals[5].trim();
    const flashLocked = vals[6].trim();
    const featuresText = vals[7];

    const hasKeyMint = featuresText.includes('android.hardware.security.keymint');
    const hasStrongbox = featuresText.includes('strongbox');
    const strongboxDetail = hasStrongbox ? 'StrongBox' : (hasKeyMint ? 'KeyMint (TEE)' : 'Not detected');

    const rows = [
      ['Verified Boot State', bootStateVal || 'N/A', bootStateVal === 'orange' || bootStateVal === 'green' ? 'ok' : (bootStateVal ? 'warn' : 'unknown')],
      ['VBMeta Security Level', securityLevelVal || 'N/A', securityLevelVal === 'software' ? 'ok' : (securityLevelVal ? 'warn' : 'unknown')],
      ['DM-Verity Mode', verityVal || 'N/A', verityVal === 'enforce' ? 'ok' : (verityVal ? 'warn' : 'unknown')],
      ['Flash Locked', flashLocked || 'N/A', flashLocked === 'true' || flashLocked === '1' ? 'ok' : (flashLocked ? 'warn' : 'unknown')],
      ['KeyMint / StrongBox', strongboxDetail, hasKeyMint ? 'ok' : 'warn'],
      ['AV Hardware', avHW || 'N/A', avHW ? 'ok' : 'warn'],
      ['Keystore Hardware', keystoreHW || 'N/A', 'unknown'],
      ['Keystore Security', keystoreSec || 'N/A', 'unknown'],
    ];

    document.getElementById('attestation-output').innerHTML = renderStatusTable(rows);
  } catch (err) {
    document.getElementById('attestation-output').innerHTML =
      '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('attestation', false);
}

// --- RKP (Remote Key Provisioning) ---
async function fetchRKP() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;

  showLoading('rkp', true);
  try {
    const rkpProps = await Promise.allSettled([
      safeGetProp(info.adb, 'ro.rkp.enabled'),
      safeGetProp(info.adb, 'ro.security.rkp'),
      safeGetProp(info.adb, 'ro.boot.rkp'),
      safeGetProp(info.adb, 'ro.hardware.rkp'),
      safeGetProp(info.adb, 'ro.hardware.nfc'),
    ]);

    const rkpVals = rkpProps.map(r => r.value || '');

    // Check RKP-related packages
    let rkpPackages = [];
    try {
      const pkgs = await adbShell(info.adb, 'pm list packages');
      const rkpKeywords = ['rkp', 'remotek', 'remote.key', 'nfc.rkp', 'samsung.rkp', 'remote.provisioning'];
      for (const line of pkgs.split('\n')) {
        const trimmed = line.trim();
        for (const kw of rkpKeywords) {
          if (trimmed.toLowerCase().includes(kw)) {
            rkpPackages.push(trimmed.replace(/^package:/, ''));
          }
        }
      }
    } catch(e) {}

    // Check RKP-related features
    let rkpFeatures = [];
    try {
      const features = await adbShell(info.adb, 'pm list features');
      const rkpFeatKeywords = ['rkp', 'remote.key', 'nfc', 'remote.provisioning'];
      for (const line of features.split('\n')) {
        const trimmed = line.trim();
        for (const kw of rkpFeatKeywords) {
          if (trimmed.toLowerCase().includes(kw)) {
            rkpFeatures.push(trimmed.replace(/^feature:/, ''));
          }
        }
      }
    } catch(e) {}

    const rkpEnabled = rkpVals[0] === 'true' || rkpVals[0] === '1';
    const nfcHW = rkpVals[4];

    const rows = [
      ['RKP Enabled', rkpVals[0] || 'Not set', rkpEnabled ? 'ok' : (rkpVals[0] ? 'warn' : 'unknown')],
      ['RKP Security', rkpVals[1] || 'Not set', 'unknown'],
      ['RKP Boot', rkpVals[2] || 'Not set', 'unknown'],
      ['RKP Hardware', rkpVals[3] || 'Not set', 'unknown'],
      ['NFC Hardware', nfcHW || 'Not set', nfcHW ? 'ok' : 'warn'],
      ['RKP Packages', rkpPackages.length > 0 ? rkpPackages.join(', ') : 'None detected', rkpPackages.length > 0 ? 'ok' : 'warn'],
      ['RKP Features', rkpFeatures.length > 0 ? rkpFeatures.join(', ') : 'None detected', rkpFeatures.length > 0 ? 'ok' : 'warn'],
      ['Validation', 'Local properties only (no Google server)', 'warn'],
    ];

    document.getElementById('rkp-output').innerHTML = renderStatusTable(rows);
  } catch (err) {
    document.getElementById('rkp-output').innerHTML =
      '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('rkp', false);
}

async function safeGetProp(adb, prop) {
  try {
    return (await adb.getProp(prop)).trim();
  } catch(e) {
    return '';
  }
}

function renderStatusTable(rows) {
  return '<table class="status-table">' +
    '<thead><tr><th>Check</th><th>Value</th><th>Status</th></tr></thead>' +
    '<tbody>' +
    rows.map(([check, value, status]) => {
      const statusClass = 'status-' + status;
      const statusLabel = status === 'ok' ? 'PASS' : status === 'warn' ? 'WARN' : status === 'fail' ? 'FAIL' : 'N/A';
      return '<tr><td>' + esc(check) + '</td><td>' + esc(value || 'N/A') + '</td><td class="' + statusClass + '">' + statusLabel + '</td></tr>';
    }).join('') +
    '</tbody></table>';
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

  try {
    const text = await adbShell(info.adb, cmd);
    output.textContent += text + '\n';
  } catch (err) {
    output.textContent += 'Error: ' + String(err.message || err) + '\n';
  }

  output.scrollTop = output.scrollHeight;
}

function runCmd(cmd) {
  document.getElementById('shell-input').value = cmd;
  runShell();
}

// --- Export JSON (CTS-compatible format) ---
function exportJSON(type) {
  let json, filename;

  switch(type) {
    case 'props':
      json = { ro_property: dataCache.props.map(p => ({ name: p.name, value: p.value })) };
      filename = 'PropertyDeviceInfo.deviceinfo.json';
      break;
    case 'features':
      json = { feature: dataCache.features.map(f => ({ name: f.name, type: f.type, available: f.available, version: f.version })) };
      filename = 'FeatureDeviceInfo.deviceinfo.json';
      break;
    case 'packages':
      json = { package: dataCache.packages.map(p => {
        const obj = {
          name: p.name,
          version_name: p.version_name || '',
          dir: p.dir || '',
          system_priv: p.system_priv,
          min_sdk: p.min_sdk || 0,
          target_sdk: p.target_sdk || 0,
          uid: p.uid || 0,
          requested_permissions: (p.requested_permissions || []).map(rp => ({
            name: rp.name,
          })),
          defined_permissions: (p.defined_permissions || []).map(dp => ({
            name: dp.name,
          })),
        };
        return obj;
      })};
      filename = 'PackageDeviceInfo.deviceinfo.json';
      break;
    default:
      return;
  }

  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Utilities ---
function showLoading(section, show) {
  const el = document.getElementById(section + '-loading');
  if (show) el.classList.remove('hidden');
  else el.classList.add('hidden');
}

function setStatus(text, type) {
  const badge = document.getElementById('webusb-status');
  badge.textContent = text;
  badge.className = 'badge ' + (type === 'ok' ? 'ok' : type === 'err' ? 'err' : '');
}

function switchTab(tabEl, contentId) {
  const panel = tabEl.parentElement;
  panel.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  tabEl.classList.add('active');
  const parent = panel.parentElement;
  parent.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(contentId).classList.add('active');
}

function copyPanel(elementId) {
  const el = document.getElementById(elementId);
  const text = el.innerText || el.textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = el.parentElement.querySelector('.copy-btn');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = orig, 1500);
    }
  });
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Expose UI functions to window for inline onclick handlers
window.scanDevices = scanDevices;
window.disconnectDevice = disconnectDevice;
window.switchTab = switchTab;
window.runShell = runShell;
window.runCmd = runCmd;
window.copyPanel = copyPanel;
window.showADBReleaseDialog = showADBReleaseDialog;
window.exportJSON = exportJSON;

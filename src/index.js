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

// Cached data for export
const dataCache = { props: [], features: [], packages: [] };

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

// --- Data Fetching ---
async function fetchProperties() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;

  showLoading('props', true);
  try {
    const text = await adbShell(info.adb, 'getprop');

    const props = [];
    const regex = /\[([^\]]+):\s*([^\]]*)\]/g;
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
      const name = trimmed.replace(/^feature:/, '').trim();
      if (name) features.push({ name });
    }
    dataCache.features = features;

    document.getElementById('features-count').textContent = '(' + features.length + ')';
    document.getElementById('features-output').innerHTML =
      features.map(f =>
        '<div class="feat-item"><span style="color:var(--green)">&#x2713;</span> ' + esc(f.name) + '</div>'
      ).join('');
  } catch (err) {
    document.getElementById('features-output').innerHTML =
      '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('features', false);
}

async function fetchPackages() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;

  showLoading('packages', true);
  try {
    const text = await adbShell(info.adb, 'pm list packages -3');

    const pkgs = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const name = trimmed.replace(/^package:/, '').trim();
      if (name) pkgs.push({ name });
    }
    dataCache.packages = pkgs;

    document.getElementById('packages-count').textContent = '(' + pkgs.length + ')';
    document.getElementById('packages-output').innerHTML =
      '<div class="prop-count">Third-party packages: ' + pkgs.length + '</div>' +
      pkgs.map(p => '<div class="pkg-item">' + esc(p.name) + '</div>').join('');
  } catch (err) {
    document.getElementById('packages-output').innerHTML =
      '<span style="color:#ff5252">Error: ' + esc(String(err.message || err)) + '</span>';
  }
  showLoading('packages', false);
}

// --- Attestation ---
async function fetchAttestation() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;

  showLoading('attestation', true);
  try {
    // Run all checks in parallel
    const results = await Promise.allSettled([
      safeGetProp(info.adb, 'ro.boot.verifiedbootstate'),
      safeGetProp(info.adb, 'ro.boot.vbmeta.security_level'),
      safeGetProp(info.adb, 'ro.boot.veritymode'),
      safeGetProp(info.adb, 'ro.hardware.keystore'),
      safeGetProp(info.adb, 'ro.security.keystore'),
      safeGetProp(info.adb, 'ro.hardware.av'),
      adbShell(info.adb, 'pm list features').catch(() => ''),
    ]);

    const vals = results.map(r => r.value || '');
    const bootStateVal = vals[0].trim().toLowerCase();
    const securityLevelVal = vals[1].trim().toLowerCase();
    const verityVal = vals[2].trim().toLowerCase();
    const keystoreHW = vals[3].trim();
    const keystoreSec = vals[4].trim();
    const avHW = vals[5].trim();
    const featuresText = vals[6];

    // Check KeyMint / StrongBox
    const hasKeyMint = featuresText.includes('android.hardware.security.keymint');
    const hasStrongbox = featuresText.includes('strongbox');
    const strongboxDetail = hasStrongbox ? 'StrongBox' : (hasKeyMint ? 'KeyMint (TEE)' : 'Not detected');

    // AV hardware (for attestation)
    const avDetail = avHW || 'N/A';

    const rows = [
      ['Verified Boot State', bootStateVal || 'N/A', bootStateVal === 'orange' || bootStateVal === 'green' ? 'ok' : (bootStateVal ? 'warn' : 'unknown')],
      ['VBMeta Security Level', securityLevelVal || 'N/A', securityLevelVal === 'software' ? 'ok' : (securityLevelVal ? 'warn' : 'unknown')],
      ['DM-Verity Mode', verityVal || 'N/A', verityVal === 'enforce' ? 'ok' : (verityVal ? 'warn' : 'unknown')],
      ['KeyMint / StrongBox', strongboxDetail, hasKeyMint ? 'ok' : 'warn'],
      ['AV Hardware', avDetail, avHW ? 'ok' : 'warn'],
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
    // RKP checks
    const rkpProps = await Promise.all([
      safeGetProp(info.adb, 'ro.rkp.enabled'),
      safeGetProp(info.adb, 'ro.security.rkp'),
      safeGetProp(info.adb, 'ro.boot.rkp'),
      safeGetProp(info.adb, 'ro.hardware.rkp'),
    ]);

    // Check RKP-related packages
    let rkpPackages = [];
    try {
      const pkgs = await adbShell(info.adb, 'pm list packages');
      const rkpKeywords = ['rkp', 'remotek', 'remote.key', 'nfc.rkp', 'samsung.rkp'];
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
      const rkpFeatKeywords = ['rkp', 'remote.key', 'nfc'];
      for (const line of features.split('\n')) {
        const trimmed = line.trim();
        for (const kw of rkpFeatKeywords) {
          if (trimmed.toLowerCase().includes(kw)) {
            rkpFeatures.push(trimmed.replace(/^feature:/, ''));
          }
        }
      }
    } catch(e) {}

    const rkpEnabled = rkpProps[0] === 'true' || rkpProps[0] === '1';
    const rkpStatus = rkpEnabled ? 'ok' : (rkpProps[0] ? 'warn' : 'unknown');

    const rows = [
      ['RKP Enabled', rkpProps[0] || 'Not set', rkpStatus],
      ['RKP Security', rkpProps[1] || 'Not set', 'unknown'],
      ['RKP Boot', rkpProps[2] || 'Not set', 'unknown'],
      ['RKP Hardware', rkpProps[3] || 'Not set', 'unknown'],
      ['RKP Packages', rkpPackages.length > 0 ? rkpPackages.join(', ') : 'None detected', rkpPackages.length > 0 ? 'ok' : 'warn'],
      ['RKP Features', rkpFeatures.length > 0 ? rkpFeatures.join(', ') : 'None detected', rkpFeatures.length > 0 ? 'ok' : 'warn'],
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

// --- Export JSON ---
function exportJSON(type) {
  let data, filename, json;

  switch(type) {
    case 'props':
      json = { ro_property: dataCache.props.map(p => ({ name: p.name, value: p.value })) };
      filename = 'PropertyDeviceInfo.deviceinfo.json';
      break;
    case 'features':
      json = { feature: dataCache.features.map(f => ({ name: f.name })) };
      filename = 'FeatureDeviceInfo.deviceinfo.json';
      break;
    case 'packages':
      json = { package: dataCache.packages.map(p => ({ name: p.name })) };
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

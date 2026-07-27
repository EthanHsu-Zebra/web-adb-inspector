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
const connectedDevices = new Map(); // serial -> { adb, usbDevice, transport }
let activeSerial = null;

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
    alert('Failed to connect: ' + err.message);
  }
}

async function connectDevice(usbDevice) {
  try {
    setStatus('Connecting...', 'connecting');

    // Open USB connection
    const connection = await usbDevice.connect();

    // Authenticate with ADB daemon
    const transport = await AdbDaemonTransport.authenticate({
      serial: usbDevice.serial || 'usb',
      connection,
      credentialStore,
      features: ADB_DAEMON_DEFAULT_FEATURES,
      initialDelayedAckBytes: ADB_DAEMON_DEFAULT_INITIAL_PAYLOAD_SIZE,
    });

    // Create ADB instance
    const adb = new Adb(transport);

    const serial = adb.serial;
    connectedDevices.set(serial, { adb, usbDevice, transport });

    // Load device name from properties
    let displayName = usbDevice.name || 'Android Device';
    try {
      const model = await adb.getProp('ro.product.model');
      const brand = await adb.getProp('ro.product.brand');
      displayName = brand + ' ' + model;
    } catch (_) { /* fallback */ }

    renderDeviceList();

    // Auto-select first device
    if (connectedDevices.size === 1) {
      selectDevice(serial);
    }

    setStatus('Connected', 'ok');
  } catch (err) {
    console.error('Connection failed:', err);
    setStatus('Connection failed: ' + err.message, 'err');
  }
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

  // Fetch data
  fetchProperties();
  fetchFeatures();
  fetchPackages();
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
    // Use shell command to get all properties
    const proc = await info.adb.subprocess.shell('getprop');
    const text = await readStream(proc.readable);

    const props = [];
    const regex = /\[([^\]]+):\s*([^\]]*)\]/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      props.push([m[1], m[2]]);
    }

    document.getElementById('props-output').innerHTML =
      props.map(([k, v]) =>
        '<span class="kv-key">' + esc(k) + '</span><span class="kv-val">' + esc(v) + '</span>'
      ).join('');
  } catch (err) {
    document.getElementById('props-output').innerHTML =
      '<span style="color:#ff5252">Error: ' + esc(err.message) + '</span>';
  }
  showLoading('props', false);
}

async function fetchFeatures() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;

  showLoading('features', true);
  try {
    const proc = await info.adb.subprocess.shell('pm list features');
    const text = await readStream(proc.readable);

    const features = text.split('\n').filter(l => l.trim()).map(l => l.replace(/^feature:/, '').trim());

    document.getElementById('features-output').innerHTML =
      features.map(f =>
        '<div class="feat-item"><span style="color:var(--green)">✓</span> ' + esc(f) + '</div>'
      ).join('');
  } catch (err) {
    document.getElementById('features-output').innerHTML =
      '<span style="color:#ff5252">Error: ' + esc(err.message) + '</span>';
  }
  showLoading('features', false);
}

async function fetchPackages() {
  const info = connectedDevices.get(activeSerial);
  if (!info) return;

  showLoading('packages', true);
  try {
    const proc = await info.adb.subprocess.shell('pm list packages -3');
    const text = await readStream(proc.readable);

    const pkgs = text.split('\n').filter(l => l.trim()).map(l => l.replace(/^package:/, '').trim());

    document.getElementById('packages-output').innerHTML =
      '<div style="margin-bottom:0.5rem;color:var(--muted);font-size:0.65rem;">Third-party packages (' + pkgs.length + ')</div>' +
      pkgs.map(p => '<div class="feat-item">' + esc(p) + '</div>').join('');
  } catch (err) {
    document.getElementById('packages-output').innerHTML =
      '<span style="color:#ff5252">Error: ' + esc(err.message) + '</span>';
  }
  showLoading('packages', false);
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
    const proc = await info.adb.subprocess.shell(cmd);
    const text = await readStream(proc.readable);
    output.textContent += text + '\n';
  } catch (err) {
    output.textContent += 'Error: ' + err.message + '\n';
  }

  output.scrollTop = output.scrollHeight;
}

function runCmd(cmd) {
  document.getElementById('shell-input').value = cmd;
  runShell();
}

// --- Utilities ---
function readStream(readable) {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    const reader = readable.getReader();
    const chunks = [];
    function read() {
      reader.read().then(({ done, value }) => {
        if (done) {
          resolve(chunks.join(''));
          return;
        }
        chunks.push(decoder.decode(value, { stream: true }));
        read();
      }).catch(reject);
    }
    read();
  });
}

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

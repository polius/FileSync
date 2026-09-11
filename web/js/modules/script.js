import { dom, showToast } from './dom.js';
import { User } from './webrtc/user.js';
import { registerServiceWorker, installSinkBadge, sinkState, activeMode } from './sink.js';
import { installIceModeBadge } from './webrtc/mode.js';

// Room ID
const room_id = window.location.pathname.substring(1)

// Store current user
var user;

// QR Code
var qr = new QRious({
  element: document.getElementById('transfer-qr-code'),
  background: 'transparent',
  size: 220,
  foreground: '#adb5db',
  level: 'H',
})

// Get theme mode
if (window.localStorage.getItem('mode') == 'light') {
  dom.theme_text.innerHTML = 'Light'
  dom.comic_img.src = "assets/comic.png"
  qr.set({foreground: '#212529'});
}

// Load app version from API. Cosmetic — never let it block or break app boot.
async function loadVersion() {
  try {
    const res = await fetch('/api/');
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.version) {
      document.getElementById('appVersion').textContent = `v${data.version}`;
    }
  } catch {}
}

// On Load
async function onLoad() {
  // Load version badge
  await loadVersion();

  // Check WebRTC browser compatibility
  if (typeof RTCPeerConnection === 'undefined') {
    dom.error_div.style.display = 'block'
    dom.error_message.innerHTML = 'Your browser does not support <a href="https://caniuse.com/?search=webrtc" target="_blank" style="color: inherit; text-decoration: underline;">WebRTC</a>.<br><span style="color: #6c757d; font-size: 14px; margin-top: 10px; display: inline-block;">Please use a modern browser such as Chrome or Firefox.</span>'
    return
  }

  // Register the Service Worker (no-op in insecure contexts).
  await registerServiceWorker();

  // Show the dev sink badge if a ?sink= override is active.
  installSinkBadge();

  // Show the dev ICE badge if a ?ice= override is active. Stacks above the sink
  // badge when both are present.
  installIceModeBadge();

  // Surface a one-time warning if the only sink available is the in-memory Blob fallback
  // (insecure HTTP context, non-localhost). Large files will OOM in this configuration.
  maybeShowInsecureContextWarning();

  // Create current user
  user = new User(room_id)

  // Host
  if (room_id.length == 0) {
    // Generate Room ID
    const new_room_id = generateRoomID()

    // Init UI Components
    dom.transfer_div.style.display = 'block'
    dom.transfer_url_value.textContent = `${window.location.origin}/${new_room_id}`
    dom.transfer_users_list_host_name.innerHTML = user.name + ' (You)'
    dom.transfer_users_count.innerHTML = ' (1)'
    dom.transfer_add_password.style.display = 'block';
    qr.set({value: dom.transfer_url_value.textContent});

    // Init peer connection. user.init throws on ICE-credential failure or any pre-
    // 'open' Peer error — surface that here so the host UI doesn't sit silently on
    // top of a half-initialized user._peer.
    try {
      await user.init(new_room_id)
    } catch (err) {
      console.warn('Host init failed:', err);
      dom.transfer_div.style.display = 'none'
      dom.connect_div.style.display = 'none'
      dom.error_div.style.display = 'block'
      dom.error_message.innerHTML = 'Could not start FileSync. Please check your connection and refresh the page.'
      return
    }
  }
  // Peer
  else {
    // Init UI Componente
    dom.connect_div.style.display = 'block'
    dom.transfer_url_value.textContent = `${window.location.origin}/${room_id}`
    qr.set({value: dom.transfer_url_value.textContent});

    // Init peer connection. See host-path comment above — same contract.
    try {
      await user.init()
    } catch (err) {
      console.warn('Peer init failed:', err);
      dom.connect_div.style.display = 'none'
      dom.error_div.style.display = 'block'
      dom.error_message.innerHTML = 'Could not start FileSync. Please check your connection and refresh the page.'
      return
    }

    // Connect to the room. user.connect rejects if the host is unreachable
    // (peer-unavailable, ICE failure, closed before open) — surface that as a
    // user-facing error instead of leaving the spinner up indefinitely.
    try {
      await user.connect(room_id)
    } catch (err) {
      console.warn('Failed to join room:', err);
      dom.connect_div.style.display = 'none'
      dom.error_div.style.display = 'block'
      dom.error_message.innerHTML = 'Could not reach the host. The room may no longer be active.'
    }
  }
}

// Theme
function themeClick() {
  if (dom.theme_text.innerHTML == 'Dark') {
    dom.theme_text.innerHTML = 'Light'
    document.documentElement.classList.remove("dark")
    document.documentElement.classList.add("light")
    document.documentElement.setAttribute('data-bs-theme', 'light')
    window.localStorage.setItem('mode', 'light')
    dom.comic_img.src = "assets/comic.png"
    qr.set({foreground: '#212529'});
  }
  else if (dom.theme_text.innerHTML == 'Light') {
    dom.theme_text.innerHTML = 'Dark'
    document.documentElement.classList.remove("light")
    document.documentElement.classList.add("dark")
    document.documentElement.setAttribute('data-bs-theme', 'dark')
    window.localStorage.setItem('mode', 'dark')
    dom.comic_img.src = "assets/comic-dark.png"
    qr.set({foreground: '#adb5db'});
  }
}

// About
function aboutClick() {
  if (dom.about_text.innerHTML == 'About') {
    dom.transfer_div.style.display = 'none'
    dom.about_div.style.display = 'block'
    dom.about_text.innerHTML = 'Go back'
  }
  else {
    dom.about_div.style.display = 'none'
    dom.about_text.innerHTML = 'About'
    dom.transfer_div.style.display = 'block'
  }
}

function addPassword() {
  const modal = new bootstrap.Modal(dom.password_modal)
  modal.show()
}

// Show / Hide password
function togglePasswordVisibility(input_name, button_show_name, button_hide_name) {
  var password_input = document.getElementById(input_name)
  var password_button_show = document.getElementById(button_show_name)
  var password_button_hide = document.getElementById(button_hide_name)
  if (password_input.type === "password") {
    password_input.type = "text"
    password_button_show.style.display = 'block'
    password_button_hide.style.display = 'none'
  } else {
    password_input.type = "password"
    password_button_show.style.display = 'none'
    password_button_hide.style.display = 'block'
  }
  password_input.focus()
}

// Confirm change password
function addPasswordSubmit() {
  user.password = dom.password_modal_value.value.trim()
  const modal = bootstrap.Modal.getInstance(dom.password_modal);
  modal.hide()
  dom.transfer_status_protected.style.display = user.password.length == 0 ? 'none' : 'inline-block'
  showToast(user.password.length == 0 ? 'Password removed.' : 'Password set.')
}

function connectWithPassword() {
  if (dom.password_input.value.trim().length == 0) {
    dom.password_error.style.display = 'block'
  }
  else {
    user.password = dom.password_input.value
    dom.password_error.style.display = 'none'
    dom.password_submit.setAttribute("disabled", "")
    dom.password_loading.style.display = 'inline-block'
    user.connect(room_id).catch((err) => {
      // Connection couldn't even be opened (host gone, ICE failure). Re-enable the
      // submit button so the user can retry or change room.
      console.warn('Password retry failed to connect:', err);
      dom.password_submit.removeAttribute("disabled")
      dom.password_loading.style.display = 'none'
      dom.password_error.style.display = 'block'
    })
  }
}

// Change name
function changeName() {
  dom.name_modal_value.value = ''

  const modal = new bootstrap.Modal(dom.name_modal)
  modal.show()
}

function changeNameSubmit() {
  // Update name
  user.changeName(dom.name_modal_value.value.trim())
}

// Copy Room url
function copyURL() {
  const url = dom.transfer_url_value.textContent;
  if (navigator.clipboard && window.isSecureContext) {
    // Secure context (HTTPS)
    navigator.clipboard.writeText(url)
  }
  else {
    // Fallback for HTTP
    const textarea = document.createElement("textarea");
    textarea.value = url;
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  showToast("URL copied.")
  dom.transfer_url_copy.style.display = 'none'
  dom.transfer_url_success.style.display = 'flex'

  setTimeout(() => {
    dom.transfer_url_success.style.display = 'none'
    dom.transfer_url_copy.style.display = 'flex'
  }, 1000)
}

// Send File
function sendFiles(event) {
  user.addFiles(event.files)
}

// Download all
function downloadAll() {
  user.downloadAll()
}

// Cancel download all
function cancelDownloadAll() {
  user.downloadAllCancel()
}

// Bind all event handlers. The CSP forbids inline handlers (script-src 'self'),
// so every element that used onclick/onkeypress/onchange in index.html is wired
// up here instead.
function bindUI() {
  const on = (id, event, fn) => document.getElementById(id)?.addEventListener(event, fn);
  const onEnter = (id, fn) => on(id, 'keydown', (e) => { if (e.key === 'Enter') fn(); });

  on('theme-text', 'click', themeClick);
  on('about-text', 'click', aboutClick);
  on('header-logo', 'click', () => { window.location.href = '/' });
  onEnter('password-input', connectWithPassword);
  on('password-input-toggle', 'click', () => togglePasswordVisibility('password-input', 'password-show', 'password-hide'));
  on('password-submit', 'click', connectWithPassword);
  on('transfer-url-row', 'click', copyURL);
  on('transfer-select-file', 'click', () => dom.transfer_select_file_input.click());
  on('transfer-select-file-input', 'change', (e) => sendFiles(e.target));
  on('transfer-add-password-btn', 'click', addPassword);
  on('transfer-users-change-name', 'click', changeName);
  on('transfer-files-download', 'click', downloadAll);
  onEnter('password-modal-value', addPasswordSubmit);
  on('password-modal-toggle', 'click', () => togglePasswordVisibility('password-modal-value', 'password-button-show', 'password-button-hide'));
  on('password-modal-confirm', 'click', addPasswordSubmit);
  onEnter('name-modal-value', changeNameSubmit);
  on('name-modal-confirm', 'click', changeNameSubmit);
  on('download-modal-cancel', 'click', cancelDownloadAll);
}

// Drag and Drop on transfer-div
function initDropZone() {
  const transferDiv = document.getElementById('transfer-div')
  if (!transferDiv) return

  // Prevent browser default drag behavior globally
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => e.preventDefault())

  let dragCounter = 0

  transferDiv.addEventListener('dragenter', (e) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter++
    transferDiv.classList.add('drag-over')
  })

  transferDiv.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })

  transferDiv.addEventListener('dragleave', (e) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter--
    if (dragCounter === 0) {
      transferDiv.classList.remove('drag-over')
    }
  })

  transferDiv.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter = 0
    transferDiv.classList.remove('drag-over')
    const files = e.dataTransfer.files
    if (files.length > 0) {
      user.addFiles(files)
    }
  })
}

// Function to generate a random string in the format XXX-XXXX-XXX.
function generateRoomID() {
  const length = 10
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const random = crypto.getRandomValues(new Uint8Array(length));
  let room_id = "";
  for (let i = 0; i < length; i++) {
    room_id += alphabet[random[i] % alphabet.length];
  }
  return `${room_id.slice(0, 3)}-${room_id.slice(3, 7)}-${room_id.slice(7, 10)}`;
}

function maybeShowInsecureContextWarning() {
  // Only warn when the auto path will land on Blob — i.e., not secure, not localhost.
  // Forced overrides skip the warning (developer knows what they're doing).
  if (sinkState.forced) return;
  if (activeMode() !== 'blob') return;
  if (window.isSecureContext) return;

  const banner = document.createElement('div');
  banner.id = 'insecure-context-banner';
  banner.innerHTML = `
    <strong>Heads-up:</strong> FileSync is running over plain HTTP, so large transfers may fail.
    For files over 500&nbsp;MB, please deploy FileSync with HTTPS — see the
    <a href="https://github.com/polius/filesync#option-b--https-public-domain-recommended" target="_blank" rel="noopener" style="color:inherit; text-decoration:underline;">HTTPS setup guide</a>.
    <span id="insecure-context-banner-close" style="margin-left:10px; cursor:pointer; font-weight:bold;">×</span>
  `;
  Object.assign(banner.style, {
    position: 'fixed', top: '0', left: '0', right: '0',
    padding: '10px 16px',
    backgroundColor: 'rgba(255, 193, 7, 0.95)',
    color: '#212529',
    fontSize: '14px', textAlign: 'center',
    zIndex: '9999',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  });
  document.body.appendChild(banner);
  // The banner is position:fixed, so push the page content down to leave a gap
  // between the banner and the UI instead of covering it.
  document.body.style.paddingTop = `${banner.offsetHeight}px`;
  document.getElementById('insecure-context-banner-close').onclick = () => {
    banner.remove();
    document.body.style.paddingTop = '';
  };
}

// On document loaded, execute onLoad() method.
(() => {
  bindUI()
  onLoad()
  initDropZone()
})();
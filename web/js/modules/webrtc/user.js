import { dom, showToast } from '../dom.js';
import { turn } from './turn.js';
import { applyIceMode } from './mode.js';
import { File } from './file.js';
import { Peer } from './peer.js';
import { openSink } from '../sink.js';
import { downloadZip } from '../../vendors/client-zip.min.js';

// Hard limits on user-controlled string fields received from the network. The display
// name and filename are interpolated into the DOM (always via textContent — see XSS
// hardening below); the id fields are used as DOM id suffixes and in inline event
// handlers, so they must match a strict charset.
const _ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const _MAX_NAME_LEN = 200;
const _MAX_FILENAME_LEN = 1024;

const _isValidId = (s) => typeof s === 'string' && _ID_RE.test(s);
const _sanitizeName = (s, max = _MAX_NAME_LEN) =>
  (typeof s === 'string' ? s : '').slice(0, max);

// Filenames end up in zip entries and Content-Disposition headers, so strip path
// separators and control characters — a hostile sender must not be able to place
// a download outside the intended location.
const _sanitizeFilename = (s) => {
  const base = _sanitizeName(s, _MAX_FILENAME_LEN).split(/[\\/]+/).pop() || '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '');
  return (clean === '.' || clean === '..' || clean === '') ? 'file' : clean;
};

// Cap on simultaneous outbound file transfers from a single sender. Each in-flight
// transfer opens its own RTCPeerConnection + DataChannel; an unbounded fan-out in a
// busy room can exhaust the sender's browser (Chrome's per-page PC cap is ~256, and
// each DC carries a ~16 MiB SCTP buffer). 5 is enough to saturate typical upstream
// bandwidth while leaving comfortable headroom; excess requests are queued and the
// receivers are told they're waiting.
const _OUTBOUND_CONCURRENCY_CAP = 5;

// _files/_remotePeers are keyed by wire-supplied ids, and the signaling charset
// allows '__proto__'. Null-prototype objects keep a crafted id from resolving to
// Object.prototype members.
const _makeWireMap = () => Object.create(null);

export class User {
  _name = this._generate_name();
  _password = '';
  _peer = null;
  _remotePeers = _makeWireMap();
  _room_id;
  _isHost;
  _files = _makeWireMap();
  _status;
  _downloadAll;
  _reconnectAttempts = 0;
  _reconnectTimer = null;
  // Outbound-transfer fan-out control. See _OUTBOUND_CONCURRENCY_CAP.
  _outboundActive = 0;
  _outboundQueue = [];  // each entry is the original `data` from webrtc-file-download

  constructor(room_id) {
    this._room_id = room_id;
    this._isHost = room_id.length == 0;
  }

  get id() {
    return this._peer.id
  }

  get name() {
    return this._name
  }

  get password() {
    return this._password
  }

  get isHost() {
    return this._isHost
  }

  get files() {
    return this._files
  }

  set password(value) {
    this._password = value
  }

  async _hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
  }

  async init(peer_id = null) {
    // Get UUID. A fetch failure here just propagates — caller (script.js onLoad)
    // is responsible for showing the user-facing error.
    if (peer_id == null) peer_id = await this._getUUID();

    // Get ICE servers. Don't reach into the global error_div from here — let the
    // caller decide. Symmetric to file.init's contract after Round-3.
    let iceServers;
    try {
      iceServers = await turn.getServers();
    } catch (err) {
      console.warn('user.init: failed to get ICE servers:', err);
      throw err;
    }

    await new Promise((resolve, reject) => {
      // Create a new Peer instance
      const isSecure = window.location.protocol === 'https:';
      this._peer = new Peer(peer_id, {
        host: window.location.hostname,
        port: parseInt(window.location.port) || (isSecure ? 443 : 80),
        secure: isSecure,
        config: applyIceMode({ iceServers }),
      });

      // Settle init exactly once. Pre-'open' errors fail init outright so the caller
      // can show a fatal-error UI instead of having `await user.init()` hang while
      // _scheduleReconnect spins quietly in the background.
      let settled = false;
      const settle = (cb, arg) => { if (settled) return; settled = true; cb(arg); };

      // Emitted when a connection to the PeerServer is established.
      this._peer.on('open', () => {
        // Reset reconnect bookkeeping on every (re-)open. Only the first open
        // settles init; subsequent ones (reconnect after a blip) keep the existing
        // resolve a no-op.
        this._reconnectAttempts = 0;
        if (this._reconnectTimer) {
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = null;
        }
        if (!settled) this._handleOpen(() => settle(resolve));
      });

      // Emitted when a new data connection is established from a remote peer.
      this._peer.on('connection', (conn) => conn.on('open', () => this._handleConnection(conn)));

      // Emitted when the peer is disconnected from the signaling server.
      this._peer.on('disconnected', () => this._handleDisconnected());

      // Errors on the peer. Pre-'open' errors fail init (caller bails). Post-'open'
      // errors go to the normal handler so the reconnect/fatal-UI paths keep
      // working for an already-established session.
      this._peer.on('error', (err) => {
        if (settled) {
          this._handleError(err);
        } else {
          // Destroy the half-initialized Peer so its signaling WebSocket isn't left
          // dangling. The caller will null its own reference to user._peer.
          try { this._peer?.destroy(); } catch {}
          settle(reject, err);
        }
      });
    })
  }

  async connect(peer_id) {
    await new Promise((resolve, reject) => {
      // Establish a connection with the host.
      const conn = this._peer.connect(peer_id);

      // Settle exactly once. Listening for error/close in addition to open guarantees
      // we don't hang here forever when the host is unreachable (peer-unavailable,
      // ICE failure) — the caller in script.js can then show an error UI.
      let settled = false;
      const settle = (cb, arg) => { if (settled) return; settled = true; cb(arg); };

      conn.on('open', () => this._handleConnection(conn, () => settle(resolve)));
      conn.on('error', (err) => settle(reject, err));
      conn.on('close', () => settle(reject, new Error('Connection closed before open.')));
    })
  }

  _isAlive(peer_id) {
    const peer = this._remotePeers[peer_id];
    if (peer === undefined) return;
    const pc = peer.conn ? peer.conn.peerConnection : null;
    const state = pc ? pc.iceConnectionState : null;
    // 'failed'/'closed' (and a null pc) are terminal. 'disconnected' is often transient
    // and can recover, so only treat it as gone after a short grace window — otherwise a
    // brief blip would drop a peer that WebRTC would have reconnected on its own.
    peer.disconnectedSince = state === 'disconnected' ? (peer.disconnectedSince || Date.now()) : null;
    const gaveUp = peer.disconnectedSince && (Date.now() - peer.disconnectedSince) > 4000;
    if (pc === null || state === 'failed' || state === 'closed' || gaveUp) {
      clearInterval(peer.interval);
      peer.interval = null;
      this._handleClose(peer.conn);
    }
  }

  // Emitted when a connection to the PeerServer is established. 
  _handleOpen(resolve) {
    resolve()
  }

  // Handles disconnection from the signaling server.
  _handleDisconnected() {
    if (this._peer.destroyed) return;
    console.warn('Lost connection to signaling server. Attempting to reconnect...');
    this._scheduleReconnect();
  }

  // Schedules a reconnection attempt with exponential backoff.
  _scheduleReconnect() {
    // Guard: skip if a reconnect timer is already pending
    if (this._reconnectTimer) return;

    // Cannot reconnect a destroyed peer
    if (this._peer.destroyed) {
      this._showFatalError('Lost connection to server. Please refresh the page.');
      return;
    }

    const maxAttempts = 5;
    if (this._reconnectAttempts >= maxAttempts) {
      console.error(`Failed to reconnect after ${maxAttempts} attempts.`);
      this._showFatalError('Lost connection to server. Please refresh the page.');
      return;
    }

    const delay = 1000 * Math.pow(2, this._reconnectAttempts);
    this._reconnectAttempts++;
    console.warn(`Reconnect attempt ${this._reconnectAttempts}/${maxAttempts} in ${delay}ms...`);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._peer.destroyed) {
        this._showFatalError('Lost connection to server. Please refresh the page.');
        return;
      }
      this._peer.reconnect();
    }, delay);
  }

  // Shows the fatal error page.
  _showFatalError(message) {
    dom.transfer_div.style.display = 'none';
    dom.connect_div.style.display = 'none';
    dom.error_div.style.display = 'block';
    dom.error_message.innerHTML = message;
  }

  // Change user's name
  changeName(value) {
    // Check if name is empty
    if (!value || value.length === 0) {
      showToast('Name cannot be empty.', 'warning')
      dom.name_modal_value.focus()
      return
    }

    // Clamp to a sane length before doing anything else — defends downstream renderers
    // and matches the limit we apply to inbound names from other peers.
    value = _sanitizeName(value);

    // Check if there is another user with the same name
    const duplicated = Object.entries(this._remotePeers).some(([k, v]) => v.name == value && k != this._peer.id)
    if (duplicated) {
      showToast('This name already exists.', 'warning')
      dom.name_modal_value.focus()
      return
    }

    // Update user
    this._name = value

    // Update files
    for (let f of Object.values(this._files)) {
      if (f.owner_id == this._peer.id) {
        f.owner_name = this._name
        this._setFileInfoText(f)
      }
    }

    if (this._isHost) {
      // Update UI
      document.getElementById('transfer-users-list-host-name').textContent = `${this._name} (You)`

      // Notify all peers
      const peers_list = [{"id": this._peer.id, "name": this._name }, ...Object.entries(this._remotePeers).map(([k, v]) => ({"id": k, "name": v.name}))];
      for (let p of Object.values(this._remotePeers)) {
        p.conn.send({'webrtc-peers': peers_list})
      }
    }
    else {
      // Update UI
      document.getElementById(`user-${this._peer.id}-name`).textContent = `${this._name} (You)`

      // Notify Host
      this._remotePeers[this._room_id].conn.send({'webrtc-user-name': {"id": this._peer.id, "name": this._name}})
    }

    // Close modal
    const modal = bootstrap.Modal.getInstance(dom.name_modal);
    modal.hide()
    showToast(`Name changed to ${this._name}.`)
  }

  // Add one or multiple file to be transferred to all peers
  async addFiles(files) {
    let data = []
    const skippedNames = []
    for (const file of files) {
      // Sanitize up front so the duplicate check, the UI, and the wire metadata all
      // agree on the exact name that will be downloaded.
      const name = _sanitizeFilename(file.name);

      // Check for duplicate file (same name and size already shared by you)
      const isDuplicate = Object.values(this._files).some(
        (existing) => existing.name === name && existing.size === file.size && !existing.removed && existing.owner_id === this._peer.id
      )
      if (isDuplicate) {
        skippedNames.push(name)
        continue
      }

      // Parse file
      const fileData = {
        "id": await this._getUUID(),
        "name": name,
        "size": file.size,
        "content": file,
        "owner_id": this._peer.id,
        "owner_name": this._name,
      };

      // Create file instance
      const f = new File(fileData);

      // Add file to the current user
      this._files[f.id] = f

      // Add file to the list
      this._addFileUI(f)

      // Store file to be send to other peers
      data.push({"id": f.id, "name": f.name, "size": f.size, "owner_id": f.owner_id, "owner_name": f.owner_name})
    }

    // Show toast for added files
    if (data.length > 0) {
      const msg = data.length === 1
        ? `File "${data[0].name}" added.`
        : `${data.length} files added.`
      showToast(msg)
    }

    // Show toast for skipped duplicates
    if (skippedNames.length > 0) {
      const msg = skippedNames.length === 1
        ? `File "${skippedNames[0]}" is already added.`
        : `${skippedNames.length} files were already added.`
      showToast(msg, 'warning')
    }

    // Send file to all remote peers (If host, then all peers. If peer, then to the host).
    // Never broadcast an empty list — receivers validate strictly and an empty
    // payload is useless anyway.
    if (data.length === 0) return;
    for (let peer of Object.values(this._remotePeers)) {
      if ('conn' in peer) peer.conn.send({"webrtc-file-add": data})
    }
  }

  // Remove a file shared by you
  removeFile(fileId) {
    this._files[fileId]._aborted = true
    this._files[fileId]._removed = true
    // Stop any in-flight outbound transfers immediately (the send loop checks both the
    // file-level _aborted and the per-receiver aborted flag).
    for (const p of Object.values(this._files[fileId]._remotePeers)) p.aborted = true

    // Notify all peers
    for (let peer of Object.values(this._remotePeers)) {
      if ('conn' in peer) peer.conn.send({'webrtc-file-remove': {"peer_id": this._peer.id, "file_id": fileId}})
    }
    // Update UI
    document.getElementById(`file-${fileId}-remove`).style.display = 'none'
    document.getElementById(`file-${fileId}-icon-loading`).style.display = 'none'
    document.getElementById(`file-${fileId}-icon-success`).style.display = 'none'
    document.getElementById(`file-${fileId}-icon-failed`).style.display = 'none'
    document.getElementById(`file-${fileId}-error`).style.display = 'block'
    document.getElementById(`file-${fileId}-error`).innerHTML = 'You have removed this file.'
    showToast(`File "${this._files[fileId].name}" removed.`)
  }

  // Download a file shared by another peer
  async downloadFile(fileId) {
    const file = this._files[fileId];
    if (!file) return;

    // Guard against double-trigger races. Two paths can collide:
    //   1. Double-click on the Download button before openSink resolves → two save
    //      pickers, two SW iframes, two per-file Peers.
    //   2. Clicking Download mid-downloadAll → the file is already wired into the zip
    //      iterator (_zip=true, _zipController set). A second sink would be opened but
    //      never written to (_onChunk routes to the zip controller), leaking a save
    //      dialog or SW iframe.
    if (file.in_progress || this._downloadAll?.active) {
      showToast('This file is already downloading.', 'warning');
      return;
    }

    // Clear any abort state from a prior attempt so this fresh download starts clean.
    file._aborted = false;

    // Open the sink first, inside the user-gesture window. All sink modes are opened
    // here, before any WebRTC work:
    //   - FS Access needs a transient user gesture to show the save picker.
    //   - SW needs the iframe navigation to fire from a click (popup-blocker friendly).
    //   - Blob is gesture-independent but uses the same path for consistency.
    // The receiver-side _onHeader uses this pre-opened sink as-is — it must not open a
    // second one (would cause two save pickers / two browser downloads).
    try {
      file._sink = await openSink({
        id: file.id,
        name: file.name,
        size: file.size,
        mime: 'application/octet-stream',
      });
      // If the user cancels the browser download (closes the download tray / deletes
      // the in-progress entry), the SW sink fires this hook — propagate it as a
      // transfer abort so the sender stops pumping bytes into a dead stream.
      if (file._sink && 'mode' in file._sink) file._sink._onCancel = () => file.abort();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        // User dismissed the save picker — silently restore the UI.
        return;
      }
      console.error('Failed to open sink:', err);
      const errEl = document.getElementById(`file-${fileId}-error`);
      if (errEl) {
        errEl.style.display = 'block';
        errEl.innerHTML = 'Could not start the download. Please try again.';
      }
      return;
    }

    // Mark the file as in-progress now that we hold an open sink. This lets
    // file._handleClose() recognize that a clean abort + sink teardown is needed if the
    // sender disconnects before the transfer header arrives.
    file.in_progress = true;

    // Update UI: Remove Download button and add loading icon
    document.getElementById(`file-${fileId}-download`).style.display = 'none'
    document.getElementById(`file-${fileId}-error`).innerHTML = ''
    document.getElementById(`file-${fileId}-error`).style.display = 'none'
    document.getElementById(`file-${fileId}-abort`).style.display = 'block'
    document.getElementById(`file-${fileId}-icon-success`).style.display = 'none'
    document.getElementById(`file-${fileId}-icon-failed`).style.display = 'none'
    document.getElementById(`file-${fileId}-icon-loading`).style.display = 'block'
    document.getElementById(`file-${fileId}-progress`).innerHTML = '0% | '

    // Init Peering connection to receive the file. file.init now throws on
    // ICE-server failure or signaling-server unreachability — without the catch,
    // dereferencing file.peer.id below would throw and the row would stay stuck
    // on the loading spinner.
    try {
      await file.init()
    } catch (err) {
      console.warn('downloadFile: file.init failed:', err);
      this._abortDownloadStart(file, fileId, 'Could not start the download. Please try again.');
      return;
    }

    // If it's the host redirect the request to the Origin's Peer. Otherwise send the request to the Host.
    const target = this._remotePeers[this._isHost ? file.owner_id : this._room_id];
    if (!target || !target.conn) {
      // The owner/host vanished between the click and the send — roll back cleanly
      // instead of throwing on a missing connection.
      console.warn('downloadFile: routing peer is gone for file', fileId);
      this._abortDownloadStart(file, fileId, 'The sender is no longer connected. Please try again.');
      return;
    }
    target.conn.send({'webrtc-file-download': {"file_id": fileId, "requester_id": this._peer.id, "requester_name": this._name, "peer_id": file.peer.id}})
  }

  // Roll back a download that failed before any bytes flowed: release the sink and
  // per-file peer state, then restore the row UI with an error message.
  _abortDownloadStart(file, fileId, message) {
    if (file._sink) {
      file._sink.abort('start-failed').catch(() => {});
      file._sink = null;
    }
    file._peer = null;
    file.in_progress = false;

    const errEl = document.getElementById(`file-${fileId}-error`);
    if (errEl) {
      errEl.style.display = 'block';
      errEl.innerHTML = message;
    }
    const dl = document.getElementById(`file-${fileId}-download`);
    const abortEl = document.getElementById(`file-${fileId}-abort`);
    const loading = document.getElementById(`file-${fileId}-icon-loading`);
    if (dl) dl.style.display = 'block';
    if (abortEl) abortEl.style.display = 'none';
    if (loading) loading.style.display = 'none';
  }

  // Abort a file that is already being downloaded
  abortFile(fileId) {
    // Abort the file transfer
    this._files[fileId].abort()

    // Update UI
    document.getElementById(`file-${fileId}-abort`).style.display = 'none'
    document.getElementById(`file-${fileId}-download`).style.display = 'block'
    document.getElementById(`file-${fileId}-icon-loading`).style.display = 'none'
    document.getElementById(`file-${fileId}-icon-failed`).style.display = 'none'
    document.getElementById(`file-${fileId}-error`).style.display = 'block'
    document.getElementById(`file-${fileId}-error`).innerHTML = 'You have stopped the file transfer.'
  }

  // See file details
  showFileDetails(fileId) {
    // Compute data
    this.getFileDetails(fileId);

    // Show modal
    const modal = new bootstrap.Modal(dom.file_modal)
    modal.show()
  }

  getFileDetails(fileId) {
    // Hydrate details with the user's online status.
    let details = Object.entries(this._files[fileId].details).reduce((acc, [k, v]) => {
      acc[k] = {...v, online: k in this._remotePeers};
      return acc;
    }, {});

    // Set Refresh button handler
    dom.file_modal_refresh.onclick = () => {
      this.getFileDetails(fileId)
    };

    // Update UI
    const hasDetails = Object.values(details).length > 0
    dom.file_modal_table_empty.style.display = hasDetails ? 'none' : 'block'
    dom.file_modal_table.style.display = hasDetails ? 'table' : 'none'
    const tableWrap = document.getElementById('file-modal-table-wrap')
    if (tableWrap) tableWrap.style.display = hasDetails ? 'block' : 'none'

    // Build table imperatively so user.user_name is inserted via textContent rather
    // than concatenated into an HTML string.
    const tbody = dom.file_modal_table.querySelector('tbody');
    tbody.innerHTML = '';
    for (let user of Object.values(details)) {
      const statusColor = user.progress == 100 ? '#198754' : user.aborted ? '#DC3545' : '#0d6efd';
      const statusLabel = user.progress == 100 ? 'Completed' : user.aborted ? 'Stopped' : 'In progress';
      const statusBg    = user.progress == 100 ? 'rgba(25,135,84,0.1)' : user.aborted ? 'rgba(220,53,69,0.1)' : 'rgba(13,110,253,0.1)';
      const onlineColor = user.online ? '#198754' : '#DC3545';
      const onlineRing  = user.online ? 'rgba(25,135,84,0.2)' : 'rgba(220,53,69,0.2)';

      const tr = document.createElement('tr');

      const nameTd = document.createElement('td');
      nameTd.style.cssText = 'padding:12px 16px; font-weight:500; font-size:14px; color:var(--color-h1); vertical-align:middle; border-bottom:1px solid var(--color-border);';
      nameTd.textContent = user.user_name;
      tr.appendChild(nameTd);

      const progressTd = document.createElement('td');
      progressTd.style.cssText = 'padding:12px 16px; vertical-align:middle; border-bottom:1px solid var(--color-border); min-width:120px;';
      progressTd.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px;">
          <div style="flex:1; height:6px; background-color:var(--color-card-header-bg); border-radius:3px; overflow:hidden;">
            <div style="width:${user.progress}%; height:100%; background-color:${statusColor}; border-radius:3px; transition:width 0.3s ease;"></div>
          </div>
          <span style="font-size:13px; font-weight:500; color:var(--color-muted); min-width:32px; text-align:right;">${user.progress}%</span>
        </div>
      `;
      tr.appendChild(progressTd);

      const statusTd = document.createElement('td');
      statusTd.style.cssText = 'padding:12px 16px; vertical-align:middle; border-bottom:1px solid var(--color-border);';
      const statusBadge = document.createElement('span');
      statusBadge.style.cssText = `display:inline-block; padding:3px 10px; font-size:12px; font-weight:600; color:${statusColor}; background-color:${statusBg}; border-radius:20px;`;
      statusBadge.textContent = statusLabel;
      statusTd.appendChild(statusBadge);
      tr.appendChild(statusTd);

      const onlineTd = document.createElement('td');
      onlineTd.style.cssText = 'padding:12px 16px; vertical-align:middle; text-align:center; border-bottom:1px solid var(--color-border);';
      const onlineDot = document.createElement('span');
      onlineDot.style.cssText = `display:inline-block; width:10px; height:10px; border-radius:50%; background-color:${onlineColor}; box-shadow:0 0 0 3px ${onlineRing};`;
      onlineTd.appendChild(onlineDot);
      tr.appendChild(onlineTd);

      tbody.appendChild(tr);
    }
  }

  async downloadAll() {
    // Init UI Components
    dom.download_modal_value.innerHTML = '0%'
    dom.download_modal_active.querySelector('.progress-bar').style.width = '0%'
    dom.download_modal_active.style.display = 'flex'
    dom.download_modal_success.style.display = 'none'
    dom.download_modal_error.style.display = 'none'
    dom.download_modal_close.style.display = 'none'
    dom.download_modal_cancel.style.display = 'block'
    dom.download_modal_cancel.removeAttribute("disabled")
    dom.download_modal_cancel_spinner.style.display = 'none'

    // Get available files to download
    const files = Object.values(this._files).filter(x => x.owner_id != this._peer.id && !x.removed)

    if (files.length == 0) {
      showToast("There are no files to be downloaded.", 'warning')
      return
    }

    const inProgress = Object.values(this._files).some(x => x.in_progress)
    if (inProgress) {
      showToast("Files are still downloading.", 'warning')
      return
    }

    // Open the sink for files.zip up-front, within the user-gesture window.
    let zipSink;
    try {
      zipSink = await openSink({
        id: `bundle-${Date.now()}`,
        name: 'files.zip',
        size: undefined,
        mime: 'application/zip',
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.error('Failed to open sink for zip:', err);
      showToast('Could not start the download.', 'warning');
      return;
    }

    // Show download all modal (only after the save dialog is confirmed)
    const modal = new bootstrap.Modal(dom.download_modal, {
      backdrop: 'static',
      keyboard: false,
    })
    modal.show()

    this._downloadAll = {
      active: true,
      aborted: false,
      file: null,
      current: 0,
      sizes: files.map(x => x.size),
      interval: setInterval(() => this._downloadAllProgress(), 500),
    };

    // Wire browser-side cancel AFTER _downloadAll state is initialized — the hook
    // calls downloadAllCancel() which reads this._downloadAll. (downloadAllCancel
    // handles the UI-button path; this covers the download-tray path.)
    if (zipSink && 'mode' in zipSink) zipSink._onCancel = () => this.downloadAllCancel();

    // Async iterator that pulls one file at a time. client-zip advances to the next
    // file only after fully consuming the previous file's ReadableStream — which
    // matches our serial transfer model exactly.
    const self = this;
    async function* filesIterator() {
      for (const file of files) {
        if (file.removed) self._downloadAll.active = false;
        if (!self._downloadAll.active) break;

        self._downloadAll.file = file;
        self._downloadAll.current += 1;

        // Each file gets its own ReadableStream; the controller is handed to the
        // File instance so its WebRTC receive path can enqueue chunks directly.
        let controller;
        const stream = new ReadableStream({
          start(c) { controller = c; },
          cancel() {
            file._aborted = true;
            self._downloadAll.active = false;
          },
        });
        file.setZipController(controller);
        file.zip = true;
        file.in_progress = true;
        file._aborted = false;  // fresh start; stream cancel() re-sets this

        try {
          await file.init();
        } catch (err) {
          console.error('File init failed:', err);
          self._downloadAll.active = false;
          break;
        }

        // Kick the sender off.
        const target = self._remotePeers[self._isHost ? file.owner_id : self._room_id];
        if (!target || !target.conn) {
          console.error('downloadAll: routing peer is gone for file', file.id);
          self._downloadAll.active = false;
          break;
        }
        target.conn.send({
          'webrtc-file-download': {
            file_id: file.id,
            requester_id: self._peer.id,
            requester_name: self._name,
            peer_id: file.peer.id,
          },
        });

        yield { name: file.name, input: stream, lastModified: new Date() };
        // When yield returns, client-zip has fully consumed this file's stream
        // (controller was closed by file._onEnd). Move on to the next.
      }
    }

    // Pipe the zip stream into the chosen sink.
    let success = false;
    try {
      const zipResponse = downloadZip(filesIterator());
      const reader = zipResponse.body.getReader();
      while (true) {
        if (!this._downloadAll.active) {
          try { await reader.cancel('user-aborted'); } catch {}
          break;
        }
        const { value, done } = await reader.read();
        if (done) break;
        await zipSink.write(value);
      }
      if (this._downloadAll.active) {
        await zipSink.close();
        success = true;
        // Release the guard so subsequent single-file downloads aren't blocked
        // (downloadFile checks _downloadAll?.active). The progress interval's next
        // tick clears itself and the 100% branch renders the success UI.
        this._downloadAll.active = false;
      } else {
        await zipSink.abort('user-aborted');
      }
    } catch (err) {
      console.error('Zip stream failed:', err);
      try { await zipSink.abort(String(err)); } catch {}
      this._downloadAll.active = false;
    } finally {
      // Tear down the in-flight file's per-file peer/connection so a cancel doesn't leak
      // its signaling socket — the zip orchestration above doesn't otherwise close it.
      const inflight = this._downloadAll.file;
      if (inflight) {
        try { if (inflight._conn) inflight._conn.close(); } catch {}
        try { if (inflight._peer) inflight._peer.destroy(); } catch {}
        inflight._conn = null;
        inflight._peer = null;
        inflight._in_progress = false;
      }
      for (const f of Object.values(this._files)) {
        f.zip = false;
        f.setZipController(null);
      }
    }

    if (!success && !this._downloadAll.aborted) {
      // Surface the failure in the progress modal.
      this._downloadAll.active = false;
    }
  }

  downloadAllCancel() {
    // Defensive: ignore late cancels after the run has completed and _downloadAll has
    // been reset (e.g., a browser-side cancel that fires moments after a successful
    // close — see openSwSink _onCancel wiring).
    if (!this._downloadAll) return;

    // Abort the downloadAll operation
    this._downloadAll.active = false
    this._downloadAll.aborted = true

    // Update UI
    dom.download_modal_cancel.setAttribute("disabled", "")
    dom.download_modal_cancel_spinner.style.display = 'inline-block'
  }

  _downloadAllProgress() {
    // Abort file transfer
    if (!this._downloadAll.active) {
      clearInterval(this._downloadAll.interval)
    }

    // Compute overall progress (guard for the brief window before the first file starts)
    const totalSize = this._downloadAll.sizes.reduce((acc, size) => acc + size, 0);
    const currentTransferred = this._downloadAll.file ? this._downloadAll.file.transferred : 0;
    const totalTransferred = this._downloadAll.sizes.slice(0, Math.max(0, this._downloadAll.current - 1)).reduce((acc, size) => acc + size, 0) + currentTransferred;
    const overallProgress = totalSize > 0 ? (totalTransferred / totalSize) * 100 : 0;

    // Update UI
    dom.download_modal_value.innerHTML = `${Math.floor(overallProgress)}%`
    dom.download_modal_active.querySelector('.progress-bar').style.width = `${Math.floor(overallProgress)}%`

    if (overallProgress == 100) {
      clearInterval(this._downloadAll.interval)
      dom.download_modal_active.style.display = 'none'
      dom.download_modal_success.style.display = 'flex'
      dom.download_modal_cancel.style.display = 'none'
      dom.download_modal_close.style.display = 'block'
    }
    else if (!this._downloadAll.active && !this._downloadAll.aborted) {
      dom.download_modal_active.style.display = 'none'
      dom.download_modal_error.style.display = 'block'
      dom.download_modal_error.querySelector('.progress-bar').style.width = `${Math.floor(overallProgress)}%`
      dom.download_modal_cancel.style.display = 'none'
      dom.download_modal_close.style.display = 'block'
    }
    else if (this._downloadAll.aborted) {
      const modal = bootstrap.Modal.getInstance(dom.download_modal);
      setTimeout(() => modal.hide(), 1000)
    }
  }

  // Emitted when the connection is established and ready-to-use (a peer connects to the host).
  async _handleConnection(conn, resolve) {
    // Emitted when data is received from the remote peer.
    conn.on('data', (data) => this._handleData(conn, data));

    // Emitted when either you or the remote peer closes the data connection.
    conn.on('close', () => this._handleClose(conn));

    // Emitted when there is an unexpected error in the data connection.
    conn.on('error', (err) => this._handleError(err));

    if (!this._isHost) {
      // A retry (e.g. wrong room password) opens a new DataConnection for the same
      // peer id — drop the previous entry's liveness interval or it leaks.
      const prev = this._remotePeers[conn.peer];
      if (prev?.interval) clearInterval(prev.interval);

      // Store Host Peer connection
      this._remotePeers[conn.peer] = {"conn": conn, "interval": setInterval(() => this._isAlive(conn.peer), 1000)}

      // Send credentials to the host to authenticate
      if (!this._password) {
        conn.send({"webrtc-connect": {"name": this._name}})
      }
      else {
        const hashedPassword = await this._hashPassword(this._password);
        conn.send({"webrtc-connect": {"name": this._name, "password": hashedPassword}})
      }
    }

    // Resolve promise for .connect() method (a peer connects to the host)
    if (resolve !== undefined) resolve()
  }

  // Emitted when data is received from the remote peer.
  async _handleData(conn, data) {
    if ('webrtc-connect' in data && this._isHost) {
      const hello = data['webrtc-connect'];
      if (!hello || typeof hello !== 'object' || Array.isArray(hello) || typeof hello.name !== 'string') return;
      if (this._password.length != 0 && !('password' in hello)) {
        conn.send({'webrtc-connect-response': {"status": "password_required"}})
      }
      else if (this._password.length != 0 && await this._hashPassword(this._password) != hello['password']) {
        conn.send({'webrtc-connect-response': {"status": "password_invalid"}})
      }
      else {
        // Add peer to the peers list. Clamp the inbound name to a sane length; it's
        // user-controlled and gets rendered in every connected peer's DOM.
        const cleanName = _sanitizeName(data['webrtc-connect']['name']);

        // A retry from the same peer id replaces the entry — clear the old interval
        // first or it leaks (see the peer-side comment above).
        const prev = this._remotePeers[conn.peer];
        if (prev?.interval) clearInterval(prev.interval);

        this._remotePeers[conn.peer] = {"name": cleanName, "conn": conn,  "interval": setInterval(() => this._isAlive(conn.peer), 1000)}

        // Show peer connected status
        dom.transfer_status_wait.style.display = 'none'
        dom.transfer_status_success.style.display = 'inline-block'

        // Define peers list (including host user)
        const peers_list = [{"id": this._peer.id, "name": this._name }, ...Object.entries(this._remotePeers).map(([k, v]) => ({"id": k, "name": v.name}))];

        // Build user's list. conn.peer is the remote's peer id — already validated by
        // the signaling server's id-format check at /ws register time.
        this._addUserUI({"id": conn.peer, "name": this._remotePeers[conn.peer].name})

        // Send confirmation
        conn.send({'webrtc-connect-response': {"status": "welcome", "secured": this._password.trim().length != 0}})

        // Notify all peers
        for (let p of Object.values(this._remotePeers)) {
          p.conn.send({'webrtc-peers': peers_list, 'webrtc-files': Object.values(this._files).filter(x => !x.aborted && !x.removed).map(x => x.file)})
        }
      }
    }
    else if ('webrtc-connect-response' in data && !this._isHost) {
      const response = data['webrtc-connect-response'];
      if (!response || typeof response !== 'object' || Array.isArray(response)) return;
      this._status = response
      if (response.status == 'password_required') {
        dom.connect_div.style.display = 'none'
        dom.password_div.style.display = 'block'
        dom.password_input.focus()
        conn.close()
      }
      else if (response.status == 'password_invalid') {
        dom.password_error.style.display = 'block'
        dom.password_input.value = ''
        dom.password_input.focus()
        dom.password_submit.removeAttribute("disabled")
        dom.password_loading.style.display = 'none'
        conn.close()
      }
      else if (response.status == 'welcome') {
        // Update UI Components
        dom.connect_div.style.display = 'none'
        dom.password_div.style.display = 'none'
        dom.transfer_div.style.display = 'block';
        dom.transfer_status_protected.style.display = response.secured ? 'inline-block' : 'none'
      }
    }
    else if ('webrtc-user-name' in data && this._isHost) {
      const incoming = data['webrtc-user-name'];
      // Reject malformed payloads from the wire. The id is used as a DOM id suffix
      // and the name will be rendered in every peer's DOM.
      if (!incoming || !_isValidId(incoming.id)) return;
      if (!(incoming.id in this._remotePeers)) return;
      const newName = _sanitizeName(incoming.name);

      // Update user
      this._remotePeers[incoming.id].name = newName;

      // Update files
      for (let f of Object.values(this._files)) {
        if (f.owner_id == incoming.id) {
          f.owner_name = newName
          this._setFileInfoText(f)
        }
        for (let p of Object.values(f.remotePeers)) {
          if (p.user_id == incoming.id) {
            p.user_name = newName
          }
        }
      }

      // Update UI
      const nameEl = document.getElementById(`user-${incoming.id}-name`);
      if (nameEl) nameEl.textContent = newName;

      // Notify all peers
      const peers_list = [{"id": this._peer.id, "name": this._name }, ...Object.entries(this._remotePeers).map(([k, v]) => ({"id": k, "name": v.name}))];
      for (let p of Object.values(this._remotePeers)) {
        p.conn.send({'webrtc-peers': peers_list})
      }
    }
    else if ('webrtc-peers' in data && !this._isHost) {
      if (!Array.isArray(data['webrtc-peers'])) return;
      // Show transfer page
      dom.transfer_div.style.display = 'block'
      dom.transfer_status_wait.style.display = 'none'
      dom.transfer_status_success.style.display = 'inline-block'
      showToast('Connection established!')

      // Process Connected Peers
      for (let p of data['webrtc-peers']) {
        // Skip malformed entries from the wire — id must match the strict charset, and
        // name is clamped to a sane length before being inserted into the DOM.
        if (!p || typeof p !== 'object' || !_isValidId(p.id)) continue;
        p.name = _sanitizeName(p.name);

        // Peer is the Host
        if (p.id == this._room_id) {
          if (this._remotePeers[p.id]) this._remotePeers[p.id].name = p.name
          dom.transfer_users_list_host_name.textContent = p.name
        }
        // Peer is not the Host
        else {
          if (!(p.id in this._remotePeers)) {
            // New peer — add UI and create the entry.
            this._addUserUI(p)
            this._remotePeers[p.id] = {"name": p.name}
          } else {
            // Existing entry — update name in place so any other fields on the entry
            // (intervals, etc.) survive.
            this._remotePeers[p.id].name = p.name
            const nameEl = document.getElementById(`user-${p.id}-name`);
            if (nameEl) nameEl.textContent = `${p.name} ${p.id == this._peer.id ? ' (You)' : ''}`
          }
        }

        // Update files
        for (let f of Object.values(this._files)) {
          if (f.owner_id == p.id) {
            f.owner_name = p.name
            this._setFileInfoText(f)
          }
        }
      }
      // Check if any peer has disconnected
      for (let p of Object.keys(this._remotePeers)) {
        if (!data['webrtc-peers'].some(p2 => p2.id === p)) {
          clearInterval(this._remotePeers[p].interval);
          delete this._remotePeers[p]
          this._removeUserUI(p)
        }
      }

      // Process files. Reject malformed entries from the wire (same checks as _onFileAdd).
      if (Array.isArray(data['webrtc-files'])) {
        for (let file of data['webrtc-files']) {
          if (!file || typeof file !== 'object') continue;
          if (!_isValidId(file.id) || !_isValidId(file.owner_id)) continue;
          if (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0) continue;
          if (file.id in this._files) continue;

          const f = new File({
            id: file.id,
            name: _sanitizeFilename(file.name),
            size: file.size,
            owner_id: file.owner_id,
            owner_name: _sanitizeName(file.owner_name),
          });
          this._files[f.id] = f;
          this._addFileUI(f);
        }
      }
    }
    else if ('webrtc-file-add' in data && conn.peer in this._remotePeers) {
      this._onFileAdd(data['webrtc-file-add'])
    }
    else if ('webrtc-file-remove' in data && conn.peer in this._remotePeers) {
      this._onFileRemove(data['webrtc-file-remove'])
    }
    else if ('webrtc-file-download' in data && conn.peer in this._remotePeers) {
      this._onFileDownload(data['webrtc-file-download'])
    }
    else if ('webrtc-file-queued' in data && conn.peer in this._remotePeers) {
      this._onFileQueued(data['webrtc-file-queued'])
    }
    else if ('webrtc-file-cancel' in data && conn.peer in this._remotePeers) {
      this._onFileCancel(data['webrtc-file-cancel'])
    }
    else {
      // Unknown message type — log and ignore. Tearing down the connection here would
      // break compatibility with peers running a newer protocol that adds message types.
      console.warn('Ignoring unknown message from', conn.peer, Object.keys(data || {}));
    }
  }

  // Emitted when either you or the remote peer closes the data connection.
  _handleClose(conn) {
    // Peer: The host has closed the connection
    if (conn.peer == this._room_id) {
      if (this._status?.status == 'welcome') {
        dom.transfer_div.style.display = 'none'
        dom.error_div.style.display = 'block'
        dom.error_message.innerHTML = 'Host user has been disconnected.'
      }
    }
    // Host: A peer has closed the connection
    else if (conn.peer in this._remotePeers) {
      // Remove user from the list
      this._removeUserUI(conn.peer)

      // Update files
      for (let file of Object.values(this._files)) {
        if (file.owner_id == conn.peer) {
          document.getElementById(`file-${file.id}-abort`).style.display = 'none'
          document.getElementById(`file-${file.id}-download`).style.display = 'none'
          document.getElementById(`file-${file.id}-icon-loading`).style.display = 'none'
          document.getElementById(`file-${file.id}-icon-failed`).style.display = 'none'
          document.getElementById(`file-${file.id}-error`).style.display = 'block' 
          document.getElementById(`file-${file.id}-error`).innerHTML = 'The user has disconnected.'
          file.removed = true
        }
      }

      // Remove peer user
      clearInterval(this._remotePeers[conn.peer].interval);
      delete this._remotePeers[conn.peer]

      // If no peers, disable the Send File button
      if (Object.keys(this._remotePeers).length == 0) {
        dom.transfer_status_success.style.display = 'none'
        dom.transfer_status_wait.style.display = 'inline-block'
      }

      // Notify all peers
      const peers_list = [{"id": this._peer.id, "name": this._name }, ...Object.entries(this._remotePeers).map(([k, v]) => ({"id": k, "name": v.name}))];
      for (let p of Object.values(this._remotePeers)) {
        p.conn.send({'webrtc-peers': peers_list})
      }
    }
  }

  // Emitted when there is an unexpected error in the data connection.
  _handleError(err) {
    // Fatal errors — cannot recover
    const fatalTypes = ['browser-incompatible', 'invalid-id', 'unavailable-id', 'ssl-unavailable'];
    if (fatalTypes.includes(err.type)) {
      this._showFatalError(
        err.type === 'browser-incompatible'
          ? 'FileSync does not work with this browser.'
          : err.message
      );
      return;
    }

    // Recoverable errors — attempt reconnection
    if (['disconnected', 'network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      console.warn(`Recoverable error (${err.type}). Scheduling reconnect...`);
      this._scheduleReconnect();
      return;
    }

    // Peer-unavailable is expected when a remote peer is unreachable
    if (err.type === 'peer-unavailable') {
      console.warn('Remote peer is unavailable:', err.message);
      return;
    }

    // Fallback for unknown error types
    console.error('Unhandled peer error:', err.type, err.message);
  }

  async _onFileAdd(files) {
    if (!Array.isArray(files) || files.length === 0) return;
    let data = []
    for (const file of files) {
      // Reject malformed entries from the network. id fields are used as DOM id
      // suffixes and in inline event handlers; name fields are rendered in the DOM and
      // must be length-bounded. size must be a non-negative number.
      if (!file || typeof file !== 'object') continue;
      if (!_isValidId(file.id) || !_isValidId(file.owner_id)) continue;
      if (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0) continue;
      if (file.id in this._files) continue; // Don't accept duplicates from the wire.

      const fileData = {
        "id": file.id,
        "name": _sanitizeFilename(file.name),
        "size": file.size,
        "owner_id": file.owner_id,
        "owner_name": _sanitizeName(file.owner_name),
      };

      // Create file instance
      const f = new File(fileData)

      // Add file to the current user
      this._files[f.id] = f

      // Add file to the list
      this._addFileUI(f)

      // Store file to send it to other peers
      data.push({"id": f.id, "name": f.name, "size": f.size, "owner_id": f.owner_id, "owner_name": f.owner_name})
    }

    // Send file to all peers excluding the peer that has sent the file
    if (this._isHost) {
      const peersList = Object.entries(this._remotePeers)
        .filter(([peerId]) => peerId !== files[0].owner_id)
        .map(([, peerData]) => peerData);
      for (let peer of peersList) {
        peer.conn.send({"webrtc-file-add": data})
      }
    }
  }

  async _onFileDownload(data) {
    if (!data || !_isValidId(data.file_id) || !_isValidId(data.peer_id) || !_isValidId(data.requester_id)) return;
    const file = this._files[data.file_id];
    if (!file) return;
    // requester_name is user-controlled and lands in the sender's details table.
    data.requester_name = _sanitizeName(data.requester_name);

    // I'm the owner — run with the concurrency cap.
    if (file.owner_id == this._peer.id) {
      if (this._outboundActive >= _OUTBOUND_CONCURRENCY_CAP) {
        // Capacity reached — queue this request and tell the requester they're waiting.
        this._outboundQueue.push(data);
        this._notifyQueued(data);
        return;
      }
      this._startOutboundTransfer(file, data);
      return;
    }

    // Not the owner — forward to whoever is (only the host has this routing role).
    const owner_id = file.owner_id;
    const target = this._remotePeers[owner_id];
    if (target && target.conn) target.conn.send({"webrtc-file-download": data});
  }

  // Start a transfer and account for its slot. The slot is released via `.finally` so
  // any exit (success, error, abort, peer-disconnect) frees capacity correctly. The
  // `.catch` is what makes that promise actually settle when file.connect() rejects:
  // without it, an unreachable receiver would silently leak the slot until the cap
  // permanently rejected all further outbound transfers.
  _startOutboundTransfer(file, data) {
    this._outboundActive += 1;
    file.transfer(data)
      .catch((err) => {
        console.warn('Outbound transfer failed for', data?.file_id, '-', err?.message || err);
        // Tell the requester over the room connection. The per-file DataChannel may
        // never have opened, so this is the only path that reaches their UI.
        this._notifyRequesterCancel(data);
        // Best-effort: tear down any per-receiver state file.transfer set up before it
        // failed, so we don't leak the signaling WebSocket attached to the per-file Peer.
        const entry = file._remotePeers?.[data?.peer_id];
        if (entry) {
          try { entry.peer?.destroy() } catch {}
          if (entry.interval) clearInterval(entry.interval);
          delete file._remotePeers[data.peer_id];
        }
      })
      .finally(() => {
        this._outboundActive = Math.max(0, this._outboundActive - 1);
        this._dequeueOutbound();
      });
  }

  // Tell the requester their download cannot proceed. Routes over the room
  // connection like the queued notification, in reverse.
  _notifyRequesterCancel(data) {
    if (!data || !_isValidId(data.file_id) || !_isValidId(data.requester_id)) return;
    const payload = { file_id: data.file_id, requester_id: data.requester_id };
    if (this._isHost) {
      const target = this._remotePeers[data.requester_id];
      if (target?.conn) target.conn.send({ 'webrtc-file-cancel': payload });
    } else {
      const host = this._remotePeers[this._room_id];
      if (host?.conn) host.conn.send({ 'webrtc-file-cancel': payload });
    }
  }

  // Pop and start as many queued transfers as the cap allows. Skips entries whose
  // file has been removed in the meantime.
  _dequeueOutbound() {
    while (this._outboundActive < _OUTBOUND_CONCURRENCY_CAP && this._outboundQueue.length > 0) {
      const next = this._outboundQueue.shift();
      const file = this._files[next.file_id];
      if (!file || file.removed) continue;
      this._startOutboundTransfer(file, next);
    }
  }

  // Tell the requester their download is queued behind other transfers. The message
  // routes the same way the inbound webrtc-file-download did, in reverse:
  //   - if I'm the host, send directly to the requester
  //   - otherwise send to the host, which forwards (see _onFileQueued below)
  _notifyQueued(data) {
    const payload = { file_id: data.file_id, requester_id: data.requester_id };
    if (this._isHost) {
      const target = this._remotePeers[data.requester_id];
      if (target && target.conn) target.conn.send({ 'webrtc-file-queued': payload });
    } else {
      const host = this._remotePeers[this._room_id];
      if (host && host.conn) host.conn.send({ 'webrtc-file-queued': payload });
    }
  }

  // Inbound webrtc-file-queued. Either I am the requester (update UI) or I'm the host
  // and need to forward it to the requester.
  _onFileQueued(data) {
    if (!data || !_isValidId(data.file_id) || !_isValidId(data.requester_id)) return;
    if (data.requester_id == this._peer.id) {
      // Update the file row's progress label so the user sees a real state, not a
      // silent 0%.
      const el = document.getElementById(`file-${data.file_id}-progress`);
      if (el) el.textContent = 'Queued | ';
      return;
    }
    if (this._isHost) {
      const target = this._remotePeers[data.requester_id];
      if (target && target.conn) target.conn.send({ 'webrtc-file-queued': data });
    }
  }

  // Inbound webrtc-file-cancel: the sender could not start the transfer we asked for
  // (e.g. their connection attempt to our per-file peer failed). Tear down the
  // waiting row so it doesn't sit on the loading spinner forever. Either I am the
  // requester (tear down my row) or I'm the host and need to forward it — a non-host
  // sender always routes this through the host's room connection (see
  // _notifyRequesterCancel / _onFileQueued for the same pattern).
  _onFileCancel(data) {
    if (!data || !_isValidId(data.file_id) || !_isValidId(data.requester_id)) return;
    if (data.requester_id == this._peer.id) {
      const file = this._files[data.file_id];
      if (!file || !file.in_progress) return;
      file._terminateReceive(file._conn, 'sender-cancel', 'The sender stopped the transfer.');
      return;
    }
    if (this._isHost) {
      const target = this._remotePeers[data.requester_id];
      if (target && target.conn) target.conn.send({ 'webrtc-file-cancel': data });
    }
  }

  _onFileRemove(data) {
    if (!data || !_isValidId(data.file_id) || !_isValidId(data.peer_id)) return;
    const file = this._files[data.file_id];
    if (!file) return;
    // Abort the file transfer
    file.remove()

    document.getElementById(`file-${data.file_id}-abort`).style.display = 'none'
    document.getElementById(`file-${data.file_id}-download`).style.display = 'none'
    document.getElementById(`file-${data.file_id}-icon-loading`).style.display = 'none'
    document.getElementById(`file-${data.file_id}-icon-failed`).style.display = 'none'
    document.getElementById(`file-${data.file_id}-error`).style.display = 'block' 
    document.getElementById(`file-${data.file_id}-error`).innerHTML = 'This file has been removed.'

    // Send file to all peers excluding the peer that has sent the file
    if (this._isHost) {
      const peersList = Object.entries(this._remotePeers)
        .filter(([peerId]) => peerId !== data.peer_id)
        .map(([, peerData]) => peerData);
      for (let peer of peersList) {
        peer.conn.send({"webrtc-file-remove": data})
      }
    }
  }

  _addUserUI(user) {
    // user.id is validated at every entry point; safe in id attributes. user.name is
    // user-controlled and inserted via textContent below — never via innerHTML.
    let li = document.createElement('li')
    li.setAttribute('id', `user-${user.id}`)
    li.setAttribute('class', 'list-group-item')
    li.innerHTML = `
      <span title="User">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#198754" class="bi bi-lightning-charge-fill" viewBox="0 0 16 16" style="margin-bottom:5px">
          <path d="M11.251.068a.5.5 0 0 1 .227.58L9.677 6.5H13a.5.5 0 0 1 .364.843l-8 8.5a.5.5 0 0 1-.842-.49L6.323 9.5H3a.5.5 0 0 1-.364-.843l8-8.5a.5.5 0 0 1 .615-.09z"/>
        </svg>
      </span>
      <span id="user-${user.id}-name"></span>
    `
    dom.transfer_users_list.appendChild(li)
    const nameEl = document.getElementById(`user-${user.id}-name`);
    if (nameEl) nameEl.textContent = user.id == this._peer.id ? `${user.name} (You)` : user.name;

    // Update the number of users in the list
    dom.transfer_users_count.innerHTML = ` (${dom.transfer_users_list.querySelectorAll('li').length})`

    // Show toast (skip for own user)
    if (user.id != this._peer.id) showToast(`User ${user.name} joined.`)
  }

  _removeUserUI(user_id) {
    // Get user name before removing
    const userName = this._remotePeers[user_id]?.name || document.getElementById(`user-${user_id}-name`)?.textContent?.trim() || 'A user'

    // Remove user from the list
    document.getElementById(`user-${user_id}`).remove()

    // Update the number of users in the list
    dom.transfer_users_count.innerHTML = ` (${dom.transfer_users_list.querySelectorAll('li').length})`

    // Show toast
    showToast(`User ${userName} left.`, 'warning')
  }

  _addFileUI(file) {
    // file.id is validated as a strict id at every entry point; safe to use as a DOM id
    // suffix. file.name and file.owner_name are user-controlled and inserted via
    // textContent below — never via innerHTML.
    dom.transfer_files_list_empty.remove()
    let li = document.createElement('li')
    li.setAttribute('id', `file-${file.id}`)
    li.setAttribute('class', 'list-group-item')

    const isMine = file.owner_id == this._peer.id;
    li.innerHTML = `
      <div class="row align-items-center">
        <div class="col-auto" style="padding-right: 0">
          <div id="file-${file.id}-icon-loading" title="${isMine ? 'Uploading file': 'Downloading file'}" class="col-auto spinner-border" style="margin-right: 12px; color: #0d6efd; width: 1.4rem; height: 1.4rem; --bs-spinner-border-width: 0.15em; margin-top:3px; display: none"></div>
          <div id="file-${file.id}-icon-success" title="${isMine ? 'File uploaded': 'File downloaded'}" style="margin-right: 12px; display: none">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="#198754" class="bi bi-check-circle-fill" viewBox="0 0 16 16">
              <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zm-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z"/>
            </svg>
          </div>
          <div id="file-${file.id}-icon-failed" title="Failed" style="margin-right: 12px; display: none">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="#dc3545" class="bi bi-x-circle-fill" viewBox="0 0 16 16">
              <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM5.354 4.646a.5.5 0 1 0-.708.708L7.293 8l-2.647 2.646a.5.5 0 0 0 .708.708L8 8.707l2.646 2.647a.5.5 0 0 0 .708-.708L8.707 8l2.647-2.646a.5.5 0 0 0-.708-.708L8 7.293 5.354 4.646z"/>
            </svg>
          </div>
        </div>

        <div class="col d-flex flex-column" style="overflow-x: hidden; padding-left:0px;">
          <div style="margin-bottom: 5px; font-size: 0.875rem; font-weight: 500; text-align: left; word-break: break-all;">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="bi bi-arrow-up-short" viewBox="0 0 16 16"; style="margin-top:-3px; margin-right:-3px; margin-left:-5px; display: ${isMine ? 'block-inline' : 'none'}">
            <path fill-rule="evenodd" d="M8 12a.5.5 0 0 0 .5-.5V5.707l2.146 2.147a.5.5 0 0 0 .708-.708l-3-3a.5.5 0 0 0-.708 0l-3 3a.5.5 0 1 0 .708.708L7.5 5.707V11.5a.5.5 0 0 0 .5.5z"/>
          </svg>
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="bi bi-arrow-down-short" viewBox="0 0 16 16" style="margin-top:-3px; margin-right:-3px; margin-left:-5px; display: ${isMine ? 'none' : 'block-inline'}">
            <path fill-rule="evenodd" d="M8 4a.5.5 0 0 1 .5.5v5.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L7.5 10.293V4.5A.5.5 0 0 1 8 4z"/>
          </svg>
          <span id="file-${file.id}-name"></span></div>
          <div style="color: #636979; font-size: .9rem; font-weight: 500; overflow-x: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; margin-bottom:1px"><span id="file-${file.id}-progress"></span><span id="file-${file.id}-info"></span></div>
          <div id="file-${file.id}-error" style="color: #dc3545; font-size: .9rem; font-weight: 500; overflow-x: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; margin-top:5px; margin-bottom:4px; display:none"></div>
          <div id="file-${file.id}-details" style="color: #0d6efd; font-size: .9rem; font-weight: 500; text-align: left; padding-top:5px; padding-bottom:4px; padding-right:4px; cursor:pointer; display: ${isMine ? 'block' : 'none'}">See details</div>
        </div>

        <div id="file-${file.id}-remove" class="col-auto text-end" title="Remove file" style="cursor: pointer; display: ${isMine ? 'block-inline' : 'none'}">
          <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" fill="#dc3545" class="bi bi-x-circle" viewBox="0 0 16 16">
            <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </div>
        <div id="file-${file.id}-abort" class="col-auto text-end" title="Stop file download" style="cursor: pointer; display: none">
          <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" fill="#dc3545" class="bi bi-x-circle" viewBox="0 0 16 16">
            <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </div>
        <div id="file-${file.id}-download" class="col-auto text-end" title="Download file" style="cursor: pointer; display: ${isMine ? 'none' : 'block-inline'}">
          <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" fill="#0d6efd" class="bi bi-arrow-down-circle" viewBox="0 0 16 16">
            <path fill-rule="evenodd" d="M1 8a7 7 0 1 0 14 0A7 7 0 0 0 1 8zm15 0A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM8.5 4.5a.5.5 0 0 0-1 0v5.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V4.5z"/>
          </svg>
        </div>
      </div>
    `
    dom.transfer_files_list.appendChild(li)

    // Row actions. (Inline handlers are forbidden by the site CSP — bind instead.)
    const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
    on(`file-${file.id}-details`, () => this.showFileDetails(file.id));
    on(`file-${file.id}-remove`, () => this.removeFile(file.id));
    on(`file-${file.id}-abort`, () => this.abortFile(file.id));
    on(`file-${file.id}-download`, () => this.downloadFile(file.id));

    // Insert user-controlled text safely (textContent never parses HTML).
    const nameEl = document.getElementById(`file-${file.id}-name`);
    if (nameEl) nameEl.textContent = file.name;
    this._setFileInfoText(file);

    // Update the number of files in the list (count is server-derived, but use
    // textContent for consistency).
    dom.transfer_files_count.textContent = ` (${dom.transfer_files_list.querySelectorAll('li').length})`;
  }

  // Renders the "{size} | Sent by {owner_name}" caption for a file. owner_name is
  // user-controlled and must be inserted via textContent — never via innerHTML.
  _setFileInfoText(file) {
    const el = document.getElementById(`file-${file.id}-info`);
    if (!el) return;
    const isMine = file.owner_id == this._peer.id;
    const ownerLabel = isMine ? `${file.owner_name} (You)` : file.owner_name;
    el.textContent = `${this._parseBytes(file.size)} | Sent by ${ownerLabel}`;
  }

  _generate_name() {
    const colors = ["Aqua","Aquamarine","Azure","Beige","Bisque","Black","Blue","Brown","Chartreuse","Chocolate","Coral","Cornsilk","Crimson","Cyan","Fuchsia","Gold","Gray","Grey","Green","Indigo","Ivory","Khaki","Lavender","Lime","Linen","Magenta","Maroon","Navy","Olive","Orange","Orchid","Peru","Pink","Plum","Purple","Red","Salmon","Sienna","Silver","Snow","Tan","Teal","Thistle","Tomato","Turquoise","Violet","Wheat","White","Yellow"]
    const animals = ["Aardvark","Albatross","Alligator","Alpaca","Ant","Anteater","Antelope","Ape","Armadillo","Donkey","Baboon","Badger","Barracuda","Bat","Bear","Beaver","Bee","Bison","Boar","Buffalo","Butterfly","Camel","Capybara","Caribou","Cassowary","Cat","Caterpillar","Cattle","Chamois","Cheetah","Chicken","Chimpanzee","Chinchilla","Chough","Clam","Cobra","Cockroach","Cod","Cormorant","Coyote","Crab","Crane","Crocodile","Crow","Curlew","Deer","Dinosaur","Dog","Dogfish","Dolphin","Dotterel","Dove","Dragonfly","Duck","Dugong","Dunlin","Eagle","Echidna","Eel","Eland","Elephant","Elk","Emu","Falcon","Ferret","Finch","Fish","Flamingo","Fly","Fox","Frog","Gaur","Gazelle","Gerbil","Giraffe","Gnat","Gnu","Goat","Goldfinch","Goldfish","Goose","Gorilla","Goshawk","Grasshopper","Grouse","Guanaco","Gull","Hamster","Hare","Hawk","Hedgehog","Heron","Herring","Hippopotamus","Hornet","Horse","Human","Hummingbird","Hyena","Ibex","Ibis","Jackal","Jaguar","Jay","Jellyfish","Kangaroo","Kingfisher","Koala","Kookabura","Kouprey","Kudu","Lapwing","Lark","Lemur","Leopard","Lion","Llama","Lobster","Locust","Loris","Louse","Lyrebird","Magpie","Mallard","Manatee","Mandrill","Mantis","Marten","Meerkat","Mink","Mole","Mongoose","Monkey","Moose","Mosquito","Mouse","Mule","Narwhal","Newt","Nightingale","Octopus","Okapi","Opossum","Oryx","Ostrich","Otter","Owl","Oyster","Panther","Parrot","Partridge","Peafowl","Pelican","Penguin","Pheasant","Pig","Pigeon","Pony","Porcupine","Porpoise","Quail","Quelea","Quetzal","Rabbit","Raccoon","Rail","Ram","Rat","Raven","Red deer","Red panda","Reindeer","Rhinoceros","Rook","Salamander","Salmon","Sand Dollar","Sandpiper","Sardine","Scorpion","Seahorse","Seal","Shark","Sheep","Shrew","Skunk","Snail","Snake","Sparrow","Spider","Spoonbill","Squid","Squirrel","Starling","Stingray","Stinkbug","Stork","Swallow","Swan","Tapir","Tarsier","Termite","Tiger","Toad","Trout","Turkey","Turtle","Viper","Vulture","Wallaby","Walrus","Wasp","Weasel","Whale","Wildcat","Wolf","Wolverine","Wombat","Woodcock","Woodpecker","Worm","Wren","Yak","Zebra"]
    return colors[Math.round(Math.random() * (colors.length - 1))] + ' ' + animals[Math.round(Math.random() * (animals.length - 1))]
  }

  // Function to parse bytes
  _parseBytes(bytes) {
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB']
    const base = 1024
    if (bytes === 0) {
      return '0 bytes'
    }
    // Clamp so absurd sizes never index past the table.
    const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(base)))
    const value = (bytes / Math.pow(base, exponent)).toFixed(2)
    return `${value} ${units[exponent]}`
  }

  async _getUUID() {
    const response = await fetch(`/api/uuid`);
    if (!response.ok) throw new Error(`uuid endpoint failed: HTTP ${response.status}`);
    const data = await response.json();
    return data['uuid'];
  }
}
import { turn } from './turn.js';
import { applyIceMode } from './mode.js';
import { Peer } from './peer.js';

const CHUNK_SIZE = 16 * 1024;          // 16 KiB — under SCTP message-size limits on every browser.
const HIGH_WATER = 1 << 20;            // 1 MiB — pause reads when DataChannel buffer is this full.
const LOW_WATER  = 1 << 18;            // 256 KiB — resume when it drains to this level.
const PROGRESS_REPORT_INTERVAL = 256 * 1024;  // Send a progress update every 256 KiB received.
// Aligned with ICE's own recovery window: browsers keep retrying a 'disconnected'
// session for ~30s before declaring 'failed', so give up no earlier than they do.
const ICE_DISCONNECT_GRACE_MS = 30_000;
// Receiver-side: no inbound frames for this long mid-transfer => the link is dead
// (the sender's watchdog alone would leave us waiting on a channel that never closes).
const RECEIVER_STALL_TIMEOUT_MS = 15_000;
// Sender cancel reasons after which the receiver can still resume with a new connection.
const RESUMABLE_CANCEL_REASONS = new Set(['connection-lost', 'send-failed']);

// Null-safe DOM helpers. WebRTC event handlers fire asynchronously and can outlive the
// UI elements they reference (e.g., if the file row is being torn down concurrently).
// Throwing inside an event handler poisons the rest of the transfer state machine.
const $set = (id, prop, value) => {
  const el = document.getElementById(id);
  if (el) el[prop] = value;
};
const $style = (id, prop, value) => {
  const el = document.getElementById(id);
  if (el) el.style[prop] = value;
};

const _clampOffset = (value, size) => {
  const n = (typeof value === 'number' && Number.isFinite(value)) ? Math.floor(value) : 0;
  return n > 0 && n < size ? n : 0;
};

export class File {
  // File
  _id;
  _name;
  _size;
  _content;
  _owner_id;
  _owner_name;

  // Send
  // Keyed by wire-supplied peer ids (the signaling charset allows '__proto__') —
  // null-prototype keeps a crafted id from resolving to Object.prototype members.
  _remotePeers = Object.create(null);

  // Receive
  _peer;
  _conn = null;            // receiver's active inbound connection, for eager teardown on abort
  _transferred = 0;        // bytes received on the wire for the current session (incl. resumed offset)
  _flushed = 0;            // bytes durably written to the sink — the resume point
  _resumeOffset = 0;       // >0 while interrupted but resumable (sink kept open)
  _stallTimer = null;
  _stallTimeoutMs = RECEIVER_STALL_TIMEOUT_MS;  // overridable in tests
  _resuming = false;       // an auto-resume attempt loop is running
  _onInterrupted = null;   // set by user.js: notified when a download pauses for resume
  _zip = false;
  _zipController = null;
  _sink = null;
  _in_progress = false;
  _aborted = false;
  _removed = false;
  _peerReconnectAttempts = 0;
  _peerReconnectTimer = null;
  _lastProgressReportAt = 0;
  // Serializes sink writes; FS Access writables lock on concurrent writes. Reset in _onHeader.
  _writeChain = Promise.resolve();

  constructor(file) {
    this._id = file.id
    this._name = file.name
    this._size = file.size
    this._content = file.content
    this._owner_id = file.owner_id
    this._owner_name = file.owner_name
  }

  get file() {
    return {"id": this._id, "name": this._name, "size": this._size, "owner_id": this._owner_id, "owner_name": this._owner_name}
  }

  get id() { return this._id; }
  get name() { return this._name }
  get size() { return this._size }
  get owner_id() { return this._owner_id }
  get owner_name() { return this._owner_name }
  get peer() { return this._peer }
  get conn() { return this._conn }
  get remotePeers() { return this._remotePeers }
  get resumeOffset() { return this._resumeOffset }
  get canResume() { return (this._zip ? !!this._zipController : !!this._sink) && this._resumeOffset > 0 }

  get details() {
    return Object.values(this._remotePeers).reduce((acc, p) => {
      acc[p.user_id] = {
        user_name: p.user_name,
        progress: p.progress,
        aborted: p.aborted,
      };
      return acc;
    }, {});
  }

  get in_progress() { return this._in_progress }
  set in_progress(value) { this._in_progress = value }
  get aborted() { return this._aborted }
  get removed() { return this._removed }
  set removed(value) { return this._removed = value }
  get transferred() { return this._transferred }

  set owner_name(value) { this._owner_name = value }
  set zip(value) { this._zip = value }
  setZipController(c) { this._zipController = c }

  async init(peer_id) {
    // Get ICE servers. Caller is responsible for surfacing this — file.init is used
    // for per-file Peers, so a failure here is a per-file failure, not a
    // page-level fatal. Throwing lets downloadFile / downloadAll roll back their own
    // UI state instead of having init reach into the global error div.
    let iceServers;
    try {
      iceServers = await turn.getServers();
    } catch (err) {
      console.warn('file.init: failed to get ICE servers:', err);
      throw err;
    }

    // UUID fetch is a normal await — its rejection propagates out of init naturally.
    const uuid = await this._getUUID();

    await new Promise((resolve, reject) => {
      // Create a new Peer instance
      const isSecure = window.location.protocol === 'https:';
      const peer = new Peer(uuid, {
        host: window.location.hostname,
        port: parseInt(window.location.port) || (isSecure ? 443 : 80),
        secure: isSecure,
        config: applyIceMode({ iceServers }),
      });

      if (peer_id === undefined) this._peer = peer
      else this._remotePeers[peer_id].peer = peer

      // Settle init exactly once. Without a reject path, a per-file Peer that can't
      // reach the signaling server (server down, network blip, registration code
      // 4400/4409) would hang init forever — and on the sender side, that would
      // leak an outbound concurrency slot.
      let settled = false;
      const settle = (cb, arg) => { if (settled) return; settled = true; cb(arg); };

      peer.on('open', (id) => {
        // Reset reconnect bookkeeping on every successful (re-)registration. Re-firing
        // on reconnect is intentional (peer.js emits 'open' after each /ws register);
        // only the first open settles the init promise.
        this._peerReconnectAttempts = 0;
        if (this._peerReconnectTimer) {
          clearTimeout(this._peerReconnectTimer);
          this._peerReconnectTimer = null;
        }
        if (!settled) this._handleOpen(id, () => settle(resolve));
      });

      peer.on('error', (err) => {
        // Pre-'open' errors fail the init (caller bails). Post-'open' errors go to
        // the normal handler so reconnect/warn paths keep working.
        if (settled) {
          this._handleError(err);
        } else {
          // Destroy the half-initialized Peer so its signaling WebSocket isn't left
          // dangling — the caller will null its own reference to file._peer.
          try { peer.destroy(); } catch {}
          settle(reject, err);
        }
      });

      peer.on('connection', (conn) => conn.on('open', () => this._handleConnection(conn)));
      peer.on('disconnected', () => this._handlePeerDisconnected(peer));
    })
  }

  async connect(peer_id) {
    await this.init(peer_id)

    await new Promise((resolve, reject) => {
      // 'raw' serialization tells the peer client to pass strings and ArrayBuffers through
      // the data channel verbatim — no BinaryPack, no auto-chunking. We frame
      // ourselves: JSON strings for control messages, raw ArrayBuffers for bytes.
      const conn = this._remotePeers[peer_id].peer.connect(peer_id, {
        serialization: 'raw',
        reliable: true,
      });

      // Settle exactly once. Listening for error/close in addition to open guarantees
      // we never hang here when the receiver is unreachable (peer-unavailable, ICE
      // failure) — the slot in user._outboundActive depends on this promise settling.
      let settled = false;
      const settle = (cb, arg) => { if (settled) return; settled = true; cb(arg); };

      conn.on('open', () => this._handleConnection(conn, () => settle(resolve)));
      conn.on('error', (err) => settle(reject, err));
      conn.on('close', () => settle(reject, new Error('Connection closed before open.')));
    })
  }

  async transfer(data) {
    // Update UI
    $style(`file-${this._id}-error`, 'display', 'none');
    $style(`file-${this._id}-icon-success`, 'display', 'none');
    $style(`file-${this._id}-icon-loading`, 'display', 'block');
    $set(`file-${this._id}-progress`, 'textContent', '0% | ');

    // Store peer data
    this._remotePeers[data.peer_id] = {"user_id": data.requester_id, "user_name": data.requester_name, "peer": null, "conn": null, "online": true, "interval": null, "progress": 0, "aborted": false}

    // Connect to peer_id
    await this.connect(data.peer_id)

    // Get connection
    const conn = this._remotePeers[data.peer_id].conn
    const dc = conn.dataChannel;
    if (!dc) {
      console.error('No raw RTCDataChannel exposed for this connection.');
      this._cancelReceiver(conn, 'no-data-channel');
      throw new Error('transfer failed: no-data-channel');
    }
    dc.bufferedAmountLowThreshold = LOW_WATER;

    // Init interval to check connection status
    const entry = this._remotePeers[data.peer_id];
    entry.interval = setInterval(() => this._isAlive(conn.peer), 500)
    this._watchIce(entry, conn);

    // Send header (size + start offset). offset > 0 means the receiver asked to
    // resume an interrupted transfer and already holds those bytes durably.
    const offset = _clampOffset(data.resume_offset, this._size);
    try {
      dc.send(JSON.stringify({ type: 'header', size: this._size, offset }));
    } catch (err) {
      console.error('Failed to send transfer header:', err);
      this._cancelReceiver(conn, 'header-failed');
      throw new Error('transfer failed: header-failed');
    }
    entry.headerSent = true;

    // Stream the file in CHUNK_SIZE pieces. Each Blob.slice().arrayBuffer() reads only
    // that slice from the OS-backed file — peak sender memory stays at one chunk.
    let sent = offset;
    let failure = null;
    while (sent < this._size) {
      // Aborted by either side, file removed, or peer disconnected
      if (this._aborted) {
        this._cancelReceiver(conn, 'aborted');
        return;
      }
      const current = this._remotePeers[data.peer_id];
      if (!current) { failure = 'entry-gone'; break; }
      if (current.aborted) {
        // The receiver itself asked to stop — it knows; only a watchdog loss is silent.
        if (current.lost) failure = 'connection-lost';
        break;
      }
      if (dc.readyState !== 'open') { failure = 'channel-closed'; break; }

      const end = Math.min(sent + CHUNK_SIZE, this._size);
      let buf;
      try {
        buf = await this._content.slice(sent, end).arrayBuffer();
      } catch (err) {
        console.error('Failed to read file slice:', err);
        this._cancelReceiver(conn, 'read-failed');
        throw new Error('transfer failed: read-failed');
      }

      await this._awaitDrain(dc);
      try {
        dc.send(buf);
      } catch (err) {
        console.error('DataChannel send failed:', err);
        // The watchdog may have closed the channel while we were reading the slice —
        // report the loss it already announced instead of an unrelated send failure.
        if (entry.lost) throw new Error('transfer failed: connection-lost');
        this._cancelReceiver(conn, 'send-failed');
        throw new Error('transfer failed: send-failed');
      }
      sent = end;
    }

    if (failure) {
      // channel-closed: the receiver already sees the close. connection-lost: the
      // watchdog already sent cancel + closed. Throwing lets user.js notify the
      // requester over the room connection and release the outbound slot.
      throw new Error(`transfer failed: ${failure}`);
    }

    // Send end marker (best-effort; channel may have closed)
    try {
      await this._awaitDrain(dc);
      dc.send(JSON.stringify({ type: 'end' }));
    } catch {}
  }

  // Sender side: tell the receiver a transfer died abnormally (read error, send
  // error, header failure, owner removed the file) and close the channel. Without
  // this the receiver would sit in in_progress forever — its close handler only
  // fires when a close actually propagates. Best-effort: the receiver also recovers
  // on its own if the channel dies first.
  _cancelReceiver(conn, reason) {
    if (!conn) return;
    try { conn.dataChannel.send(JSON.stringify({ type: 'cancel', reason })) } catch {}
    try { conn.close() } catch {}
  }

  // Track ICE transitions with events instead of polling: interval ticks are
  // throttled in background tabs, which would corrupt a wall-clock grace window.
  _watchIce(entry, conn) {
    const pc = conn.peerConnection;
    if (!pc || typeof pc.addEventListener !== 'function') return;
    entry.iceState = pc.iceConnectionState;
    if (entry.iceState === 'disconnected') entry.disconnectedSince = Date.now();
    pc.addEventListener('iceconnectionstatechange', () => {
      entry.iceState = pc.iceConnectionState;
      entry.disconnectedSince = entry.iceState === 'disconnected'
        ? (entry.disconnectedSince || Date.now())
        : null;
    });
  }

  // Wait for the dataChannel to drain below the high-water mark. Resolves on
  // 'bufferedamountlow', or on close/error so a receiver dropping mid-transfer with a
  // full buffer can't hang the send loop forever. Re-checks after subscribing.
  _awaitDrain(dc) {
    if (dc.bufferedAmount < HIGH_WATER) return Promise.resolve();
    return new Promise((resolve) => {
      const cleanup = () => {
        dc.removeEventListener('bufferedamountlow', onResolve);
        dc.removeEventListener('close', onResolve);
        dc.removeEventListener('error', onResolve);
      };
      const onResolve = () => { cleanup(); resolve(); };
      dc.addEventListener('bufferedamountlow', onResolve);
      dc.addEventListener('close', onResolve);
      dc.addEventListener('error', onResolve);
      if (dc.bufferedAmount < HIGH_WATER || dc.readyState !== 'open') {
        cleanup();
        resolve();
      }
    });
  }

  abort() {
    this._aborted = true
    // Tear the receive down now rather than waiting for the next chunk — if the sender
    // has already flushed its bytes (or stalled), no more chunks arrive and the sink,
    // per-file peer, and in-progress flag would otherwise leak.
    if (this._in_progress && this._conn) this._terminateReceive(this._conn, 'aborted')
    else if (this._sink || this._resumeOffset > 0) this._discardPartial()
  }

  remove() {
    this._aborted = true
    this._removed = true
    if (this._in_progress && this._conn) this._terminateReceive(this._conn, 'removed')
    else if (this._sink || this._resumeOffset > 0) this._discardPartial()
  }

  // Resume-attempt plumbing (driven by user.js): drop a stale per-file Peer from a
  // timed-out attempt. No-op when the transfer actually resumed.
  cancelResumeAttempt() {
    if (this._in_progress) return;
    try { if (this._peer) this._peer.destroy(); } catch {}
    this._peer = null;
  }

  // Full teardown of a paused (resumable) download: the user discarded it, so drop the
  // sink — and with it the partial bytes — plus all resume state.
  _discardPartial() {
    this._clearStall();
    const sink = this._sink;
    this._sink = null;
    if (sink) {
      const chain = (this._writeChain || Promise.resolve()).catch(() => {});
      this._writeChain = chain.then(() => sink.abort('aborted')).catch(() => {});
    }
    if (this._zip && this._zipController) {
      try { this._zipController.error(new Error('discarded')); } catch {}
      this._zipController = null;
    }
    try { if (this._peer) this._peer.destroy(); } catch {}
    this._conn = null;
    this._in_progress = false;
    this._resuming = false;
    this._resumeOffset = 0;
    this._flushed = 0;
  }

  _handleOpen(id, resolve) {
    resolve()
  }

  _handlePeerDisconnected(peer) {
    if (this._peerReconnectTimer) return;
    const maxAttempts = 3;
    if (this._peerReconnectAttempts >= maxAttempts) {
      console.error(`File peer: failed to reconnect after ${maxAttempts} attempts.`);
      return;
    }
    const delay = 1000 * Math.pow(2, this._peerReconnectAttempts);
    this._peerReconnectAttempts++;
    console.warn(`File peer disconnected. Reconnecting in ${delay}ms (attempt ${this._peerReconnectAttempts}/${maxAttempts})...`);
    this._peerReconnectTimer = setTimeout(() => {
      this._peerReconnectTimer = null;
      if (!peer.destroyed) peer.reconnect();
    }, delay);
  }

  _handleConnection(conn, resolve) {
    conn.on('data', (data) => this._handleData(conn, data));
    conn.on('close', () => this._handleClose(conn));
    conn.on('error', (err) => this._handleError(err));

    // Sender side — _remotePeers entry already exists; store conn and resolve.
    if (resolve !== undefined) {
      this._remotePeers[conn.peer].conn = conn
      resolve()
    }
    // Receiver side — incoming connection from the sender. Don't reset _aborted here:
    // an abort issued during setup must survive (reset happens at download start instead).
    else {
      this._conn = conn
      this._lastProgressReportAt = 0
    }
  }

  async _isAlive(peer_id) {
    const peer = this._remotePeers[peer_id];
    if (!peer) return;
    const pc = peer.conn ? peer.conn.peerConnection : null;
    const state = peer.iceState ?? (pc ? pc.iceConnectionState : null);
    if (state !== 'disconnected') peer.disconnectedSince = null;
    // 'failed'/'closed' (and a null pc) are terminal. 'disconnected' can recover on
    // its own (brief blips do, see T2a) — only give up after the full ICE grace.
    const gaveUp = state === 'disconnected'
      && peer.disconnectedSince
      && (Date.now() - peer.disconnectedSince) > ICE_DISCONNECT_GRACE_MS;
    if (pc === null || state === 'failed' || state === 'closed' || gaveUp) {
      clearInterval(peer.interval);
      peer.interval = null;
      if (peer.progress != 100) {
        peer.lost = true;
        peer.aborted = true;
        // Tell the receiver and close, so it never waits on a sender that gave up.
        this._cancelReceiver(peer.conn, 'connection-lost');
      }
      this._onFileProgress();
      peer.online = false;
    }
  }

  async _handleData(conn, data) {
    if (this._conn === conn) this._touch();

    // String frames are JSON-encoded control messages.
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      switch (msg.type) {
        // Sender-side handlers (receiver -> sender):
        case 'progress':  return this._onFileProgress(conn, { progress: msg.percent });
        case 'abort':     return this._onFileAborted(conn);

        // Receiver-side handlers (sender -> receiver):
        case 'header':    return this._onHeader(conn, msg);
        case 'end':       return this._onEnd(conn);
        case 'cancel':    return this._onSenderCancel(conn, msg);
      }
      return;
    }

    // Binary frames are file bytes (receiver only).
    if (data instanceof ArrayBuffer) {
      return this._onChunk(conn, data);
    }
    if (ArrayBuffer.isView(data)) {
      return this._onChunk(conn, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
  }

  async _onHeader(conn, header) {
    if (this._aborted) {
      this._terminateReceive(conn, 'aborted');
      return;
    }
    // Ignore headers from a connection we already replaced (resume attempts).
    if (this._conn && this._conn !== conn) return;

    // The sender must agree with the size we learned from the file-add metadata.
    // A mismatch means a corrupted or malicious sender — refuse to stream into the
    // sink rather than finalizing something unrecognizable.
    if (!header || typeof header.size !== 'number' || header.size !== this._size) {
      console.error('Transfer header size does not match the announced file.');
      this._terminateReceive(conn, 'size-mismatch', 'The transfer did not match the announced file.');
      return;
    }

    const offset = typeof header.offset === 'number' ? header.offset : 0;
    const stale = this._resumeOffset > 0;  // bytes from an earlier attempt are committed
    if (offset > 0) {
      const target = this._zip ? this._zipController : this._sink;
      if (!target || offset !== this._resumeOffset) {
        this._terminateReceive(conn, 'resume-mismatch', 'The transfer could not be resumed.');
        return;
      }
    } else if (stale) {
      if (this._zip) {
        // A bundle cannot absorb a from-zero restart mid-entry: earlier entries and
        // client-zip's running CRC for this one are already committed downstream.
        this._terminateReceive(conn, 'resume-mismatch', 'The transfer could not be resumed.');
        return;
      }
      // Sender restarted from zero (older sender or fresh attempt) — drop our bytes.
      try { await this._sink.truncate0(); } catch (err) {
        console.error('Sink reset failed:', err);
        this._terminateReceive(conn, 'sink-reset-failed', 'Could not start the download.');
        return;
      }
    }

    this._resumeOffset = 0;
    this._resuming = false;
    this._in_progress = true;
    this._transferred = offset;
    this._flushed = offset;
    this._lastProgressReportAt = offset;
    this._writeChain = Promise.resolve();
    this._touch();

    // Zip mode: bytes flow into the externally-supplied stream controller; no per-file sink.
    if (this._zip) return;

    // The sink is opened up-front by user.downloadFile() so the FS Access save picker
    // (and the SW iframe trigger) can fire inside the user-gesture window. By the time
    // the header arrives, the sink is already in place — use it as-is. Re-opening here
    // would (a) show a second save picker on FS Access, (b) trigger a second browser
    // download via a second iframe on SW, (c) leak the first chunks[] array on Blob.
    if (this._sink) return;

    // No pre-opened sink and not in zip mode — this shouldn't happen with current
    // callers, but handle it defensively rather than silently dropping bytes.
    console.error('Sink was not pre-opened before transfer header arrived.');
    this._aborted = true;
    this._terminateReceive(conn, 'no-sink', 'Could not start the download.');
  }

  // Single cleanup point for the receiver side of a transfer. Idempotent — safe to call
  // from any abort/error path. Closes the connection (if one was established), destroys
  // the per-file Peer so its signaling-server socket isn't left dangling, and clears
  // in-progress state. The sink is aborted: partial bytes are discarded, so a failed
  // transfer never leaves a partial file behind. When `message` is given, the row is
  // switched to its failed state with that text — callers that render their own message
  // (manual abort, file removed) omit it.
  _terminateReceive(conn, reason, message = null) {
    this._clearStall();
    if (conn) {
      try { conn.dataChannel.send(JSON.stringify({ type: 'abort', reason })); } catch {}
      try { conn.close(); } catch {}
    }
    if (this._sink) {
      // Queue the abort behind any in-flight writes: FileSystemWritableFileStream
      // holds a lock while a write is pending, so an immediate abort() would reject
      // and leave the partial file (and its write lock) behind. Chaining onto
      // _writeChain guarantees the abort runs once the stream is unlocked, and
      // nulling _sink stops _onChunk from queueing further writes.
      const sink = this._sink;
      const chain = (this._writeChain || Promise.resolve()).catch(() => {});
      this._writeChain = chain.then(() => sink.abort(reason)).catch(() => {});
      this._sink = null;
    }
    if (this._zip && this._zipController) {
      try { this._zipController.error(new Error(reason)); } catch {}
      this._zipController = null;
    }
    try { if (this._peer) this._peer.destroy(); } catch {}
    this._conn = null;
    this._in_progress = false;
    this._resuming = false;
    this._resumeOffset = 0;
    this._flushed = 0;
    if (message) {
      $set(`file-${this._id}-progress`, 'textContent', '');
      $style(`file-${this._id}-icon-loading`, 'display', 'none');
      $style(`file-${this._id}-icon-success`, 'display', 'none');
      $style(`file-${this._id}-icon-failed`, 'display', 'block');
      $style(`file-${this._id}-abort`, 'display', 'none');
      $style(`file-${this._id}-download`, 'display', 'block');
      $style(`file-${this._id}-error`, 'display', 'block');
      $set(`file-${this._id}-error`, 'textContent', message);
    }
  }

  // Receiver-side pause: the link died mid-transfer but the output is healthy. Keep the
  // sink (or, for bundles, the zip stream controller) and the byte count so a new
  // connection can resume at _flushed; stop the sender pumping into the dead channel,
  // then notify user.js to reconnect. For bundles _flushed counts bytes handed to
  // client-zip, so _onInterrupted drains the zip pipeline before trusting it.
  // _conn/_in_progress are cleared before conn.close(): peer.js emits 'close'
  // synchronously and the handler must not re-enter and pause a second time.
  async _interrupt(conn, reason) {
    this._clearStall();
    this._conn = null;
    this._in_progress = false;
    try { conn.dataChannel.send(JSON.stringify({ type: 'abort', reason })); } catch {}
    try { conn.close(); } catch {}
    try { if (this._peer) this._peer.destroy(); } catch {}
    try { await this._writeChain; } catch {}
    this._resumeOffset = this._flushed;
    this._writeChain = Promise.resolve();
    if (this._onInterrupted) {
      try { await this._onInterrupted(); } catch (err) { console.warn('onInterrupted failed:', err); }
    }
  }

  _touch() {
    if (!this._in_progress) return;
    this._clearStall();
    this._stallTimer = setTimeout(() => {
      this._stallTimer = null;
      this._onStall();
    }, this._stallTimeoutMs);
  }

  _clearStall() {
    if (this._stallTimer) {
      clearTimeout(this._stallTimer);
      this._stallTimer = null;
    }
  }

  _onStall() {
    if (!this._in_progress || !this._conn) return;
    this._interrupt(this._conn, 'stall');
  }

  async _onChunk(conn, buf) {
    if (this._aborted) {
      this._terminateReceive(conn, 'aborted');
      return;
    }
    // Ignore bytes from a connection we already replaced or paused.
    if (this._conn !== conn) return;

    const bytes = new Uint8Array(buf);
    this._transferred += bytes.byteLength;

    // Route to the appropriate sink. Sink writes go through _writeChain so concurrent
    // _onChunk calls can't issue overlapping writes (in arrival order). _flushed only
    // advances once a write completed — it is the only safe resume point.
    try {
      if (this._zip) {
        // Bundle bytes count as flushed once handed to client-zip; the resume driver
        // drains the zip pipeline (quiesce) before trusting _flushed as a resume point.
        if (this._zipController) {
          this._zipController.enqueue(bytes);
          this._flushed += bytes.byteLength;
        }
      } else if (this._sink) {
        const sink = this._sink;
        const size = bytes.byteLength;
        this._writeChain = this._writeChain.then(async () => {
          await sink.write(bytes);
          this._flushed += size;
        });
        await this._writeChain;
      }
    } catch (err) {
      console.error('Sink write failed:', err);
      this._aborted = true;
      this._terminateReceive(conn, 'sink-write-failed');
      return;
    }

    // Progress UI (single-file mode)
    const progress = this._size > 0 ? Math.floor(this._transferred / this._size * 100) : 0;
    if (!this._zip) {
      $set(`file-${this._id}-progress`, 'textContent', `${progress}% | `);
    }

    // Notify the sender of progress, throttled.
    const shouldReport =
      this._transferred === this._size ||
      this._transferred - this._lastProgressReportAt >= PROGRESS_REPORT_INTERVAL;
    if (shouldReport) {
      this._lastProgressReportAt = this._transferred;
      try { conn.dataChannel.send(JSON.stringify({ type: 'progress', percent: progress })); } catch {}
    }
  }

  // Receiver side: the sender told us the transfer died on its end. A watchdog loss or
  // sender send-failure leaves the file intact on their side — pause and resume with a
  // new connection. Anything else (read failure, file removed) is terminal.
  async _onSenderCancel(conn, msg) {
    if (this._conn !== conn) return;
    const reason = msg && msg.reason;
    const target = this._zip ? this._zipController : this._sink;
    if (target && RESUMABLE_CANCEL_REASONS.has(reason)) {
      await this._interrupt(conn, `sender-${reason}`);
      return;
    }
    this._aborted = true;
    this._terminateReceive(conn, 'sender-cancel', 'The sender stopped the transfer.');
  }

  async _onEnd(conn) {
    this._clearStall();
    // Never finalize a file whose byte count disagrees with what was announced —
    // that would mark a corrupt/truncated transfer as a success.
    if (this._transferred !== this._size) {
      console.error(`Incomplete transfer: ${this._transferred}/${this._size} bytes received.`);
      this._terminateReceive(conn, 'incomplete', 'The transfer was incomplete.');
      return;
    }

    if (this._zip) {
      if (this._zipController) {
        try { this._zipController.close(); } catch {}
        this._zipController = null;
      }
    } else if (this._sink) {
      // Drain queued writes before closing so no chunk is lost.
      try { await this._writeChain; await this._sink.close(); }
      catch (err) {
        console.error('Sink close failed:', err);
        this._terminateReceive(conn, 'sink-close-failed', 'Could not save the download.');
        return;
      }
      this._sink = null;

      // UI: success state
      $set(`file-${this._id}-progress`, 'textContent', '');
      $style(`file-${this._id}-download`, 'display', 'block');
      $style(`file-${this._id}-abort`, 'display', 'none');
      $style(`file-${this._id}-icon-loading`, 'display', 'none');
      $style(`file-${this._id}-icon-success`, 'display', 'block');
    }

    this._in_progress = false;
    this._resumeOffset = 0;
    this._flushed = 0;

    try { conn.close(); } catch {}
    try { this._peer.destroy(); } catch {}
  }

  _onFileProgress(conn, data) {
    // Sender-side: track per-receiver progress so 'See details' is accurate.
    if (data && conn) {
      this._remotePeers[conn.peer].progress = data.progress
    }

    const onlinePeers = Object.values(this._remotePeers).filter(x => x.online)
    const totalProgress = onlinePeers.reduce((sum, x) => sum + x.progress, 0)
    const overall_progress = onlinePeers.length == 0 ? 0 : Math.floor(totalProgress / onlinePeers.length)

    $set(`file-${this._id}-progress`, 'textContent', `${overall_progress}% | `);

    if (overall_progress == 100) {
      $style(`file-${this._id}-abort`, 'display', 'none');
      $style(`file-${this._id}-icon-loading`, 'display', 'none');
      $style(`file-${this._id}-icon-success`, 'display', 'block');
    }
    else if (!this._aborted && onlinePeers.filter(x => !x.aborted).length == 0) {
      const anyLost = Object.values(this._remotePeers).some(x => x.lost);
      $style(`file-${this._id}-icon-loading`, 'display', 'none');
      $style(`file-${this._id}-error`, 'display', 'block');
      $set(`file-${this._id}-error`, 'textContent', anyLost
        ? 'The connection to a receiver was lost.'
        : 'All users stopped the file transfer.');
    }
  }

  _onFileAborted(conn) {
    this._remotePeers[conn.peer].aborted = true
    this._onFileProgress()
  }

  _handleClose(conn) {
    // Sender side: this._remotePeers holds the per-receiver Peer; destroy that one.
    if (conn.peer in this._remotePeers) {
      try { this._remotePeers[conn.peer].peer.destroy() } catch {}
      return;
    }
    // Receiver side, mid-transfer: pause (keep the sink + resume point) when the
    // download is resumable; otherwise clean up fully — never leave a half-written
    // file or a dangling per-file Peer.
    if (this._transferred < this._size && this._in_progress) {
      const target = this._zip ? this._zipController : this._sink;
      if (target) {
        this._interrupt(conn, 'connection-closed');
      } else {
        this._terminateReceive(conn, 'connection-closed', 'The connection was lost.');
      }
    } else if (this._in_progress && (this._sink || this._zip) && this._transferred >= this._size) {
      // Every byte arrived but the channel closed before the explicit 'end' frame
      // (e.g. the sender's tab closed right after the last chunk). Finalize as a
      // success instead of stranding the data in an unclosed sink and leaving the
      // row stuck in_progress.
      this._onEnd(conn);
    }
  }

  _handleError(err) {
    if (['disconnected', 'network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      console.warn(`File peer recoverable error (${err.type}).`);
      return;
    }
    console.error('File peer error:', err);
  }

  async _getUUID() {
    const response = await fetch(`/api/uuid`);
    if (!response.ok) throw new Error(`uuid endpoint failed: HTTP ${response.status}`);
    const data = await response.json();
    return data['uuid'];
  }
}

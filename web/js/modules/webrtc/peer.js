// Native WebRTC client. Replaces the PeerJS library wrapper.
//
// Public surface matches the subset of PeerJS that FileSync uses:
//
//   new Peer(id, { host, port, path, secure, config: { iceServers } })
//   peer.id                         → string
//   peer.destroyed                  → boolean
//   peer.on('open' | 'connection' | 'disconnected' | 'error', cb)
//   peer.connect(otherId, { serialization?: 'binary' | 'raw', reliable?: boolean })
//                                    → DataConnection
//   peer.reconnect()
//   peer.destroy()
//
//   conn.peer                       → string  (remote peer id)
//   conn.peerConnection             → RTCPeerConnection
//   conn.dataChannel                → RTCDataChannel
//   conn.open                       → boolean
//   conn.on('open' | 'data' | 'close' | 'error', cb)
//   conn.send(data)
//   conn.close()
//
// Error shape: { type, message } where `type` matches the PeerJS-compatible strings the
// existing FileSync code switches on (browser-incompatible, invalid-id, unavailable-id,
// disconnected, network, server-error, socket-error, socket-closed, peer-unavailable,
// webrtc).
//
// Wire protocol with the FileSync signaling server (api/main.py /ws):
//   C→S: { type: 'register', id }
//   S→C: { type: 'registered', id }   OR   { type: 'error', code, message }
//   C→S: { type: 'signal', to, payload }
//   S→C: { type: 'signal', from, payload }
//   S→C: { type: 'peer-unavailable', id }
//   C→S: { type: 'ping' }   ←→   S→C: { type: 'pong' }
//
// Signal payloads (opaque to the server):
//   { kind: 'offer',     connectionId, sdp, label, serialization, reliable }
//   { kind: 'answer',    connectionId, sdp }
//   { kind: 'candidate', connectionId, candidate }
//   { kind: 'close',     connectionId }

// --------------------------------------------------------------------------------------
// EventEmitter — tiny, sync, matches the surface FileSync uses (on, emit, off).
// --------------------------------------------------------------------------------------

class EventEmitter {
  constructor() { this._handlers = Object.create(null); }
  on(event, fn) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(fn);
    return this;
  }
  off(event, fn) {
    const list = this._handlers[event];
    if (!list) return this;
    if (!fn) { delete this._handlers[event]; return this; }
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
    return this;
  }
  emit(event, ...args) {
    const list = this._handlers[event];
    if (!list) return false;
    // Iterate over a snapshot so handlers can mutate the list safely.
    for (const fn of list.slice()) {
      try { fn(...args); }
      catch (err) { console.error(`Listener for '${event}' threw:`, err); }
    }
    return true;
  }
}

// --------------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------------

function randomId(prefix = '') {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return prefix + hex;
}

function makeError(type, message) {
  const err = new Error(message);
  err.type = type;
  return err;
}

// --------------------------------------------------------------------------------------
// DataConnection
// --------------------------------------------------------------------------------------

const SERIALIZATION_BINARY = 'binary';
const SERIALIZATION_RAW = 'raw';

class DataConnection extends EventEmitter {
  constructor(peer, remoteId, opts) {
    super();
    this._peer = peer;
    this._remoteId = remoteId;
    this._connectionId = (opts && opts.connectionId) || randomId('dc_');
    this._serialization = (opts && opts.serialization) || SERIALIZATION_BINARY;
    this._reliable = (opts && opts.reliable !== false);
    this._label = (opts && opts.label) || this._connectionId;
    this._open = false;
    this._closed = false;
    this._pc = null;
    this._dc = null;
    // ICE candidates may arrive before we've applied the remote SDP — queue them up.
    this._pendingCandidates = [];
    this._remoteDescriptionSet = false;
  }

  get peer() { return this._remoteId; }
  get peerConnection() { return this._pc; }
  get dataChannel() { return this._dc; }
  get open() { return this._open; }
  get connectionId() { return this._connectionId; }
  get serialization() { return this._serialization; }

  // ---- Connection lifecycle ------------------------------------------------------------

  async _initOutbound(rtcConfig) {
    this._pc = new RTCPeerConnection(rtcConfig);
    this._wireRtcEvents();

    // The originator creates the data channel BEFORE creating the offer so that the
    // offer SDP includes the data section.
    this._dc = this._pc.createDataChannel(this._label, { ordered: true });
    this._wireDataChannelEvents();

    let offer;
    try {
      offer = await this._pc.createOffer();
      await this._pc.setLocalDescription(offer);
    } catch (err) {
      this.emit('error', makeError('webrtc', `Failed to create offer: ${err && err.message || err}`));
      this.close();
      return;
    }

    this._peer._sendSignal(this._remoteId, {
      kind: 'offer',
      connectionId: this._connectionId,
      sdp: offer.sdp,
      label: this._label,
      serialization: this._serialization,
      reliable: this._reliable,
    });
  }

  async _initInbound(rtcConfig, offerPayload) {
    this._pc = new RTCPeerConnection(rtcConfig);
    this._wireRtcEvents();

    // The answerer doesn't create the channel — it appears via ondatachannel.
    this._pc.ondatachannel = (ev) => {
      this._dc = ev.channel;
      this._wireDataChannelEvents();
    };

    try {
      await this._pc.setRemoteDescription({ type: 'offer', sdp: offerPayload.sdp });
      this._remoteDescriptionSet = true;
      await this._drainPendingCandidates();
      const answer = await this._pc.createAnswer();
      await this._pc.setLocalDescription(answer);
      this._peer._sendSignal(this._remoteId, {
        kind: 'answer',
        connectionId: this._connectionId,
        sdp: answer.sdp,
      });
    } catch (err) {
      this.emit('error', makeError('webrtc', `Failed to answer: ${err && err.message || err}`));
      this.close();
    }
  }

  async _handleSignal(payload) {
    if (!payload || typeof payload !== 'object') return;
    try {
      if (payload.kind === 'answer') {
        if (!this._pc) return;
        await this._pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        this._remoteDescriptionSet = true;
        await this._drainPendingCandidates();
      } else if (payload.kind === 'candidate') {
        if (!this._pc) return;
        const cand = payload.candidate;
        // null/empty candidate is an end-of-candidates marker — browsers detect gathering
        // completion natively, so we don't need to do anything with it.
        if (cand == null) return;
        if (!this._remoteDescriptionSet) {
          this._pendingCandidates.push(cand);
        } else {
          try { await this._pc.addIceCandidate(cand); }
          catch (err) { console.warn('addIceCandidate failed:', err); }
        }
      } else if (payload.kind === 'close') {
        this.close();
      }
    } catch (err) {
      this.emit('error', makeError('webrtc', `Signal handling failed: ${err && err.message || err}`));
    }
  }

  async _drainPendingCandidates() {
    const pending = this._pendingCandidates;
    this._pendingCandidates = [];
    for (const cand of pending) {
      if (cand == null) continue;
      try { await this._pc.addIceCandidate(cand); }
      catch (err) { console.warn('addIceCandidate (drained) failed:', err); }
    }
  }

  _wireRtcEvents() {
    this._pc.onicecandidate = (ev) => {
      if (this._closed) return;
      // ev.candidate === null is the end-of-candidates marker; the remote side detects
      // gathering completion via its own state, so no need to forward it.
      if (!ev.candidate) return;
      this._peer._sendSignal(this._remoteId, {
        kind: 'candidate',
        connectionId: this._connectionId,
        candidate: ev.candidate.toJSON(),
      });
    };

    this._pc.oniceconnectionstatechange = () => {
      if (!this._pc) return;
      const state = this._pc.iceConnectionState;
      if (this._closed) return;
      if (state === 'failed') {
        this.emit('error', makeError('webrtc', 'ICE state failed'));
        this.close();
      } else if (state === 'closed') {
        // Peer/network closed the connection cleanly — not an error, just a close.
        this.close();
      }
    };
  }

  _wireDataChannelEvents() {
    if (!this._dc) return;
    this._dc.binaryType = 'arraybuffer';
    this._dc.onopen = () => {
      this._open = true;
      this.emit('open');
    };
    this._dc.onclose = () => {
      this._open = false;
      if (!this._closed) {
        this._closed = true;
        this.emit('close');
      }
    };
    this._dc.onerror = (ev) => {
      const e = ev && ev.error;

      // Chromium reports the remote side calling close() as an SCTP "User-Initiated
      // Abort" RTCError, fired BEFORE the corresponding 'close' event. This is normal
      // protocol-level behavior, not a real failure — suppress it so applications
      // don't see a spurious error after every successful transfer.
      //
      // Match conditions (any one suffices):
      //   1. RTCError with the documented spec fields (modern Chromium).
      //   2. Message string match (older Chromium / cross-browser fallback).
      //   3. We're already in (or transitioning into) a closed state — any error at
      //      that point is part of teardown noise and the caller has no recovery to do.
      const dcState = this._dc && this._dc.readyState;
      const inClosingState = dcState === 'closing' || dcState === 'closed' || this._closed;
      const isCloseAbort =
        e && (
          (e.errorDetail === 'sctp-failure' && e.sctpCauseCode === 12) ||
          (typeof e.message === 'string' && e.message.includes('User-Initiated Abort'))
        );
      if (inClosingState || isCloseAbort) return;

      this.emit('error', makeError('webrtc', e ? (e.message || String(e)) : 'DataChannel error'));
    };
    this._dc.onmessage = (ev) => {
      let payload = ev.data;
      if (this._serialization === SERIALIZATION_BINARY && typeof payload === 'string') {
        // Auto-decode JSON envelopes. Only attempt parse for things that look like
        // JSON containers; arbitrary strings remain as strings.
        if (payload.length > 0 && (payload[0] === '{' || payload[0] === '[')) {
          try { payload = JSON.parse(payload); }
          catch { /* leave as string */ }
        }
      }
      this.emit('data', payload);
    };
  }

  // ---- Public API ----------------------------------------------------------------------

  send(data) {
    if (!this._dc || this._dc.readyState !== 'open') {
      this.emit('error', makeError('webrtc', 'Connection is not open.'));
      return;
    }
    try {
      if (data instanceof ArrayBuffer) {
        this._dc.send(data);
      } else if (ArrayBuffer.isView(data)) {
        // Send a tight copy so the receiver gets exactly these bytes.
        this._dc.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      } else if (typeof data === 'string') {
        this._dc.send(data);
      } else if (this._serialization === SERIALIZATION_RAW) {
        // In raw mode the caller is responsible for framing; we don't auto-encode.
        this.emit('error', makeError('webrtc', 'Raw connection only accepts strings or binary data.'));
      } else {
        this._dc.send(JSON.stringify(data));
      }
    } catch (err) {
      this.emit('error', makeError('webrtc', `send failed: ${err && err.message || err}`));
    }
  }

  close() {
    const firstClose = !this._closed;
    this._closed = true;
    this._open = false;
    // Best-effort polite goodbye; the peer doesn't strictly need it.
    if (firstClose && this._peer && !this._peer.destroyed) {
      this._peer._sendSignal(this._remoteId, { kind: 'close', connectionId: this._connectionId });
    }
    // Always tear down the transport, even when the remote closed first (the dc
    // 'close' handler sets _closed) — otherwise the RTCPeerConnection leaks.
    if (this._dc) {
      try { this._dc.onopen = this._dc.onmessage = this._dc.onclose = this._dc.onerror = null; } catch {}
      try { this._dc.close(); } catch {}
    }
    if (this._pc) {
      try { this._pc.onicecandidate = this._pc.oniceconnectionstatechange = this._pc.ondatachannel = null; } catch {}
      try { this._pc.close(); } catch {}
    }
    if (this._peer) this._peer._unregisterConnection(this);
    if (firstClose) this.emit('close');
  }
}

// --------------------------------------------------------------------------------------
// Peer
// --------------------------------------------------------------------------------------

// Client pings every 10s; server idle-disconnects at 30s. The 3x margin tolerates one
// missed ping without a server-side reap, while the short interval keeps the reconnect
// path responsive: after a network blip the server clears the stale entry within ~30s
// and the new registration takes over immediately (server allows takeover, see
// api/main.py:_PeerRegistry.register).
const _PING_INTERVAL_MS = 10000;

class Peer extends EventEmitter {
  constructor(id, opts = {}) {
    super();
    this._id = id;
    this._opts = opts;
    // Full RTCConfiguration (iceServers + iceTransportPolicy etc.) — callers like
    // mode.js set policy here, so it must reach the RTCPeerConnection verbatim.
    this._rtcConfig = (opts.config && typeof opts.config === 'object') ? opts.config : {};
    this._wsUrl = this._buildSignalUrl(opts);
    this._ws = null;
    this._destroyed = false;
    this._connections = new Map();  // connectionId -> DataConnection
    this._socketOpened = false;
    this._pingTimer = null;
    // Queue outbound signals that arrive before the WS is open.
    this._signalQueue = [];

    // Match PeerJS: validate browser support synchronously and emit a fatal error
    // asynchronously so subscribers attached after construction still see it.
    if (typeof RTCPeerConnection === 'undefined') {
      queueMicrotask(() => this.emit('error', makeError('browser-incompatible', 'WebRTC is not supported.')));
      return;
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id || '')) {
      queueMicrotask(() => this.emit('error', makeError('invalid-id', 'Peer id is invalid.')));
      return;
    }

    this._connect();
  }

  get id() { return this._id; }
  get destroyed() { return this._destroyed; }

  // ---- Signaling socket ----------------------------------------------------------------

  _buildSignalUrl(opts) {
    const isSecure = opts.secure ?? (typeof window !== 'undefined' && window.location.protocol === 'https:');
    const proto = isSecure ? 'wss' : 'ws';
    const host = opts.host || (typeof window !== 'undefined' ? window.location.hostname : 'localhost');
    const port = opts.port || (typeof window !== 'undefined' ? (window.location.port || (isSecure ? 443 : 80)) : (isSecure ? 443 : 80));
    return `${proto}://${host}:${port}/ws`;
  }

  _connect() {
    if (this._destroyed) return;
    // Tear down any existing socket (including connecting ones) before opening a new one.
    // This guards against the race where reconnect() is called while a previous _connect()
    // is still in WebSocket.CONNECTING state.
    if (this._ws) {
      try { this._ws.onopen = this._ws.onmessage = this._ws.onerror = this._ws.onclose = null; } catch {}
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
    let ws;
    try {
      ws = new WebSocket(this._wsUrl);
    } catch (err) {
      this.emit('error', makeError('socket-error', `WebSocket construct failed: ${err && err.message || err}`));
      return;
    }
    this._ws = ws;

    ws.onopen = () => {
      this._socketOpened = true;
      // Register first; everything else waits for 'registered'.
      try {
        ws.send(JSON.stringify({ type: 'register', id: this._id }));
      } catch (err) {
        this.emit('error', makeError('socket-error', `WS send failed: ${err && err.message || err}`));
        return;
      }
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); }
      catch { return; }
      if (!msg || typeof msg !== 'object') return;
      this._handleSignalingMessage(msg);
    };

    ws.onerror = () => {
      // The browser fires a generic 'error' here; details are in 'close'.
      if (!this._destroyed) this.emit('error', makeError('socket-error', 'Signaling socket error.'));
    };

    ws.onclose = (ev) => {
      // Only react if this is still the active socket (a fresh _connect may have replaced it).
      if (this._ws !== ws) return;
      this._ws = null;
      this._stopPing();
      const wasOpen = this._socketOpened;
      this._socketOpened = false;

      // App-level errors come through close codes 4400-4499. These are fatal — caller
      // should not call reconnect().
      if (ev.code === 4400 /* invalid register/message */) {
        this.emit('error', makeError('invalid-id', ev.reason || 'Invalid register.'));
        return;
      }
      if (ev.code === 4409 /* unavailable id */) {
        this.emit('error', makeError('unavailable-id', ev.reason || 'Peer id already in use.'));
        return;
      }

      if (this._destroyed) return;
      // Notify the application; reconnect strategy is owned by the application (matches
      // PeerJS semantics: reconnect() is explicit, not automatic). user.js and file.js
      // already implement backoff + reconnect on 'disconnected'.
      if (wasOpen) {
        this.emit('disconnected');
      } else {
        // We never opened — surface as a network error so the caller can show UI.
        this.emit('error', makeError('network', 'Failed to reach signaling server.'));
      }
    };
  }

  _handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'registered':
        this._startPing();
        this._flushSignalQueue();
        // Emit 'open' on every successful (re-)registration. Matches PeerJS semantics
        // (server sends OPEN on reconnect and the client re-emits) and lets the
        // application reset its reconnect-attempt counter.
        this.emit('open', this._id);
        return;
      case 'signal': {
        const from = msg.from;
        const payload = msg.payload;
        if (typeof from !== 'string' || !payload || typeof payload !== 'object') return;
        this._handleIncomingSignal(from, payload);
        return;
      }
      case 'peer-unavailable': {
        // Route to any pending DataConnections targeting this peer so callers waiting on
        // conn.on('open') / conn.on('error') get a deterministic failure instead of
        // hanging until ICE times out. If no pending connection matches (e.g., the
        // unavailable signal is for a 'close' echo to an already-closed conn), surface
        // it on the Peer instead so existing listeners still see something.
        const err = makeError('peer-unavailable', `Could not reach peer ${msg.id}`);
        let routed = false;
        for (const conn of Array.from(this._connections.values())) {
          if (conn._remoteId === msg.id && !conn._open && !conn._closed) {
            conn.emit('error', err);
            conn.close();
            routed = true;
          }
        }
        if (!routed) this.emit('error', err);
        return;
      }
      case 'error': {
        const code = msg.code;
        const messageText = msg.message || code || 'Server error.';
        const mapping = {
          'invalid-id': 'invalid-id',
          'unavailable-id': 'unavailable-id',
          'invalid-message': 'server-error',
          'rate-limited': 'server-error',
        };
        this.emit('error', makeError(mapping[code] || 'server-error', messageText));
        return;
      }
      case 'pong':
        return;
      default:
        // Unknown — ignore for forward compatibility.
        return;
    }
  }

  async _handleIncomingSignal(fromId, payload) {
    const connId = payload && payload.connectionId;
    if (typeof connId !== 'string') return;

    if (payload.kind === 'offer') {
      // Guard against duplicate offers (e.g. a signal queued during a WS reconnect
      // gets replayed). The first offer already created the connection; ignore.
      if (this._connections.has(connId)) return;

      const conn = new DataConnection(this, fromId, {
        connectionId: connId,
        serialization: payload.serialization || SERIALIZATION_BINARY,
        reliable: payload.reliable !== false,
        label: payload.label,
      });
      this._connections.set(connId, conn);
      // Wire up 'open' notification to the Peer's 'connection' event, matching PeerJS.
      // Existing FileSync code subscribes to 'connection' and then to conn.on('open').
      this.emit('connection', conn);
      await conn._initInbound(this._rtcConfig, payload);
      return;
    }

    const existing = this._connections.get(connId);
    if (!existing) {
      // Late candidate or close for a connection we've already torn down — ignore.
      return;
    }
    await existing._handleSignal(payload);
  }

  _sendSignal(toId, payload) {
    const env = { type: 'signal', to: toId, payload };
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.send(JSON.stringify(env)); }
      catch (err) {
        console.warn('Signal send failed; queueing:', err);
        this._signalQueue.push(env);
      }
    } else {
      this._signalQueue.push(env);
    }
  }

  _flushSignalQueue() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const queue = this._signalQueue;
    this._signalQueue = [];
    for (const env of queue) {
      try { this._ws.send(JSON.stringify(env)); }
      catch (err) {
        // Put back and stop trying for now.
        this._signalQueue.unshift(env);
        console.warn('Signal flush failed:', err);
        return;
      }
    }
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        try { this._ws.send(JSON.stringify({ type: 'ping' })); } catch {}
      }
    }, _PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  // ---- Public API ----------------------------------------------------------------------

  connect(otherId, opts = {}) {
    if (this._destroyed) {
      const err = makeError('disconnected', 'Cannot connect from a destroyed peer.');
      queueMicrotask(() => this.emit('error', err));
      // Return a stub that immediately closes so callers don't crash.
      const stub = new DataConnection(this, otherId, opts);
      queueMicrotask(() => stub.emit('error', err));
      return stub;
    }
    const conn = new DataConnection(this, otherId, {
      ...opts,
      connectionId: opts.connectionId || randomId('dc_'),
    });
    this._connections.set(conn.connectionId, conn);
    // Fire-and-forget; SDP exchange happens asynchronously.
    conn._initOutbound(this._rtcConfig).catch((err) => {
      conn.emit('error', makeError('webrtc', err && err.message || String(err)));
    });
    return conn;
  }

  reconnect() {
    if (this._destroyed) {
      throw new Error('This peer cannot reconnect to the server. It has already been destroyed.');
    }
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      // Already connected — nothing to do.
      return;
    }
    this._connect();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._stopPing();
    for (const conn of Array.from(this._connections.values())) {
      try { conn.close(); } catch {}
    }
    this._connections.clear();
    if (this._ws) {
      try { this._ws.onopen = this._ws.onmessage = this._ws.onerror = this._ws.onclose = null; } catch {}
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
    this.emit('close');
  }

  _unregisterConnection(conn) {
    this._connections.delete(conn.connectionId);
  }
}

export { Peer, DataConnection };

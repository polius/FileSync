// In-memory stand-ins for the signaling socket, WebRTC links and data channels, so the
// room protocol and the transfer engine run end to end in Node without a browser.

import { Emitter } from '../../../web/js/app/util.js';

// ---- data channels ---------------------------------------------------------------------

class FakeChannel {
  constructor(label) {
    this.label = label;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.binaryType = 'arraybuffer';
    this.peer = null;
    this.listeners = new Map();
    this.tamper = null;      // (data) => data, to corrupt bytes in tests
    this.sentBytes = 0;
  }
  addEventListener(type, fn, opts) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    const wrapped = opts?.once ? (ev) => { this.removeEventListener(type, wrapped); fn(ev); } : fn;
    wrapped.orig = fn;
    this.listeners.get(type).add(wrapped);
  }
  removeEventListener(type, fn) {
    for (const l of this.listeners.get(type) || []) if (l === fn || l.orig === fn) this.listeners.get(type).delete(l);
  }
  dispatch(type, ev = {}) {
    const handler = this[`on${type}`];
    if (typeof handler === 'function') handler(ev);
    for (const l of [...(this.listeners.get(type) || [])]) l(ev);
  }
  send(data) {
    if (this.readyState !== 'open') throw new Error('InvalidStateError: channel not open');
    let copy = typeof data === 'string' ? data : (ArrayBuffer.isView(data) ? data.slice().buffer : data.slice(0));
    if (this.tamper) copy = this.tamper(copy);
    const size = typeof copy === 'string' ? copy.length : copy.byteLength;
    this.sentBytes += typeof copy === 'string' ? 0 : size;
    this.bufferedAmount += size;
    setTimeout(() => {
      this.bufferedAmount -= size;
      if (this.bufferedAmount <= this.bufferedAmountLowThreshold) this.dispatch('bufferedamountlow');
      if (this.peer?.readyState === 'open') this.peer.dispatch('message', { data: copy });
    }, 0);
  }
  // Like RTCDataChannel: messages already sent are still delivered, then both ends close.
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    setTimeout(() => {
      this.dispatch('close');
      if (this.peer && this.peer.readyState !== 'closed') this.peer.close();
    }, 0);
  }
}

export function channelPair(label = 'x:test') {
  const a = new FakeChannel(label);
  const b = new FakeChannel(label);
  a.peer = b;
  b.peer = a;
  setTimeout(() => {
    a.readyState = 'open';
    b.readyState = 'open';
    a.dispatch('open');
    b.dispatch('open');
  }, 0);
  return [a, b];
}

// ---- links and network -----------------------------------------------------------------

class FakeLink extends Emitter {
  constructor(localId, remoteId, initiator, verified) {
    super();
    this.localId = localId;
    this.remoteId = remoteId;
    this.initiator = initiator;
    this.verified = verified;
    this.state = 'connecting';
    this.peer = null;
    this.pc = { sctp: { maxMessageSize: 262144 } };
    this.sent = [];
  }
  send(msg) {
    if (this.state !== 'open') return false;
    this.sent.push(msg);
    const copy = JSON.parse(JSON.stringify(msg));
    setTimeout(() => { if (this.peer?.state === 'open') this.peer.emit('message', copy); }, 0);
    return true;
  }
  openChannel(label) {
    if (this.state !== 'open') throw new Error('link-not-open');
    const [mine, theirs] = channelPair(label);
    this.lastChannel = mine;
    setTimeout(() => this.peer?.emit('channel', theirs), 0);
    return mine;
  }
  open() {
    this.state = 'open';
    this.emit('open');
  }
  close(reason = 'closed') {
    if (this.state === 'down') return;
    const wasOpen = this.state === 'open';
    this.state = 'down';
    this.emit('down', reason, wasOpen);
    const peer = this.peer;
    if (peer && peer.state !== 'down') setTimeout(() => peer.close('remote-closed'), 0);
  }
}

export class Hub {
  constructor() {
    this.nets = new Map();
    const hub = this;

    this.Signaling = class extends Emitter {
      constructor(id, token) {
        super();
        this.id = id;
        this.token = token;
        this.state = 'connecting';
        this.version = 'test';
      }
      start() {
        // Same rule as the server: a different token can't take an id that's in use.
        const holder = hub.tokens.get(this.id);
        if (holder && holder !== this.token) {
          setTimeout(() => this.emit('fatal', 'taken'), 0);
          return;
        }
        hub.tokens.set(this.id, this.token);
        setTimeout(() => { this.state = 'online'; this.emit('state', 'online'); this.emit('open'); }, 0);
      }
      stop() { this.state = 'stopped'; }
      send() {}
      async iceServers() { return []; }
    };

    this.Network = class extends Emitter {
      constructor({ signaling, key, accept }) {
        super();
        this.signaling = signaling;
        this.key = key || null;
        this.accept = accept;
        this.links = new Map();
        hub.nets.set(signaling.id, this);
      }
      get localId() { return this.signaling.id; }
      link(id) {
        const l = this.links.get(id);
        return l && l.state !== 'down' ? l : null;
      }
      connect(remoteId) {
        const existing = this.link(remoteId);
        if (existing) return existing;
        const remote = hub.nets.get(remoteId);
        const verified = !!(this.key && remote?.key && this.key === remote.key);
        const mine = new FakeLink(this.localId, remoteId, true, verified);
        this.track(mine);
        setTimeout(async () => {
          if (!remote || hub.offline.has(remoteId)) return mine.close('unavailable');
          const ok = await remote.accept(this.localId);
          if (!ok) return mine.close('rejected');
          const theirs = new FakeLink(remoteId, this.localId, false, verified);
          mine.peer = theirs;
          theirs.peer = mine;
          remote.track(theirs);
          remote.emit('link', theirs);
          setTimeout(() => { mine.open(); theirs.open(); }, 0);
        }, 0);
        return mine;
      }
      track(link) {
        this.links.get(link.remoteId)?.close('replaced');
        this.links.set(link.remoteId, link);
        link.on('down', () => { if (this.links.get(link.remoteId) === link) this.links.delete(link.remoteId); });
      }
      closeAll(reason) {
        for (const l of this.links.values()) l.close(reason);
        this.links.clear();
      }
    };

    this.tokens = new Map();
    this.offline = new Set();
  }

  // Simulate a peer's network dying: its links drop without a goodbye.
  disconnect(id) {
    const net = this.nets.get(id);
    if (!net) return;
    for (const l of [...net.links.values()]) l.close('failed');
  }
}

// ---- sinks -------------------------------------------------------------------------------

export function memorySink({ failAt = -1 } = {}) {
  const chunks = [];
  let size = 0;
  return {
    mode: 'memory',
    chunks,
    closed: false,
    aborted: null,
    async write(bytes) {
      if (failAt >= 0 && size + bytes.byteLength > failAt) throw new Error('disk full');
      chunks.push(bytes.slice());
      size += bytes.byteLength;
    },
    async close() { this.closed = true; },
    async abort(reason) { this.aborted = reason; },
    bytes() {
      const out = new Uint8Array(size);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.byteLength; }
      return out;
    },
  };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, { timeout = 5000, step = 5 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('until(): condition not met in time');
    await tick(step);
  }
}

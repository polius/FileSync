// Signaling client: one WebSocket to the FileSync server, used only to find peers and
// exchange WebRTC offers, answers and ICE candidates. File bytes never touch it.
//
// Wire protocol (see api/signaling.py):
//   C->S {type:'register', id, token}      S->C {type:'registered', id, version, ice:{iceServers, ttl}}
//   C->S {type:'signal', to, payload}      S->C {type:'signal', from, payload}
//   C->S {type:'ice'}                      S->C {type:'ice', iceServers, ttl}
//   C->S {type:'ping'}                     S->C {type:'pong'}
//   S->C {type:'peer-unavailable', id}     S->C {type:'error', code, message}
//
// The token proves we own `id`: the server refuses anyone else registering it, and holds
// the claim for a short grace period after a disconnect so a reload keeps the same id.

import { Emitter, sleep } from './util.js';

const PING_MS = 20_000;
const MAX_QUEUE = 500;
const ICE_REFRESH_MARGIN_S = 600;

// Close codes that mean "don't retry": the id is someone else's, our own newer tab took
// over, or we sent something the server rejects outright.
const FATAL = { 4400: 'invalid', 4409: 'taken', 4410: 'replaced' };

export class Signaling extends Emitter {
  #id;
  #token;
  #ws = null;
  #queue = [];
  #ping = null;
  #attempt = 0;
  #closed = false;
  #ice = null;          // { iceServers, expiresAt }
  #iceWaiters = [];
  state = 'connecting'; // connecting | online | reconnecting | stopped
  version = '';

  constructor(id, token) {
    super();
    this.#id = id;
    this.#token = token;
  }

  get id() { return this.#id; }

  start() {
    this.#connect();
  }

  stop() {
    this.#closed = true;
    this.#setState('stopped');
    clearInterval(this.#ping);
    if (this.#ws) {
      this.#ws.onclose = null;
      try { this.#ws.close(1000); } catch { /* ignore */ }
      this.#ws = null;
    }
  }

  send(to, payload) {
    const msg = { type: 'signal', to, payload };
    if (this.#ws?.readyState === WebSocket.OPEN && this.state === 'online') this.#ws.send(JSON.stringify(msg));
    else if (this.#queue.length < MAX_QUEUE) this.#queue.push(msg);
  }

  // Current ICE servers, refreshed over the socket when the TURN credentials near expiry.
  async iceServers() {
    const now = Date.now() / 1000;
    if (this.#ice && this.#ice.expiresAt - now > ICE_REFRESH_MARGIN_S) return this.#ice.iceServers;
    if (this.state === 'online') this.#ws.send(JSON.stringify({ type: 'ice' }));
    const fresh = await Promise.race([
      new Promise((resolve) => this.#iceWaiters.push(resolve)),
      sleep(8000).then(() => null),
    ]);
    if (fresh) return fresh;
    if (this.#ice) return this.#ice.iceServers; // stale but better than nothing
    throw new Error('No ICE servers from the signaling server.');
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  #connect() {
    if (this.#closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch (err) {
      console.warn('WebSocket failed to open:', err);
      this.#retry();
      return;
    }
    this.#ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'register', id: this.#id, token: this.#token }));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && typeof msg === 'object') this.#onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      clearInterval(this.#ping);
      const fatal = FATAL[ev.code];
      if (fatal) {
        this.#closed = true;
        this.#setState('stopped');
        this.emit('fatal', fatal);
        return;
      }
      this.#retry();
    };
  }

  async #retry() {
    if (this.#closed) return;
    this.#setState('reconnecting');
    const delay = Math.min(30_000, 1000 * 2 ** this.#attempt) * (0.75 + Math.random() * 0.5);
    this.#attempt += 1;
    await sleep(delay);
    this.#connect();
  }

  #onMessage(msg) {
    switch (msg.type) {
      case 'registered': {
        this.#attempt = 0;
        this.version = typeof msg.version === 'string' ? msg.version : '';
        this.#acceptIce(msg.ice);
        this.#setState('online');
        clearInterval(this.#ping);
        this.#ping = setInterval(() => {
          if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send('{"type":"ping"}');
        }, PING_MS);
        const queued = this.#queue;
        this.#queue = [];
        for (const m of queued) this.#ws.send(JSON.stringify(m));
        this.emit('open');
        return;
      }
      case 'ice':
        this.#acceptIce(msg);
        return;
      case 'signal':
        if (typeof msg.from === 'string' && msg.payload && typeof msg.payload === 'object') {
          this.emit('signal', msg.from, msg.payload);
        }
        return;
      case 'peer-unavailable':
        if (typeof msg.id === 'string') this.emit('unavailable', msg.id);
        return;
      case 'error':
        console.warn('Signaling error:', msg.code, msg.message);
        if (msg.code === 'rate-limited') this.emit('rate-limited');
        return;
      default:
        return; // pong and anything newer
    }
  }

  #acceptIce(data) {
    if (!data || !Array.isArray(data.iceServers)) return;
    const ttl = Number.isFinite(data.ttl) ? data.ttl : 3600;
    this.#ice = { iceServers: data.iceServers, expiresAt: Date.now() / 1000 + ttl };
    const waiters = this.#iceWaiters;
    this.#iceWaiters = [];
    for (const w of waiters) w(data.iceServers);
  }
}

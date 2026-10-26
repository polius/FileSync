// PeerLink: one RTCPeerConnection between two peers, reused for everything between them.
//
// A reliable 'ctl' data channel carries JSON control messages. Each file transfer gets its
// own data channel ('x:<transfer id>') on the same connection, so starting a transfer costs
// one channel open instead of a new signaling socket, ICE negotiation and TURN allocation.
//
// Signal payloads exchanged through the server:
//   {kind:'offer'|'answer', link, sdp, mac?}   {kind:'candidate', link, candidate}   {kind:'close', link}
// `mac` authenticates our DTLS fingerprint with the link key from the URL fragment (see
// crypto.js). With a key, a missing or wrong MAC from a peer that must have the key fails
// the link: that's a man in the middle, not a network problem.

import { Emitter } from './util.js';
import { linkMac, verifyLinkMac } from './crypto.js';
import { applyIceMode } from './mode.js';

const CONNECT_TIMEOUT_MS = 25_000;
const DISCONNECT_GRACE_MS = 12_000;
// Stay under every browser's SCTP message limit (Safari historically ~64 KiB).
const MAX_CTL_MESSAGE = 60_000;
const MAX_REASSEMBLED = 16 * 1024 * 1024;

export class PeerLink extends Emitter {
  #net;
  #pc = null;
  #ctl = null;
  #pendingCandidates = [];
  #remoteSet = false;
  #timer = null;
  #parts = new Map();
  state = 'connecting'; // connecting | open | down
  verified = false;

  constructor({ net, localId, remoteId, linkId, initiator, key, mustVerify }) {
    super();
    this.#net = net;
    this.localId = localId;
    this.remoteId = remoteId;
    this.linkId = linkId;
    this.initiator = initiator;
    this.key = key || null;
    // True when the remote certainly holds the key too (a guest talking to its host).
    this.mustVerify = !!(key && mustVerify);
  }

  get pc() { return this.#pc; }

  async start(iceServers, offer = null) {
    this.#pc = new RTCPeerConnection(applyIceMode({ iceServers }));
    this.#wire();
    this.#timer = setTimeout(() => this.#down('timeout'), CONNECT_TIMEOUT_MS);
    try {
      if (this.initiator) {
        this.#adoptCtl(this.#pc.createDataChannel('ctl', { ordered: true }));
        const desc = await this.#pc.createOffer();
        await this.#pc.setLocalDescription(desc);
        this.#signal({ kind: 'offer', sdp: desc.sdp, mac: await this.#mac('offer', desc.sdp) });
      } else {
        await this.#acceptRemote('offer', offer);
        const desc = await this.#pc.createAnswer();
        await this.#pc.setLocalDescription(desc);
        this.#signal({ kind: 'answer', sdp: desc.sdp, mac: await this.#mac('answer', desc.sdp) });
      }
    } catch (err) {
      console.warn('Link setup failed:', err);
      this.#down(err?.message === 'verification-failed' ? 'verification-failed' : 'setup-failed');
    }
  }

  async handleSignal(payload) {
    if (this.state === 'down' || !this.#pc) return;
    try {
      if (payload.kind === 'answer' && this.initiator && !this.#remoteSet) {
        await this.#acceptRemote('answer', payload);
      } else if (payload.kind === 'candidate' && payload.candidate) {
        if (this.#remoteSet) await this.#pc.addIceCandidate(payload.candidate).catch(() => {});
        else if (this.#pendingCandidates.length < 200) this.#pendingCandidates.push(payload.candidate);
      } else if (payload.kind === 'close') {
        this.#down('remote-closed');
      }
    } catch (err) {
      this.#down(err?.message === 'verification-failed' ? 'verification-failed' : 'signal-failed');
    }
  }

  send(msg) {
    if (this.#ctl?.readyState !== 'open') return false;
    const text = JSON.stringify(msg);
    try {
      if (text.length <= MAX_CTL_MESSAGE) {
        this.#ctl.send(text);
      } else {
        // Large listings (welcome with many thumbnails) go out in parts.
        const id = Math.random().toString(36).slice(2);
        const n = Math.ceil(text.length / MAX_CTL_MESSAGE);
        for (let i = 0; i < n; i++) {
          this.#ctl.send(JSON.stringify({ t: '_part', id, i, n, d: text.slice(i * MAX_CTL_MESSAGE, (i + 1) * MAX_CTL_MESSAGE) }));
        }
      }
      return true;
    } catch (err) {
      console.warn('Control send failed:', err);
      return false;
    }
  }

  openChannel(label) {
    if (this.state !== 'open') throw new Error('link-not-open');
    const ch = this.#pc.createDataChannel(label, { ordered: true });
    ch.binaryType = 'arraybuffer';
    return ch;
  }

  close(reason = 'closed') {
    if (this.state === 'down') return;
    this.#signal({ kind: 'close' });
    this.#down(reason);
  }

  // ---- internals ------------------------------------------------------------------------

  #signal(body) {
    this.#net.signal(this.remoteId, { ...body, link: this.linkId });
  }

  async #mac(kind, sdp) {
    return this.key ? linkMac(this.key, kind, this.localId, this.remoteId, this.linkId, sdp) : undefined;
  }

  async #acceptRemote(kind, payload) {
    if (this.key) {
      if (typeof payload.mac === 'string') {
        const ok = await verifyLinkMac(this.key, kind, this.remoteId, this.localId, this.linkId, payload.sdp, payload.mac);
        if (!ok) throw new Error('verification-failed');
        this.verified = true;
      } else if (this.mustVerify) {
        throw new Error('verification-failed');
      }
    }
    await this.#pc.setRemoteDescription({ type: kind, sdp: payload.sdp });
    this.#remoteSet = true;
    const pending = this.#pendingCandidates;
    this.#pendingCandidates = [];
    for (const c of pending) await this.#pc.addIceCandidate(c).catch(() => {});
  }

  #wire() {
    const pc = this.#pc;
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.#signal({ kind: 'candidate', candidate: ev.candidate.toJSON() });
    };
    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      if (ch.label === 'ctl' && !this.initiator && !this.#ctl) this.#adoptCtl(ch);
      else if (ch.label.startsWith('x:')) {
        ch.binaryType = 'arraybuffer';
        this.emit('channel', ch);
      } else ch.close();
    };
    let graceTimer = null;
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') this.#down(s);
      else if (s === 'disconnected') {
        // Often recovers by itself (Wi-Fi roam, brief loss); give ICE a chance.
        clearTimeout(graceTimer);
        graceTimer = setTimeout(() => { if (pc.connectionState === 'disconnected') this.#down('disconnected'); }, DISCONNECT_GRACE_MS);
      } else if (s === 'connected') clearTimeout(graceTimer);
    };
  }

  #adoptCtl(ch) {
    this.#ctl = ch;
    ch.onopen = () => {
      clearTimeout(this.#timer);
      if (this.state !== 'connecting') return;
      this.state = 'open';
      this.emit('open');
    };
    ch.onclose = () => this.#down('channel-closed');
    ch.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && msg.t === '_part') msg = this.#reassemble(msg);
      if (msg) this.emit('message', msg);
    };
  }

  #reassemble(part) {
    const { id, i, n, d } = part;
    if (typeof id !== 'string' || !Number.isInteger(i) || !Number.isInteger(n) || n < 1 || n > 400 || i < 0 || i >= n || typeof d !== 'string') return null;
    let entry = this.#parts.get(id);
    if (!entry) {
      if (this.#parts.size > 8) return null;
      entry = { n, got: 0, size: 0, chunks: new Array(n) };
      this.#parts.set(id, entry);
    }
    if (entry.n !== n || entry.chunks[i] !== undefined) return null;
    entry.chunks[i] = d;
    entry.got += 1;
    entry.size += d.length;
    if (entry.size > MAX_REASSEMBLED) { this.#parts.delete(id); return null; }
    if (entry.got < n) return null;
    this.#parts.delete(id);
    try { return JSON.parse(entry.chunks.join('')); } catch { return null; }
  }

  #down(reason) {
    if (this.state === 'down') return;
    const wasOpen = this.state === 'open';
    this.state = 'down';
    clearTimeout(this.#timer);
    if (this.#pc) {
      this.#pc.onicecandidate = this.#pc.ondatachannel = this.#pc.onconnectionstatechange = null;
      try { this.#pc.close(); } catch { /* ignore */ }
    }
    if (this.#ctl) this.#ctl.onclose = this.#ctl.onmessage = null;
    this.emit('down', reason, wasOpen);
  }
}

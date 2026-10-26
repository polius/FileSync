// One file transfer over one data channel, with flow control, verification and resume.
//
// Frames on 'x:<id>':
//   sender -> receiver  {t:'header', size, offset}   <binary chunks>   {t:'end', sha256}
//   receiver -> sender  {t:'ack', bytes}             {t:'done', ok, sha256?}   {t:'abort', reason}
//
// Flow control is credit based: `ack.bytes` counts bytes the receiver has durably written,
// and the sender never runs more than WINDOW bytes ahead of it. Memory on both sides stays
// bounded even when the disk (or the zip stage) is slower than the network.
//
// SHA-256 covers the whole file. On resume the receiver keeps its running hash; a sender
// that starts mid-file first hashes the bytes the receiver already has (read locally,
// nothing is re-sent), so both digests always cover the full content.

import { Hasher } from './hasher.js';

export const WINDOW = 16 * 1024 * 1024;     // max unacknowledged bytes in flight
const HIGH_WATER = 4 * 1024 * 1024;         // pause when the channel buffer holds this much
const LOW_WATER = 1024 * 1024;
const READ_SLICE = 1024 * 1024;             // disk reads
const DEFAULT_MESSAGE = 64 * 1024;          // network messages (capped by SCTP maxMessageSize)
const ACK_EVERY = 1024 * 1024;
const STALL_MS = 20_000;

export class TransferError extends Error {
  constructor(reason, resumable) {
    super(reason);
    this.reason = reason;
    this.resumable = resumable;
  }
}

// Reasons after which the receiver can reconnect and continue from the bytes it has.
const RESUMABLE = new Set(['channel-closed', 'stall', 'link-down', 'send-failed']);

function waitOpen(ch) {
  if (ch.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    ch.addEventListener('open', () => resolve(), { once: true });
    ch.addEventListener('close', () => reject(new TransferError('channel-closed', true)), { once: true });
  });
}

function messageSize(maxMessageSize) {
  return Number.isFinite(maxMessageSize) && maxMessageSize > 0 ? Math.min(DEFAULT_MESSAGE, maxMessageSize) : DEFAULT_MESSAGE;
}

// Digest cache per Blob, so a second receiver (or a resume) doesn't hash the file again.
const digestCache = new WeakMap();

// ---- Sender ----------------------------------------------------------------------------

export class OutgoingTransfer {
  #ch;
  #blob;
  #acked = 0;
  #wake = null;
  #closed = null;
  #done = null;
  #stopped = null;

  constructor(channel, blob, { maxMessageSize, onProgress } = {}) {
    this.#ch = channel;
    this.#blob = blob;
    this.msgSize = messageSize(maxMessageSize);
    this.onProgress = onProgress || (() => {});
    channel.bufferedAmountLowThreshold = LOW_WATER;
  }

  get acked() { return this.#acked; }

  stop(reason = 'cancelled') {
    this.#stopped = reason;
    try { this.#ch.send(JSON.stringify({ t: 'cancel', reason })); } catch { /* closed */ }
    try { this.#ch.close(); } catch { /* closed */ }
    this.#notify();
  }

  // Resolves with the file's SHA-256 once the receiver confirms a verified write.
  async run(offset) {
    const ch = this.#ch;
    const size = this.#blob.size;
    ch.addEventListener('message', (ev) => this.#onMessage(ev));
    ch.addEventListener('close', () => { this.#closed = this.#closed || 'channel-closed'; this.#notify(); });
    await waitOpen(ch);

    const start = offset > 0 && offset <= size ? offset : 0;
    this.#acked = start;
    const cached = digestCache.get(this.#blob);
    const hasher = cached ? null : new Hasher();
    try {
      if (hasher && start > 0) await this.#hashRange(hasher, 0, start);
      this.#send(JSON.stringify({ t: 'header', size, offset: start }));

      let pos = start;
      let next = pos < size ? this.#read(pos) : null;
      while (pos < size) {
        const buf = new Uint8Array(await next);
        const end = pos + buf.byteLength;
        next = end < size ? this.#read(end) : null;  // prefetch while this slice goes out
        for (let o = 0; o < buf.byteLength; o += this.msgSize) {
          const part = buf.subarray(o, Math.min(o + this.msgSize, buf.byteLength));
          await this.#room(pos + o + part.byteLength);
          this.#send(part);
        }
        if (hasher) hasher.update(buf);
        pos = end;
      }
      const sha256 = cached || await hasher.digest();
      if (!cached) digestCache.set(this.#blob, sha256);
      this.#send(JSON.stringify({ t: 'end', sha256 }));
      const result = await this.#awaitDone();
      if (!result.ok) throw new TransferError(result.reason || 'checksum-mismatch', false);
      try { ch.close(); } catch { /* already closed */ }
      return sha256;
    } finally {
      hasher?.dispose();
    }
  }

  async #hashRange(hasher, from, to) {
    for (let p = from; p < to; p += READ_SLICE * 4) {
      this.#check();
      hasher.update(new Uint8Array(await this.#blob.slice(p, Math.min(p + READ_SLICE * 4, to)).arrayBuffer()));
    }
  }

  #read(pos) {
    return this.#blob.slice(pos, Math.min(pos + READ_SLICE, this.#blob.size)).arrayBuffer();
  }

  #send(data) {
    this.#check();
    try { this.#ch.send(data); }
    catch { throw new TransferError(this.#stopped || this.#closed || 'send-failed', !this.#stopped); }
  }

  #check() {
    if (this.#stopped) throw new TransferError(this.#stopped, false);
    if (this.#closed) throw new TransferError(this.#closed, RESUMABLE.has(this.#closed));
  }

  // Wait until both the credit window and the channel buffer have room.
  async #room(upTo) {
    for (;;) {
      this.#check();
      if (upTo - this.#acked <= WINDOW && this.#ch.bufferedAmount < HIGH_WATER) return;
      await new Promise((resolve) => {
        this.#wake = resolve;
        if (this.#ch.bufferedAmount >= HIGH_WATER) {
          this.#ch.addEventListener('bufferedamountlow', () => this.#notify(), { once: true });
        }
      });
    }
  }

  #awaitDone() {
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.#done) return resolve(this.#done);
        try { this.#check(); } catch (err) { return reject(err); }
        this.#wake = tick;
      };
      tick();
    });
  }

  #notify() {
    const w = this.#wake;
    this.#wake = null;
    if (w) w();
  }

  #onMessage(ev) {
    if (typeof ev.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === 'ack' && Number.isSafeInteger(msg.bytes) && msg.bytes >= this.#acked && msg.bytes <= this.#blob.size) {
      this.#acked = msg.bytes;
      this.onProgress(this.#acked);
    } else if (msg.t === 'done') {
      this.#done = { ok: msg.ok === true, reason: typeof msg.reason === 'string' ? msg.reason : '' };
    } else if (msg.t === 'abort') {
      this.#closed = typeof msg.reason === 'string' && msg.reason.length <= 40 ? `receiver-${msg.reason}` : 'receiver-abort';
    }
    this.#notify();
  }
}

// ---- Receiver --------------------------------------------------------------------------

// Per-download state that survives reconnects: the sink, the bytes durably written, and
// the running hash over exactly those bytes.
export class DownloadState {
  constructor(sink, size) {
    this.sink = sink;
    this.size = size;
    this.written = 0;
    this.hasher = new Hasher();
  }

  dispose() {
    this.hasher.dispose();
  }
}

export class IncomingTransfer {
  #ch;
  #state;
  #queue = Promise.resolve();
  #received = 0;
  #lastAck = 0;
  #stallTimer = null;
  #settle = null;
  #finished = false;

  #stallMs;

  constructor(channel, state, { onProgress, stallMs = STALL_MS } = {}) {
    this.#ch = channel;
    this.#state = state;
    this.onProgress = onProgress || (() => {});
    this.#stallMs = stallMs;
  }

  stop(reason = 'cancelled') {
    this.#abort(reason, false);
  }

  // Resolves with the verified SHA-256; rejects with a TransferError (resumable or not).
  run() {
    return new Promise((resolve, reject) => {
      this.#settle = { resolve, reject };
      this.#ch.addEventListener('message', (ev) => this.#onMessage(ev));
      this.#ch.addEventListener('close', () => this.#fail('channel-closed', true));
      this.#touch();
    });
  }

  #touch() {
    clearTimeout(this.#stallTimer);
    this.#stallTimer = setTimeout(() => this.#abort('stall', true), this.#stallMs);
  }

  #onMessage(ev) {
    if (this.#finished) return;
    this.#touch();
    if (typeof ev.data !== 'string') {
      this.#onChunk(new Uint8Array(ev.data));
      return;
    }
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const st = this.#state;
    if (msg.t === 'header') {
      if (msg.size !== st.size) return this.#abort('size-mismatch', false);
      if (msg.offset !== st.written) return this.#abort('resume-mismatch', false);
      this.#received = st.written;
      this.#lastAck = st.written;
    } else if (msg.t === 'end') {
      this.#queue = this.#queue.then(() => this.#finish(msg.sha256));
    } else if (msg.t === 'cancel') {
      const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 40) : 'cancelled';
      this.#fail(`sender-${reason}`, RESUMABLE.has(reason));
    }
  }

  #onChunk(bytes) {
    const st = this.#state;
    this.#received += bytes.byteLength;
    if (this.#received > st.size) return this.#abort('too-much-data', false);
    // Writes are serialized; the hash advances only with bytes that reached the sink, so
    // after an interruption `written` and the hash agree exactly.
    this.#queue = this.#queue.then(async () => {
      if (this.#finished) return;
      await st.sink.write(bytes);
      st.hasher.update(bytes);
      st.written += bytes.byteLength;
      this.onProgress(st.written);
      if (st.written - this.#lastAck >= ACK_EVERY || st.written === st.size) {
        this.#lastAck = st.written;
        this.#sendCtl({ t: 'ack', bytes: st.written });
      }
    }).catch((err) => {
      console.error('Sink write failed:', err);
      this.#abort('write-failed', false);
    });
  }

  async #finish(sha256) {
    if (this.#finished) return;
    const st = this.#state;
    if (st.written !== st.size) return this.#abort('incomplete', false);
    const actual = await st.hasher.digest();
    const ok = typeof sha256 === 'string' && actual === sha256;
    this.#sendCtl({ t: 'done', ok, reason: ok ? undefined : 'checksum-mismatch' });
    if (!ok) return this.#fail('checksum-mismatch', false);
    this.#finished = true;
    clearTimeout(this.#stallTimer);
    this.#settle.resolve(actual);
  }

  #sendCtl(msg) {
    try { this.#ch.send(JSON.stringify(msg)); } catch { /* channel closing */ }
  }

  #abort(reason, resumable) {
    this.#sendCtl({ t: 'abort', reason });
    this.#fail(reason, resumable);
    try { this.#ch.close(); } catch { /* closed */ }
  }

  #fail(reason, resumable) {
    if (this.#finished) return;
    this.#finished = true;
    clearTimeout(this.#stallTimer);
    // Let in-flight writes land first so `written` is final before anyone resumes.
    this.#queue.finally(() => this.#settle?.reject(new TransferError(reason, resumable)));
  }
}

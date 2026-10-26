// Room: everything a FileSync room does, independent of the DOM.
//
// The host owns the room: it admits guests (checking the password when one is set), keeps
// the member list and the file catalog, and relays both to everyone. Every peer can share
// files. A download always goes straight from the file's owner to the requester over the
// link between them; the host only coordinates who is in the room and what is shared.
//
// Trust rules (see protocol.js): room state is accepted only from the host; the host stamps
// owners and senders from the authenticated link, so nobody can act as someone else.
//
// The view reads public fields and listens for 'change' and 'toast'.

import { Emitter, generateName, randomId, randomBytes, toBase64Url, sleep, RateMeter, cleanName } from './util.js';
import { PROTO, parse, hostAccepts, guestAcceptsFromHost, guestAcceptsFromPeer, isSha256 } from './protocol.js';
import { derivePasswordKey, passwordProof, checkPasswordProof } from './crypto.js';
import { OutgoingTransfer, IncomingTransfer, DownloadState, TransferError } from './transfer.js';
import { ZipEntrySink, zipEntryNamer, bundleName } from './zip.js';

const OUTGOING_CAP = 5;
const AUTH_MAX_FAILS = 5;
const MAX_TEXTS = 100;

// Timings, overridable through deps.timing (tests shrink them).
const TIMING = {
  requestTimeoutMs: 15_000,          // no channel and no "queued" by then: retry
  resumeDelaysMs: [1000, 2000, 4000, 8000, 16000],
  hostReturnWindowMs: 120_000,       // keep reconnecting to a host that dropped
  hostByeWindowMs: 20_000,           // ...or that said goodbye (it may be reloading)
  joinRetryMs: 8_000,                // a room that never answered at all
  authWindowMs: 60_000,              // password failures counted over this window
  memberWaitMs: 5_000,               // wait for the member list before refusing a peer
  stallMs: 20_000,                   // no bytes for this long mid-transfer: reconnect
};

const ERRORS = {
  'host-gone': { title: 'This room isn’t open', detail: 'The person who created it may have closed the page, or the link may be mistyped.' },
  'host-left': { title: 'The host closed the room', detail: 'Files shared in this room are no longer available.' },
  'verification-failed': { title: 'Security check failed', detail: 'The connection to the host could not be verified with the key in your link. Someone may be interfering with the connection. Ask the host for a new link.' },
  taken: { title: 'This room is open somewhere else', detail: 'The room link is already in use by another device or tab.' },
  replaced: { title: 'FileSync is open in another tab', detail: 'This room continued in a newer tab. Close this one, or reload to use it here.' },
  invalid: { title: 'Couldn’t connect', detail: 'The server rejected this session. Reload the page to try again.' },
  'no-webrtc': { title: 'This browser can’t send files', detail: 'FileSync needs WebRTC. Use a current version of Chrome, Edge, Firefox or Safari.' },
};

const FAILURE_TEXT = {
  'checksum-mismatch': 'The file arrived damaged and was discarded. Try again.',
  'size-mismatch': 'The sender’s file changed. Ask them to share it again.',
  'resume-mismatch': 'The download couldn’t continue. Try again.',
  'write-failed': 'Couldn’t save the file. Check free disk space and try again.',
  'too-much-data': 'The sender sent more data than announced.',
  'sender-removed': 'The sender stopped sharing this file.',
  'sender-unavailable': 'The sender isn’t sharing this file any more.',
  'sender-read-failed': 'The sender’s device couldn’t read the file.',
  'sender-cancelled': 'The sender stopped the transfer.',
  'owner-left': 'The sender left the room.',
  'no-response': 'The sender didn’t respond.',
  incomplete: 'The transfer was incomplete. Try again.',
};

function failureText(reason) {
  return FAILURE_TEXT[reason] || 'The transfer stopped. Try again.';
}

export class Room extends Emitter {
  // ---- public state read by the view ----
  role;
  roomId;
  phase = 'starting';          // starting | joining | password | ready | error
  error = null;                // { code, title, detail }
  passwordError = null;        // { retryAfter } after a wrong password
  server = 'connecting';
  hostLink = 'connecting';     // guest only: connecting | open | reconnecting
  verified = false;            // guest only: link to host verified with the link key
  secured = false;
  me;
  members = new Map();         // id -> { id, name, verified, isHost, isMe }
  files = new Map();           // id -> file entry (see #addFile)
  texts = [];
  bundle = null;
  version = '';

  #deps;
  #t;
  #net = null;
  #signaling = null;
  #key;
  #verifier = null;            // host: PBKDF2 verifier of the room password
  #guests = new Map();         // host: peerId -> { link, admitted, nonce }
  #authFails = [];
  #password = null;            // guest: room password, kept for reconnects (host reloads)
  #hostNonce = null;
  #hostDownSince = 0;
  #hostWindow = 0;
  #dialing = false;
  #outgoing = new Map();       // xfer -> { file, link, transfer, remoteId }
  #outQueue = [];              // [{ link, msg }]
  #downloads = new Map();      // fileId -> download
  #memberWaiters = new Set();
  #ended = false;

  constructor({ role, roomId, me, key, verifier, deps }) {
    super();
    this.role = role;
    this.roomId = roomId;
    this.me = { id: me.id, name: me.name || generateName(), token: me.token };
    this.#key = key || null;
    this.#verifier = verifier || null;
    this.secured = !!verifier;
    this.#deps = deps;
    this.#t = { ...TIMING, ...(deps.timing || {}) };
  }

  get isHost() { return this.role === 'host'; }
  get hasKey() { return !!this.#key; }
  get hostId() { return this.roomId; }
  get verifier() { return this.#verifier; }

  // True while leaving the page would break something for someone.
  get busy() {
    const transferring = this.#outgoing.size > 0 || [...this.#downloads.values()].some((d) => !d.finished);
    const sharing = [...this.files.values()].some((f) => f.mine && f.status === 'shared');
    return transferring || sharing || this.bundle?.state === 'running' || (this.isHost && this.members.size > 1);
  }

  start() {
    if (typeof RTCPeerConnection === 'undefined') return this.#fail('no-webrtc');
    this.#signaling = new this.#deps.Signaling(this.me.id, this.me.token);
    this.#net = new this.#deps.Network({ signaling: this.#signaling, key: this.#key, accept: (id) => this.#acceptInbound(id) });
    this.#net.on('link', (link) => this.#onLink(link, false));
    this.#signaling.on('state', (s) => { this.server = s; this.#changed(); });
    this.#signaling.on('fatal', (code) => this.#fail(code));
    this.#signaling.on('open', () => {
      this.version = this.#signaling.version;
      if (this.isHost && this.phase === 'starting') this.phase = 'ready';
      if (!this.isHost && this.hostLink !== 'open') this.#dialHost();
      this.#changed();
    });
    this.members.set(this.me.id, { id: this.me.id, name: this.me.name, verified: false, isHost: this.isHost, isMe: true });
    if (!this.isHost) this.phase = 'joining';
    this.#signaling.start();
    this.#changed();
  }

  // Best-effort goodbye so others drop us at once instead of after a timeout.
  leave() {
    if (this.#ended) return;
    this.#ended = true;
    for (const id of this.#linkedPeers()) this.#net?.link(id)?.send({ t: 'bye' });
    this.#net?.closeAll('leaving');
    this.#signaling?.stop();
  }

  // ---- identity and settings ----------------------------------------------------------

  rename(name) {
    const clean = cleanName(name);
    if (!clean) return false;
    this.me.name = clean;
    this.members.get(this.me.id).name = clean;
    if (this.isHost) this.#broadcastMembers();
    else this.#toHost({ t: 'rename', name: clean });
    this.#changed();
    return true;
  }

  async setPassword(password) {
    this.#verifier = password ? await derivePasswordKey(password, this.roomId) : null;
    this.secured = !!this.#verifier;
    this.#changed();
    this.emit('settings');
  }

  async submitPassword(password) {
    this.passwordError = null;
    this.#password = password;
    this.#changed();
    const link = this.#net.link(this.hostId);
    if (link?.state === 'open' && this.#hostNonce) await this.#answerChallenge(link);
    else this.#dialHost();
  }

  // ---- sharing ------------------------------------------------------------------------

  addFiles(entries) {
    const added = [];
    let skipped = 0;
    for (const { file, path } of entries) {
      const dup = [...this.files.values()].some((f) => f.mine && f.status === 'shared' && f.name === file.name && f.size === file.size && f.path === path);
      if (dup) { skipped += 1; continue; }
      const entry = this.#addFile({ id: randomId(), name: file.name, path, size: file.size, type: file.type || '', owner: this.me.id, thumb: null }, file);
      added.push(entry);
    }
    if (added.length) this.#announce(added);
    this.#changed();
    this.#makeThumbs(added);
    return { added: added.length, skipped };
  }

  removeFile(id) {
    const f = this.files.get(id);
    if (!f?.mine || f.status !== 'shared') return;
    f.status = 'removed';
    for (const [xfer, out] of this.#outgoing) {
      if (out.file === f) { out.transfer.stop('removed'); this.#outgoing.delete(xfer); }
    }
    this.#outQueue = this.#outQueue.filter((q) => q.msg.file !== id);
    if (this.isHost) this.#broadcastCatalog({ remove: [id] });
    else this.#toHost({ t: 'file-remove', ids: [id] });
    this.#changed();
  }

  sendText(body) {
    const text = String(body || '').replace(/\r\n/g, '\n');
    if (!text.trim()) return false;
    const id = randomId();
    if (this.isHost) this.#acceptText({ id, from: this.me.id, name: this.me.name, body: text.slice(0, 10_000), at: Date.now() });
    else this.#toHost({ t: 'text', id, body: text });
    return true;
  }

  // Deletes one of your own messages for everyone, including people who join later. A guest
  // asks the host, which removes it once it has checked who sent it. Returns false when the
  // message isn't yours or a guest can't reach the host right now.
  deleteText(id) {
    const item = this.texts.find((t) => t.id === id && t.from === this.me.id);
    if (!item) return false;
    if (this.isHost) {
      this.#dropText(item);
      return true;
    }
    if (this.hostLink !== 'open') return false;
    this.#toHost({ t: 'text-delete', id });
    return true;
  }

  // ---- downloading --------------------------------------------------------------------

  // Must be called straight from a click: the save picker needs the user gesture.
  async download(id) {
    const f = this.files.get(id);
    if (!f || f.mine || !this.#available(f)) return;
    const existing = this.#downloads.get(id);
    if (existing && !existing.finished) {
      if (existing.paused) this.#resume(existing, true);
      return;
    }
    if (this.bundle?.state === 'running' && this.bundle.ids.has(id)) return;
    let sink;
    try {
      sink = await this.#deps.openSink({ id: `${f.id}-${Date.now()}`, name: f.name, size: f.size, mime: f.type || 'application/octet-stream' });
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.error('Could not open a save target:', err);
        this.#toast('Couldn’t start the download. Try again.', 'error');
      }
      return;
    }
    this.#startDownload(f, sink);
    if (sink && 'mode' in sink) sink._onCancel = () => this.cancelDownload(id);
  }

  cancelDownload(id) {
    const dl = this.#downloads.get(id);
    if (!dl || dl.finished) return;
    this.#finishDownload(dl, 'cancelled');
  }

  async downloadAll() {
    if (this.bundle?.state === 'running') return;
    const active = (f) => { const d = this.#downloads.get(f.id); return d && !d.finished; };
    const todo = [...this.files.values()].filter((f) => !f.mine && this.#available(f) && !active(f));
    if (!todo.length) {
      this.#toast('There’s nothing to download yet.', 'info');
      return;
    }
    let zipSink;
    try {
      zipSink = await this.#deps.openSink({ id: `bundle-${Date.now()}`, name: bundleName(this.roomId), size: undefined, mime: 'application/zip' });
    } catch (err) {
      if (err?.name !== 'AbortError') this.#toast('Couldn’t start the download. Try again.', 'error');
      return;
    }
    const bundle = {
      state: 'running', ids: new Set(todo.map((f) => f.id)), count: todo.length, index: 0,
      total: todo.reduce((s, f) => s + f.size, 0), doneBytes: 0, current: null, skipped: 0, error: null, cancel: null,
    };
    this.bundle = bundle;
    if (zipSink && 'mode' in zipSink) zipSink._onCancel = () => this.cancelBundle();
    this.#changed();

    const nameFor = zipEntryNamer();
    const self = this;
    let aborted = null;
    async function* entries() {
      for (const f of todo) {
        if (aborted) return;
        bundle.index += 1;
        if (!self.#available(f)) { bundle.skipped += 1; continue; }
        const sink = new ZipEntrySink();
        const dl = self.#startDownload(f, sink, { bundle: true });
        bundle.current = dl;
        let started = false;
        try { started = await dl.started; } catch { started = false; }
        if (!started) { bundle.skipped += 1; continue; }
        // Yield only once bytes flow, so a file that never starts is skipped cleanly.
        yield { name: nameFor(f), input: sink.stream, lastModified: new Date(), size: f.size };
        try {
          await dl.done;
          bundle.doneBytes += f.size;
          bundle.current = null;   // now counted in doneBytes; leaving it set counted it twice
        } catch (err) {
          aborted = err;
          return;
        }
      }
    }

    // Cancelling aborts the current entry; its stream error ends the read loop below, and
    // between entries the generator sees `aborted` and stops. No reader.cancel(): client-zip
    // turns that into an unhandled iterator.throw() rejection.
    bundle.cancel = () => {
      aborted = aborted || new Error('cancelled');
      if (bundle.current && !bundle.current.finished) self.#finishDownload(bundle.current, 'cancelled');
    };
    try {
      const reader = this.#deps.downloadZip(entries()).body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        await zipSink.write(value);
      }
      if (aborted) throw aborted;
      await zipSink.close();
      bundle.state = 'done';
      this.#toast(bundle.skipped ? `Saved ${bundle.count - bundle.skipped} files. ${bundle.skipped} weren’t available.` : `Saved ${bundle.count} files.`, 'success');
    } catch (err) {
      await zipSink.abort(String(err?.message || err)).catch(() => {});
      bundle.state = aborted?.message === 'cancelled' ? 'cancelled' : 'failed';
      bundle.error = bundle.state === 'failed' ? failureText(aborted?.reason || err?.reason) : null;
    }
    bundle.current = null;
    this.#changed();
  }

  cancelBundle() {
    this.bundle?.cancel?.();
  }

  dismissBundle() {
    if (this.bundle && this.bundle.state !== 'running') { this.bundle = null; this.#changed(); }
  }

  // ---- internals: files ---------------------------------------------------------------

  #addFile(meta, blob = null) {
    const mine = meta.owner === this.me.id;
    const entry = {
      ...meta,
      mine,
      blob,
      status: mine ? 'shared' : 'available',  // see view.js for every status
      written: 0,
      meter: new RateMeter(),
      error: null,
      sha256: null,
      queuePos: 0,
      receivers: new Map(),                   // mine: peerId -> { name, bytes, status }
    };
    this.files.set(meta.id, entry);
    return entry;
  }

  #wireMeta(f) {
    return { id: f.id, name: f.name, path: f.path, size: f.size, type: f.type, thumb: f.thumb || undefined };
  }

  #announce(entries) {
    const files = entries.map((f) => this.#wireMeta(f));
    if (this.isHost) this.#broadcastCatalog({ add: files.map((m) => ({ ...m, owner: this.me.id })) });
    else for (let i = 0; i < files.length; i += 500) this.#toHost({ t: 'file-add', files: files.slice(i, i + 500) });
  }

  async #makeThumbs(entries) {
    for (const f of entries) {
      if (!f.blob || f.status !== 'shared') continue;
      const thumb = await this.#deps.makeThumbnail(f.blob).catch(() => null);
      if (!thumb || f.status !== 'shared') continue;
      f.thumb = thumb;
      if (this.isHost) this.#broadcastCatalog({ thumbs: [{ id: f.id, thumb }] });
      else this.#toHost({ t: 'file-thumb', id: f.id, thumb });
      this.#changed();
    }
  }

  #available(f) {
    return !f.mine && f.status !== 'unavailable' && this.members.has(f.owner);
  }

  // Apply catalog changes coming from the host (or made by the host itself).
  #applyCatalog({ add = [], remove = [], thumbs = [] }) {
    for (const meta of add) {
      if (meta.owner === this.me.id || this.files.has(meta.id)) continue;
      this.#addFile(meta);
    }
    for (const id of remove) this.#fileGone(id, 'sender-removed');
    for (const { id, thumb } of thumbs) {
      const f = this.files.get(id);
      if (f && !f.mine) f.thumb = thumb;
    }
  }

  #fileGone(id, reason) {
    const f = this.files.get(id);
    if (!f || f.mine) return;
    const dl = this.#downloads.get(id);
    if (dl && !dl.finished) this.#finishDownload(dl, reason);
    if (f.status === 'done') return;   // keep finished downloads visible
    f.status = 'unavailable';
    f.error = reason === 'owner-left' ? 'The sender left the room.' : 'No longer shared.';
  }

  // ---- internals: links ---------------------------------------------------------------

  #linkedPeers() {
    return this.isHost ? [...this.#guests.keys()] : [this.hostId, ...[...this.members.keys()].filter((id) => id !== this.me.id && id !== this.hostId)];
  }

  async #acceptInbound(remoteId) {
    if (this.#ended) return false;
    if (this.isHost) return this.#guests.size < 255;
    if (remoteId === this.hostId) return false;      // the host never dials guests
    if (this.members.has(remoteId)) return true;
    // A newcomer may dial before our member list includes them; wait briefly.
    return new Promise((resolve) => {
      const waiter = () => { if (this.members.has(remoteId)) { cleanup(); resolve(true); } };
      const cleanup = () => { clearTimeout(timer); this.#memberWaiters.delete(waiter); };
      const timer = setTimeout(() => { cleanup(); resolve(false); }, this.#t.memberWaitMs);
      this.#memberWaiters.add(waiter);
    });
  }

  #onLink(link, outgoing) {
    if (link._roomWired) return;
    link._roomWired = true;
    link.on('message', (raw) => this.#onMessage(link, raw));
    link.on('channel', (ch) => this.#onChannel(link, ch));
    link.on('down', (reason) => this.#onLinkDown(link, reason));
    if (this.isHost) {
      this.#guests.set(link.remoteId, { link, admitted: false, nonce: null });
      // A guest that never says hello within 15 s is dropped.
      setTimeout(() => { const g = this.#guests.get(link.remoteId); if (g?.link === link && !g.admitted && !g.nonce) link.close('no-hello'); }, 15_000);
    } else if (outgoing && link.remoteId === this.hostId) {
      link.on('open', () => {
        this.hostLink = 'open';
        this.verified = link.verified;
        this.#hostDownSince = 0;
        link.send({ t: 'hello', proto: PROTO, name: this.me.name });
        this.#changed();
      });
    }
  }

  #dialHost() {
    if (this.#dialing || this.#ended || this.phase === 'error') return;
    const existing = this.#net.link(this.hostId);
    if (existing) return;
    this.#dialing = true;
    const link = this.#net.connect(this.hostId, { mustVerify: true });
    this.#onLink(link, true);
    link.on('down', () => { this.#dialing = false; });
    link.on('open', () => { this.#dialing = false; });
  }

  #onLinkDown(link, reason) {
    const id = link.remoteId;
    if (this.isHost) {
      const g = this.#guests.get(id);
      if (g?.link !== link) return;
      this.#guests.delete(id);
      if (g.admitted) this.#memberLeft(id);
      this.#dropOutgoing(id);
      this.#changed();
      return;
    }
    this.#dropOutgoing(id);
    if (id !== this.hostId || this.#ended || this.phase === 'error') { this.#changed(); return; }
    if (reason === 'verification-failed') return this.#fail('verification-failed');
    if (reason === 'auth-rejected') return;
    // Host link lost: keep retrying while the host could still come back (reload, blip).
    this.hostLink = 'reconnecting';
    if (!this.#hostDownSince) {
      this.#hostDownSince = Date.now();
      this.#hostWindow = reason === 'host-bye' ? this.#t.hostByeWindowMs : this.phase === 'ready' ? this.#t.hostReturnWindowMs : this.#t.joinRetryMs;
    }
    const elapsed = Date.now() - this.#hostDownSince;
    const window = this.#hostWindow;
    if (elapsed > window) return this.#fail(this.phase === 'ready' ? 'host-left' : 'host-gone');
    const delay = Math.min(8000, 1000 * 2 ** Math.floor(elapsed / 4000));
    setTimeout(() => this.#dialHost(), delay);
    this.#changed();
  }

  #dropOutgoing(remoteId) {
    for (const [xfer, out] of this.#outgoing) {
      if (out.remoteId === remoteId) { out.transfer.stop('link-down'); this.#outgoing.delete(xfer); }
    }
    this.#outQueue = this.#outQueue.filter((q) => q.link.remoteId !== remoteId);
    this.#pumpQueue();
  }

  #toHost(msg) {
    this.#net?.link(this.hostId)?.send(msg);
  }

  // ---- internals: messages ------------------------------------------------------------

  #onMessage(link, raw) {
    const msg = parse(raw);
    if (!msg) return;
    const from = link.remoteId;
    if (this.isHost) {
      const g = this.#guests.get(from);
      if (!g || g.link !== link || !hostAccepts(msg.t, g.admitted)) return;
      return this.#hostHandle(link, g, msg);
    }
    const fromHost = from === this.hostId;
    if (fromHost ? !guestAcceptsFromHost(msg.t) : !(this.members.has(from) && guestAcceptsFromPeer(msg.t))) return;
    if (fromHost) return this.#guestHandleHost(link, msg);
    return this.#handleTransferMessage(link, msg);
  }

  async #hostHandle(link, g, msg) {
    const from = link.remoteId;
    switch (msg.t) {
      case 'hello': {
        g.name = msg.name;
        if (g.admitted) {
          // A new session from the same guest (reload): their old files are gone.
          this.#removeFilesOf(from);
          return this.#admit(link, g);
        }
        if (!this.#verifier) return this.#admit(link, g);
        g.nonce = toBase64Url(randomBytes(18));
        link.send({ t: 'auth-challenge', nonce: g.nonce });
        return;
      }
      case 'auth-proof': {
        if (!g.nonce || g.admitted) return;
        const nonce = g.nonce;
        g.nonce = null;   // one answer per challenge
        const now = Date.now();
        this.#authFails = this.#authFails.filter((t) => now - t < this.#t.authWindowMs);
        if (this.#authFails.length >= AUTH_MAX_FAILS) {
          return this.#rejectGuest(link, Math.ceil((this.#authFails[0] + this.#t.authWindowMs - now) / 1000));
        }
        if (this.#verifier && await checkPasswordProof(this.#verifier, nonce, from, msg.proof)) return this.#admit(link, g);
        this.#authFails.push(now);
        // Room-wide back-off: guessing with fresh peer ids doesn't help an attacker.
        const n = this.#authFails.length;
        return this.#rejectGuest(link, n >= AUTH_MAX_FAILS ? Math.ceil(this.#t.authWindowMs / 1000) : 2 ** (n - 1));
      }
      case 'rename': {
        const m = this.members.get(from);
        if (m) { m.name = msg.name; this.#broadcastMembers(); this.#changed(); }
        return;
      }
      case 'file-add': {
        const fresh = msg.files.filter((meta) => !this.files.has(meta.id)).map((meta) => ({ ...meta, owner: from }));
        if (!fresh.length) return;
        this.#applyCatalog({ add: fresh });
        this.#broadcastCatalog({ add: fresh }, from);
        this.#changed();
        return;
      }
      case 'file-remove': {
        const ids = msg.ids.filter((id) => this.files.get(id)?.owner === from);
        if (!ids.length) return;
        this.#applyCatalog({ remove: ids });
        this.#broadcastCatalog({ remove: ids }, from);
        this.#changed();
        return;
      }
      case 'file-thumb': {
        if (this.files.get(msg.id)?.owner !== from) return;
        this.#applyCatalog({ thumbs: [msg] });
        this.#broadcastCatalog({ thumbs: [{ id: msg.id, thumb: msg.thumb }] }, from);
        this.#changed();
        return;
      }
      case 'text':
        if (this.texts.some((t) => t.id === msg.id)) return; // ids must stay unique for deletes
        return this.#acceptText({ id: msg.id, from, name: this.members.get(from)?.name || 'Someone', body: msg.body, at: Date.now() });
      case 'text-delete': {
        const item = this.texts.find((t) => t.id === msg.id && t.from === from);
        if (item) this.#dropText(item);
        return;
      }
      case 'bye':
        link.close('bye');
        return;
      default:
        return this.#handleTransferMessage(link, msg);
    }
  }

  #rejectGuest(link, retryAfter) {
    link.send({ t: 'auth-fail', retryAfter });
    setTimeout(() => link.close('auth-rejected'), 300);
  }

  #admit(link, g) {
    g.admitted = true;
    g.nonce = null;
    this.members.set(link.remoteId, { id: link.remoteId, name: g.name || 'Someone', verified: link.verified, isHost: false, isMe: false });
    link.send({
      t: 'welcome',
      proto: PROTO,
      you: link.remoteId,
      members: this.#memberList(),
      files: this.#catalogList().filter((f) => f.owner !== link.remoteId),
      texts: this.texts.slice(-MAX_TEXTS),
      secured: this.secured,
    });
    this.#broadcastMembers(link.remoteId);
    this.#toast(`${g.name || 'Someone'} joined.`, 'info');
    this.#changed();
  }

  #memberLeft(id) {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    this.#removeFilesOf(id);
    this.#broadcastMembers();
    this.#toast(`${m.name} left.`, 'info');
  }

  #removeFilesOf(owner) {
    const ids = [...this.files.values()].filter((f) => f.owner === owner && !f.mine).map((f) => f.id);
    for (const id of ids) this.#fileGone(id, 'owner-left');
    if (ids.length) this.#broadcastCatalog({ remove: ids });
  }

  #memberList() {
    return [...this.members.values()].map((m) => ({ id: m.id, name: m.name, verified: m.verified }));
  }

  // Files the host lists for others: its own shared files plus files other guests share.
  #catalogList() {
    return [...this.files.values()]
      .filter((f) => (f.mine ? f.status === 'shared' : this.members.has(f.owner) && f.status !== 'unavailable'))
      .map((f) => ({ ...this.#wireMeta(f), owner: f.owner }));
  }

  #admittedLinks(except = null) {
    return [...this.#guests.entries()].filter(([id, g]) => g.admitted && id !== except).map(([, g]) => g.link);
  }

  #broadcastMembers(except = null) {
    const members = this.#memberList();
    for (const link of this.#admittedLinks(except)) link.send({ t: 'members', members });
  }

  #broadcastCatalog(change, except = null) {
    if (change.add?.length || change.remove?.length || change.thumbs?.length) {
      for (const link of this.#admittedLinks(except)) link.send({ t: 'catalog', ...change });
    }
  }

  #acceptText(item) {
    this.texts.push(item);
    if (this.texts.length > MAX_TEXTS) this.texts.shift();
    if (this.isHost) for (const link of this.#admittedLinks()) link.send({ t: 'text', ...item });
    if (item.from !== this.me.id) this.#toast(`New message from ${item.name}.`, 'message');
    this.#changed();
  }

  #dropText(item) {
    this.texts = this.texts.filter((t) => t !== item);
    if (this.isHost) for (const link of this.#admittedLinks()) link.send({ t: 'text-delete', id: item.id });
    this.#changed();
  }

  async #guestHandleHost(link, msg) {
    switch (msg.t) {
      case 'auth-challenge':
        this.#hostNonce = msg.nonce;
        if (this.#password) return this.#answerChallenge(link);
        this.phase = 'password';
        this.#changed();
        return;
      case 'auth-fail':
        this.#password = null;
        this.#hostNonce = null;
        this.passwordError = { retryAfter: msg.retryAfter, at: Date.now() };
        this.phase = 'password';
        link.close('auth-rejected');
        this.#changed();
        return;
      case 'welcome': {
        this.phase = 'ready';
        this.passwordError = null;
        this.secured = msg.secured;
        this.#setMembers(msg.members);
        // The host's catalog is authoritative: anything it no longer lists is gone.
        const listed = new Set(msg.files.map((f) => f.id));
        for (const f of this.files.values()) if (!f.mine && !listed.has(f.id)) this.#fileGone(f.id, 'sender-removed');
        this.#applyCatalog({ add: msg.files });
        this.texts = msg.texts;
        // Re-announce our files: after a host reload or our own reconnect the host forgot them.
        const mine = [...this.files.values()].filter((f) => f.mine && f.status === 'shared');
        if (mine.length) this.#announce(mine);
        for (const f of mine) if (f.thumb) this.#toHost({ t: 'file-thumb', id: f.id, thumb: f.thumb });
        this.#changed();
        return;
      }
      case 'members':
        this.#setMembers(msg.members);
        this.#changed();
        return;
      case 'catalog':
        this.#applyCatalog(msg);
        this.#changed();
        return;
      case 'text':
        if (msg.item) this.#acceptText(msg.item);
        return;
      case 'text-delete': {
        const item = this.texts.find((t) => t.id === msg.id);
        if (item) this.#dropText(item);
        return;
      }
      case 'bye':
        // The host closed or reloaded its page. A reload comes back within seconds, so
        // wait briefly instead of the full window used for network trouble.
        link.close('host-bye');
        return;
      default:
        return this.#handleTransferMessage(link, msg);
    }
  }

  async #answerChallenge(link) {
    const nonce = this.#hostNonce;
    const password = this.#password;
    if (!nonce || password == null) return;
    this.#hostNonce = null;
    const verifier = await derivePasswordKey(password, this.roomId);
    link.send({ t: 'auth-proof', proof: await passwordProof(verifier, nonce, this.me.id) });
  }

  #setMembers(list) {
    const before = new Set(this.members.keys());
    const next = new Map();
    for (const m of list) {
      next.set(m.id, { id: m.id, name: m.name, verified: m.verified, isHost: m.id === this.hostId, isMe: m.id === this.me.id });
    }
    if (!next.has(this.me.id)) next.set(this.me.id, this.members.get(this.me.id));
    next.get(this.me.id).name = this.me.name;
    this.members = next;
    for (const id of before) {
      if (!next.has(id)) {
        for (const f of this.files.values()) if (f.owner === id) this.#fileGone(f.id, 'owner-left');
        this.#net.link(id)?.close('left');
      }
    }
    for (const w of [...this.#memberWaiters]) w();
  }

  // ---- internals: transfers (both directions) -----------------------------------------

  #handleTransferMessage(link, msg) {
    if (msg.t === 'get') return this.#onGet(link, msg);
    if (msg.t === 'queued') {
      const dl = this.#downloadByXfer(msg.xfer, link.remoteId);
      if (dl) { dl.file.status = 'queued'; dl.file.queuePos = msg.position; dl.queued = true; this.#changed(); }
      return;
    }
    if (msg.t === 'cancel') {
      const out = this.#outgoing.get(msg.xfer);
      if (out && out.remoteId === link.remoteId) {
        out.transfer.stop('cancelled');
        this.#outgoing.delete(msg.xfer);
        this.#pumpQueue();
        return;
      }
      const before = this.#outQueue.length;
      this.#outQueue = this.#outQueue.filter((q) => !(q.msg.xfer === msg.xfer && q.link === link));
      if (this.#outQueue.length !== before) return;
      const dl = this.#downloadByXfer(msg.xfer, link.remoteId);
      if (dl) this.#finishDownload(dl, `sender-${msg.reason}`);
    }
  }

  #onGet(link, msg) {
    const f = this.files.get(msg.file);
    const requester = link.remoteId;
    const isMember = this.isHost ? this.#guests.get(requester)?.admitted : this.members.has(requester);
    if (!isMember) return;
    if (!f?.mine || f.status !== 'shared' || msg.offset > f.size) {
      link.send({ t: 'cancel', xfer: msg.xfer, reason: 'unavailable' });
      return;
    }
    if (this.#outgoing.size >= OUTGOING_CAP) {
      this.#outQueue.push({ link, msg });
      link.send({ t: 'queued', xfer: msg.xfer, position: this.#outQueue.length });
      return;
    }
    this.#startOutgoing(link, f, msg);
  }

  #pumpQueue() {
    while (this.#outgoing.size < OUTGOING_CAP && this.#outQueue.length) {
      const { link, msg } = this.#outQueue.shift();
      const f = this.files.get(msg.file);
      if (link.state !== 'open') continue;
      if (!f?.mine || f.status !== 'shared') { link.send({ t: 'cancel', xfer: msg.xfer, reason: 'unavailable' }); continue; }
      this.#startOutgoing(link, f, msg);
    }
    this.#outQueue.forEach((q, i) => q.link.send({ t: 'queued', xfer: q.msg.xfer, position: i + 1 }));
  }

  #startOutgoing(link, f, msg) {
    const requester = link.remoteId;
    let ch;
    try { ch = link.openChannel(`x:${msg.xfer}`); }
    catch { return; }
    const rec = { name: this.members.get(requester)?.name || 'Someone', bytes: msg.offset, status: 'sending' };
    f.receivers.set(requester, rec);
    const transfer = new OutgoingTransfer(ch, f.blob, {
      maxMessageSize: link.pc?.sctp?.maxMessageSize,
      onProgress: (bytes) => { rec.bytes = bytes; this.#changed(); },
    });
    this.#outgoing.set(msg.xfer, { file: f, link, transfer, remoteId: requester });
    this.#changed();
    transfer.run(msg.offset)
      .then((sha) => { rec.status = 'done'; rec.bytes = f.size; f.sha256 = sha; })
      .catch((err) => {
        // A disk read error isn't a TransferError: tell the receiver it can't be resumed.
        if (!(err instanceof TransferError)) {
          console.error('Reading the file failed:', err);
          transfer.stop('read-failed');
        }
        rec.status = err?.resumable ? 'paused' : (/cancelled|retry/.test(err?.reason || '') ? 'stopped' : 'failed');
      })
      .finally(() => {
        if (this.#outgoing.get(msg.xfer)?.transfer === transfer) this.#outgoing.delete(msg.xfer);
        this.#pumpQueue();
        this.#changed();
      });
  }

  #downloadByXfer(xfer, remoteId) {
    for (const dl of this.#downloads.values()) if (dl.xfer === xfer && dl.file.owner === remoteId && !dl.finished) return dl;
    return null;
  }

  #onChannel(link, ch) {
    const xfer = ch.label.slice(2);
    const dl = this.#downloadByXfer(xfer, link.remoteId);
    if (!dl || dl.transfer) { ch.close(); return; }
    clearTimeout(dl.timer);
    dl.queued = false;
    dl.file.status = 'transferring';
    dl.file.error = null;
    const transfer = new IncomingTransfer(ch, dl.state, {
      stallMs: this.#t.stallMs,
      onProgress: (written) => { dl.file.written = written; dl.file.meter.add(written); this.#changed(); },
    });
    dl.transfer = transfer;
    dl.resolveStarted(true);
    this.#changed();
    transfer.run()
      .then((sha) => this.#finishDownload(dl, null, sha))
      .catch((err) => {
        dl.transfer = null;
        if (dl.finished) return;
        if (err instanceof TransferError && err.resumable) this.#resume(dl, false);
        else this.#finishDownload(dl, err?.reason || 'failed');
      });
  }

  #startDownload(f, sink, { bundle = false } = {}) {
    // started: resolves true once bytes flow (false if it ends first); done: the outcome.
    const dl = {
      file: f, bundle, state: new DownloadState(sink, f.size), xfer: null, transfer: null, timer: null,
      queued: false, paused: false, resuming: false, finished: false, attempt: 0,
    };
    dl.started = new Promise((resolve) => { dl.resolveStarted = resolve; });
    dl.done = new Promise((resolve, reject) => { dl.resolve = resolve; dl.reject = reject; });
    dl.done.catch(() => {});
    this.#downloads.set(f.id, dl);
    f.status = 'waiting';
    f.written = 0;
    f.error = null;
    f.sha256 = null;
    f.meter.reset();
    this.#request(dl);
    this.#changed();
    return dl;
  }

  #request(dl) {
    const f = dl.file;
    if (!this.members.has(f.owner)) return this.#finishDownload(dl, 'owner-left');
    const link = f.owner === this.hostId && !this.isHost ? this.#net.link(this.hostId) : this.#net.connect(f.owner);
    if (!link) return this.#resume(dl, false);
    this.#onLink(link, true);
    const xfer = randomId();
    dl.xfer = xfer;
    dl.queued = false;
    const send = () => link.send({ t: 'get', xfer: dl.xfer, file: f.id, offset: dl.state.written });
    if (link.state === 'open') send();
    else link.on('open', () => { if (dl.xfer === xfer && !dl.finished) send(); });
    clearTimeout(dl.timer);
    // Never wait forever: no channel and no "queued" in time means try again.
    dl.timer = setTimeout(() => {
      if (dl.finished || dl.transfer || dl.xfer !== xfer) return;
      if (dl.queued) return;   // waiting in the sender's queue is fine
      this.#resume(dl, false, 'no-response');
    }, this.#t.requestTimeoutMs);
  }

  async #resume(dl, manual, reason = 'connection-lost') {
    if (dl.finished || dl.resuming) return;
    const f = dl.file;
    if (!this.#available(f)) return this.#finishDownload(dl, 'owner-left');
    if (manual) dl.attempt = 0;
    if (dl.attempt >= this.#t.resumeDelaysMs.length) {
      dl.paused = true;
      f.status = 'paused';
      f.error = reason === 'no-response' ? failureText('no-response') : 'Connection lost. Select Resume to continue.';
      if (dl.bundle) this.#finishDownload(dl, reason);
      this.#changed();
      return;
    }
    dl.resuming = true;
    dl.paused = false;
    f.status = 'retrying';
    this.#changed();
    if (dl.xfer) this.#net.link(f.owner)?.send({ t: 'cancel', xfer: dl.xfer, reason: 'retry' });
    await sleep(manual ? 0 : this.#t.resumeDelaysMs[dl.attempt]);
    dl.attempt += 1;
    dl.resuming = false;
    if (dl.finished) return;
    if (!this.#available(f)) return this.#finishDownload(dl, 'owner-left');
    this.#request(dl);
  }

  async #finishDownload(dl, reason, sha256 = null) {
    if (dl.finished) return;
    dl.finished = true;
    clearTimeout(dl.timer);
    const f = dl.file;
    // On success the sender closes the channel; stopping here could drop its last frames.
    if (dl.transfer && reason) dl.transfer.stop(reason);
    if (reason && dl.xfer) this.#net?.link(f.owner)?.send({ t: 'cancel', xfer: dl.xfer, reason: reason === 'cancelled' ? 'cancelled' : 'failed' });
    dl.resolveStarted(false);
    if (!reason) {
      try {
        await dl.state.sink.close();
      } catch (err) {
        // AbortError: the person cancelled the browser download while it was saving.
        if (err?.name === 'AbortError') reason = 'cancelled';
        else { console.error('Saving failed:', err); reason = 'write-failed'; }
      }
    }
    if (reason) {
      await dl.state.sink.abort(reason).catch(() => {});
      dl.state.dispose();
      if (f.status !== 'unavailable') {
        f.status = reason === 'cancelled' ? 'available' : (reason === 'owner-left' ? 'unavailable' : 'failed');
        f.error = reason === 'cancelled' ? null : failureText(reason);
      }
      dl.reject(new TransferError(reason, false));
    } else {
      f.status = 'done';
      f.sha256 = isSha256(sha256) ? sha256 : null;
      f.written = f.size;
      dl.resolve(sha256);
    }
    this.#changed();
  }

  // ---- misc -----------------------------------------------------------------------------

  #fail(code) {
    if (this.phase === 'error') return;
    this.phase = 'error';
    this.error = { code, ...(ERRORS[code] || ERRORS.invalid) };
    for (const dl of this.#downloads.values()) if (!dl.finished) this.#finishDownload(dl, 'owner-left');
    if (code !== 'replaced') this.#signaling?.stop();
    this.#net?.closeAll('error');
    this.#changed();
  }

  #toast(text, kind = 'info') {
    this.emit('toast', { text, kind });
  }

  #changed() {
    this.emit('change');
  }
}

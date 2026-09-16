// Transfer-interruption + resume protocol tests.
//
// Drives the REAL File class (web/js/modules/webrtc/file.js) in-memory with fake
// transports to prove, deterministically:
//
//   1. Sender watchdog give-up ('disconnected' > grace): the sender now rejects,
//      sends a 'cancel' frame and closes the channel; the receiver PAUSES (keeps the
//      sink + resume offset) instead of hanging in_progress forever.
//   2. Receiver stall watchdog: no inbound frames mid-transfer => pause + resume point.
//   3. Zip mode keeps the old terminate-on-close behavior (zip is not resumable).
//   4. Resume handshake: a new transfer with resume_offset continues at the durable
//      byte count and finalizes the full file — no duplicate/missing bytes.
//   5. Fresh-restart fallback: a sender without offset support resets the sink.
//   6. The ICE grace boundary behaves as coded.
//
// Run: node --test --test-force-exit "tests/js/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------- browser environment stubs (must exist before app modules are imported) ----------
function makeDoc(key) {
  const elements = new Map();
  const makeEl = (id) => ({
    id, style: {}, textContent: '', innerHTML: '', value: '', disabled: false,
    addEventListener() {}, removeEventListener() {}, focus() {}, click() {}, remove() {},
    appendChild() {}, setAttribute() {}, removeAttribute() {},
    classList: { add() {}, remove() {}, toggle() {} },
  });
  return {
    elements,
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); },
    createElement(tag) { return makeEl(`dyn-${tag}`); },
    body: makeEl(`${key}-body`),
    addEventListener() {},
  };
}
globalThis.document = makeDoc('main');
const _ss = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (_ss.has(k) ? _ss.get(k) : null),
  setItem: (k, v) => _ss.set(k, String(v)),
  removeItem: (k) => _ss.delete(k),
  clear: () => _ss.clear(),
};
globalThis.window = globalThis;
globalThis.location = { search: '', href: 'http://localhost:8080/', protocol: 'http:', origin: 'http://localhost:8080', hostname: 'localhost', port: '8080', replace() {} };
globalThis.addEventListener = () => {};
globalThis.isSecureContext = false;
try { globalThis.navigator = { serviceWorker: undefined, clipboard: undefined }; }
catch { try { Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: undefined, clipboard: undefined }, configurable: true }); } catch {} }

// fetch stub: /api/uuid and /api/credentials (JWT-shaped token for turn.js).
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
globalThis.fetch = async (url) => {
  if (String(url).includes('/api/uuid')) {
    return { ok: true, json: async () => ({ uuid: 'uuid-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }) };
  }
  if (String(url).includes('/api/credentials')) {
    const token = `${b64u({ alg: 'none' })}.${b64u({ username: '1:u', credential: 'c', exp: Math.floor(Date.now() / 1000) + 300 })}.sig`;
    return { ok: true, json: async () => ({ token }) };
  }
  throw new Error(`unexpected fetch ${url}`);
};

// ---------- fake transports ----------
class FakeEmitter {
  constructor() { this._h = Object.create(null); }
  on(ev, fn) { (this._h[ev] ??= []).push(fn); return this; }
  off(ev, fn) { const l = this._h[ev]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } return this; }
  emit(ev, ...a) { for (const fn of (this._h[ev] || []).slice()) { try { fn(...a); } catch (e) { console.error(e); } } return !!(this._h[ev] || []).length; }
}

class FakeDC extends FakeEmitter {
  constructor({ name, onSend }) {
    super();
    this.name = name;
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.binaryType = 'arraybuffer';
    this.sent = [];
    this.onSend = onSend;
  }
  send(data) {
    if (this.readyState !== 'open') throw new Error('not open');
    this.sent.push(data);
    if (this.onSend) queueMicrotask(() => this.onSend(data));
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    queueMicrotask(() => { if (this.onclose) this.onclose(); this.emit('close'); });
  }
  addEventListener(ev, fn) { this.on(ev, fn); }
  removeEventListener(ev, fn) { this.off(ev, fn); }
}

class FakePC {
  constructor() {
    FakePC.instances.push(this);
    this.iceConnectionState = 'connected';
    this._dc = null;
  }
  createDataChannel(label) {
    this._dc = new FakeDC({ name: label, onSend: FakePC.currentForward });
    return this._dc;
  }
  async createOffer() { return { sdp: 'fake-offer' }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() { this.closed = true; if (this._dc) this._dc.readyState = 'closed'; }
}
FakePC.instances = [];
FakePC.currentForward = null;

class FakeWS extends FakeEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    queueMicrotask(() => { this.readyState = 1; if (this.onopen) this.onopen(); });
  }
  send(json) {
    this.sent.push(json);
    const msg = JSON.parse(json);
    if (msg.type === 'register') {
      queueMicrotask(() => this.onmessage && this.onmessage({ data: JSON.stringify({ type: 'registered', id: msg.id }) }));
    }
  }
  close() { this.readyState = 3; }
}

globalThis.WebSocket = FakeWS;
globalThis.RTCPeerConnection = FakePC;

const _fileUrl = new URL('../../web/js/modules/webrtc/file.js', import.meta.url);
const { File } = await import(_fileUrl.href);

// ---------- helpers ----------
const SENDER_PEER = 'sender-peer-000000000000000000000000000000';
const RECEIVER_PEER = 'receiver-peer-0000000000000000000000000000';
const FILE_ID = 'file-11111111-2222-3333-4444-555555555555';
const FILE_SIZE = 1536 * 1024; // 96 chunks of 16 KiB — slow enough to interrupt mid-transfer
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

function makeContent({ gateAfter = Infinity } = {}) {
  const data = new Uint8Array(FILE_SIZE);
  for (let i = 0; i < FILE_SIZE; i++) data[i] = i & 0xff;
  let reads = 0;
  return {
    _data: data,
    slice(a, b) {
      const slice = this._data.slice(a, b);
      const idx = reads++;
      return {
        arrayBuffer: async () => {
          await new Promise((r) => setTimeout(r, 25));
          if (idx >= gateAfter) await new Promise(() => {}); // hang the sender loop
          return slice.buffer;
        },
      };
    },
  };
}

function makeSink() {
  const rec = { writes: [], aborted: null, closed: false, truncates: 0 };
  return {
    rec,
    mode: 'test',
    async write(chunk) { rec.writes.push(chunk.length); },
    async truncate0() { rec.truncates += 1; rec.writes.length = 0; }, // emulate a real truncate
    async close() { rec.closed = true; },
    async abort(reason) { rec.aborted = reason ?? 'aborted'; },
  };
}

// A plain fake conn for the RECEIVER side (mirrors what file.js touches).
class FakeReceiverConn extends FakeEmitter {
  constructor() {
    super();
    this.peer = SENDER_PEER;
    this.dataChannel = new FakeDC({ name: 'r', onSend: null });
    this.closeCalls = 0;
    this._closed = false;
  }
  close() {
    // Idempotent, like the real DataConnection.close() — _terminateReceive/_interrupt
    // call conn.close(), which re-enters _handleClose.
    if (this._closed) return;
    this._closed = true;
    this.closeCalls += 1;
    this.emit('close');
  }
}

async function makeSenderFile({ gateAfter = Infinity } = {}) {
  const f = new File({ id: FILE_ID, name: 'report.bin', size: FILE_SIZE, content: makeContent({ gateAfter }), owner_id: SENDER_PEER, owner_name: 'S' });
  await f.init(undefined);
  return f;
}

// Wires sender->receiver frame flow and starts a transfer.
async function startTransfer(senderFile, receiverFile, receiverConn, { resumeOffset = 0 } = {}) {
  FakePC.currentForward = (data) => {
    queueMicrotask(() => receiverConn.emit('data', data));
  };
  receiverFile._handleConnection(receiverConn);
  const p = senderFile.transfer({
    peer_id: RECEIVER_PEER, requester_id: RECEIVER_PEER, requester_name: 'R', resume_offset: resumeOffset,
  });
  await settle(120);
  const pc = FakePC.instances[FakePC.instances.length - 1];
  assert.ok(pc && pc._dc, 'sender DataChannel must exist');
  pc._dc.onopen();
  return { promise: p, senderDC: pc._dc, receiverConn };
}

const sentTypes = (dc) => dc.sent.map((d) => (typeof d === 'string' ? JSON.parse(d).type : 'bin'));
const headerOf = (dc) => { const h = dc.sent.find((d) => typeof d === 'string' && d.includes('"header"')); return h ? JSON.parse(h) : null; };

// ---------- tests ----------
test('watchdog give-up: sender cancels + closes and rejects; receiver pauses with a resume point', async () => {
  const sink = makeSink();
  const receiverFile = new File({ id: FILE_ID, name: 'report.bin', size: FILE_SIZE, owner_id: SENDER_PEER, owner_name: 'S' });
  receiverFile._sink = sink;
  receiverFile.in_progress = true;

  const senderFile = await makeSenderFile();
  const { promise, senderDC, receiverConn } = await startTransfer(senderFile, receiverFile, new FakeReceiverConn());

  await settle(300);
  assert.ok(receiverFile._transferred > 0 && receiverFile._transferred < FILE_SIZE, 'receiver mid-transfer');

  // Sender's ICE 'disconnected' beyond the grace window:
  const entry = senderFile._remotePeers[RECEIVER_PEER];
  entry.conn.peerConnection.iceConnectionState = 'disconnected';
  entry.disconnectedSince = Date.now() - 31_000;
  await senderFile._isAlive(RECEIVER_PEER);
  assert.equal(entry.aborted, true, 'watchdog must mark the receiver aborted');
  assert.equal(entry.lost, true, 'watchdog must distinguish loss from a receiver abort');

  // transfer() now rejects (room-level cancel path runs), never hangs.
  await assert.rejects(promise, /connection-lost/);

  // The sender told the receiver and closed the channel.
  assert.ok(sentTypes(senderDC).includes('cancel'), 'cancel frame on the wire');
  assert.equal(senderDC.readyState, 'closed', 'sender closed the DataChannel');

  // The receiver paused instead of hanging: sink alive, resume point recorded.
  await settle(100);
  assert.equal(receiverFile.in_progress, false, 'receiver left in_progress');
  assert.equal(receiverFile.canResume, true, 'receiver is resumable');
  assert.equal(receiverFile.resumeOffset, receiverFile._flushed);
  assert.ok(receiverFile.resumeOffset > 0, 'resume point > 0');
  assert.equal(sink.rec.aborted, null, 'sink kept open (no partial artifact, no lock leak)');
  assert.equal(sink.rec.closed, false);

  // Sender's row shows the truthful message.
  const errEl = document.getElementById(`file-${FILE_ID}-error`);
  assert.equal(errEl.textContent, 'The connection to a receiver was lost.');

  if (entry.interval) clearInterval(entry.interval);
  try { senderFile._peer.destroy(); } catch {}
});

test('receiver stall watchdog: silence mid-transfer pauses the download with a resume point', async () => {
  const sink = makeSink();
  const receiverFile = new File({ id: FILE_ID, name: 'report.bin', size: FILE_SIZE, owner_id: SENDER_PEER, owner_name: 'S' });
  receiverFile._sink = sink;
  receiverFile.in_progress = true;
  receiverFile._stallTimeoutMs = 80;

  // Sender loop hangs after the first chunk — the link is silently dead.
  const senderFile = await makeSenderFile({ gateAfter: 1 });
  const { senderDC, receiverConn } = await startTransfer(senderFile, receiverFile, new FakeReceiverConn());

  await settle(400); // > stall timeout
  assert.equal(receiverFile.in_progress, false, 'stall watchdog paused the download');
  assert.equal(receiverFile.canResume, true);
  assert.equal(receiverFile.resumeOffset, 16 * 1024, 'resume point = bytes durably written');
  assert.equal(sink.rec.aborted, null, 'sink kept open');
  assert.equal(receiverConn.closeCalls >= 1, true, 'paused connection was closed');

  if (senderFile._remotePeers[RECEIVER_PEER]?.interval) clearInterval(senderFile._remotePeers[RECEIVER_PEER].interval);
  try { senderFile._peer.destroy(); } catch {}
});

test('zip mode: channel close mid-transfer still terminates with "The connection was lost."', async () => {
  let errored = null;
  const controller = { enqueue() {}, close() {}, error(e) { errored = e; } };
  const receiverFile = new File({ id: FILE_ID, name: 'report.bin', size: FILE_SIZE, owner_id: SENDER_PEER, owner_name: 'S' });
  receiverFile.zip = true;
  receiverFile.setZipController(controller);
  receiverFile.in_progress = true;

  const senderFile = await makeSenderFile();
  const { promise, senderDC } = await startTransfer(senderFile, receiverFile, new FakeReceiverConn());
  promise.catch(() => {}); // ends in channel-closed/send-failed by design

  await settle(300);
  assert.ok(receiverFile._transferred > 0 && receiverFile._transferred < FILE_SIZE);
  senderDC.close();
  receiverConnClose(receiverFile);
  await settle(50);

  assert.equal(receiverFile.in_progress, false, 'zip download terminated');
  assert.ok(errored, 'zip stream errored');
  const errEl = document.getElementById(`file-${FILE_ID}-error`);
  assert.equal(errEl.textContent, 'The connection was lost.');

  if (senderFile._remotePeers[RECEIVER_PEER]?.interval) clearInterval(senderFile._remotePeers[RECEIVER_PEER].interval);
  try { senderFile._peer.destroy(); } catch {}
});

// Fire the receiver-side close path for a zip receiver (no _conn plumbing needed).
function receiverConnClose(receiverFile) {
  const conn = new FakeEmitter();
  conn.peer = SENDER_PEER;
  conn.dataChannel = new FakeDC({ name: 'r', onSend: null });
  receiverFile._conn = conn;
  receiverFile._handleClose(conn);
}

test('resume handshake: new transfer with resume_offset continues at the durable byte count', async () => {
  const sink = makeSink();
  const receiverFile = new File({ id: FILE_ID, name: 'report.bin', size: FILE_SIZE, owner_id: SENDER_PEER, owner_name: 'S' });
  receiverFile._sink = sink;
  receiverFile.in_progress = true;

  // Session 1: 3 chunks flow, then the channel dies -> pause.
  const sender1 = await makeSenderFile();
  const s1 = await startTransfer(sender1, receiverFile, new FakeReceiverConn());
  s1.promise.catch(() => {}); // session 1 ends abnormally by design
  await settle(300);
  const offset = receiverFile._flushed;
  assert.ok(offset > 0 && offset % (16 * 1024) === 0, 'some whole chunks flushed before the interruption');
  s1.senderDC.close();
  s1.receiverConn.close();
  await settle(100);
  assert.equal(receiverFile.resumeOffset, offset, 'pause recorded the resume point');
  if (sender1._remotePeers[RECEIVER_PEER]?.interval) clearInterval(sender1._remotePeers[RECEIVER_PEER].interval);
  try { sender1._peer.destroy(); } catch {}

  // Session 2: fresh sender asked to resume at that offset.
  const sender2 = await makeSenderFile();
  const s2 = await startTransfer(sender2, receiverFile, new FakeReceiverConn(), { resumeOffset: offset });
  await s2.promise; // completes normally
  await settle(100);

  const header = headerOf(s2.senderDC);
  assert.equal(header.offset, offset, 'sender honored the resume offset');
  assert.equal(receiverFile._transferred, FILE_SIZE, 'receiver counted offset + resumed bytes');
  assert.equal(sink.rec.writes.reduce((a, b) => a + b, 0), FILE_SIZE, 'exactly the full file was written, no gaps/dupes');
  assert.equal(sink.rec.aborted, null, 'sink never aborted across the resume');
  assert.equal(sink.rec.closed, true, 'sink closed at completion');
  assert.equal(sink.rec.truncates, 0, 'no reset on a clean resume');
  assert.equal(document.getElementById(`file-${FILE_ID}-icon-success`).style.display, 'block', 'success UI');
  assert.equal(receiverFile.resumeOffset, 0, 'resume state cleared');

  if (sender2._remotePeers[RECEIVER_PEER]?.interval) clearInterval(sender2._remotePeers[RECEIVER_PEER].interval);
  try { sender2._peer.destroy(); } catch {}
});

test('fresh-restart fallback: a sender without offset support resets the kept sink', async () => {
  const sink = makeSink();
  const receiverFile = new File({ id: FILE_ID, name: 'report.bin', size: FILE_SIZE, owner_id: SENDER_PEER, owner_name: 'S' });
  receiverFile._sink = sink;
  receiverFile.in_progress = true;

  const sender1 = await makeSenderFile();
  const s1 = await startTransfer(sender1, receiverFile, new FakeReceiverConn());
  s1.promise.catch(() => {});
  await settle(300);
  s1.senderDC.close();
  s1.receiverConn.close();
  await settle(100);
  assert.ok(receiverFile.resumeOffset > 0);
  if (sender1._remotePeers[RECEIVER_PEER]?.interval) clearInterval(sender1._remotePeers[RECEIVER_PEER].interval);
  try { sender1._peer.destroy(); } catch {}

  // Session 2: sender ignores resume_offset entirely (legacy) -> header has no offset.
  const sender2 = await makeSenderFile();
  const s2 = await startTransfer(sender2, receiverFile, new FakeReceiverConn());
  await s2.promise;
  await settle(100);

  const header = headerOf(s2.senderDC);
  assert.ok(header, 'session 2 header must arrive');
  assert.equal(header.offset, 0, 'legacy header carries no offset');
  assert.equal(sink.rec.truncates, 1, 'kept sink was reset before the fresh stream');
  assert.equal(sink.rec.writes.reduce((a, b) => a + b, 0), FILE_SIZE, 'full file written after reset');
  assert.equal(document.getElementById(`file-${FILE_ID}-icon-success`).style.display, 'block');

  if (sender2._remotePeers[RECEIVER_PEER]?.interval) clearInterval(sender2._remotePeers[RECEIVER_PEER].interval);
  try { sender2._peer.destroy(); } catch {}
});

test('user discard of a paused download drops the sink and resume state', async () => {
  const sink = makeSink();
  const receiverFile = new File({ id: FILE_ID, name: 'report.bin', size: FILE_SIZE, owner_id: SENDER_PEER, owner_name: 'S' });
  receiverFile._sink = sink;
  receiverFile.in_progress = true;

  const senderFile = await makeSenderFile();
  const { senderDC, promise } = await startTransfer(senderFile, receiverFile, new FakeReceiverConn());
  promise.catch(() => {});
  await settle(300);
  senderDC.close();
  receiverFile._conn.close();
  await settle(100);
  assert.equal(receiverFile.canResume, true);

  receiverFile.abort(); // the user pressed Stop while paused
  await settle(50);
  assert.equal(sink.rec.aborted, 'aborted', 'kept sink discarded');
  assert.equal(receiverFile.canResume, false, 'resume state cleared');
  assert.equal(receiverFile._resumeOffset, 0);
});

test('ICE grace boundary: sub-grace does not trip the watchdog, over-grace does, recovery resets', async () => {
  const senderFile = await makeSenderFile();
  const entry = {
    conn: { peerConnection: { iceConnectionState: 'disconnected' } },
    interval: null, online: true, progress: 0, aborted: false, lost: false,
  };
  senderFile._remotePeers[RECEIVER_PEER] = entry;

  entry.disconnectedSince = Date.now() - 10_000; // under the 30s grace
  await senderFile._isAlive(RECEIVER_PEER);
  assert.equal(entry.aborted, false, '10s of disconnected must NOT give up');

  entry.disconnectedSince = Date.now() - 31_000; // over the grace
  await senderFile._isAlive(RECEIVER_PEER);
  assert.equal(entry.aborted, true, '31s of disconnected must give up');
  assert.equal(entry.lost, true);

  // A recovered connection resets the timer instead of aborting.
  entry.conn.peerConnection.iceConnectionState = 'connected';
  entry.aborted = false;
  entry.lost = false;
  entry.online = true;
  await senderFile._isAlive(RECEIVER_PEER);
  assert.equal(entry.aborted, false, 'recovered ICE must not abort');
  assert.equal(entry.disconnectedSince, null, 'timer resets on recovery');

  try { senderFile._peer.destroy(); } catch {}
});

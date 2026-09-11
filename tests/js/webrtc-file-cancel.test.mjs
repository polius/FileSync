// Regression test for 'webrtc-file-cancel' relay through the host.
//
// Guest-to-guest transfers relay through the host's room connection. When a sender's
// outbound transfer fails before the per-file DataChannel opens, the only way to unstick
// the requester's UI is a room-level 'webrtc-file-cancel' — which a non-host sender can
// only emit to the host. _onFileCancel must therefore tear down its own row when the
// cancel is addressed to it, and forward it to the requester when it is the host
// (mirroring _onFileQueued). Before this was fixed, the cancel died at the host and the
// requester sat on the loading spinner forever.
//
// The test imports the REAL User/File classes and drives _handleData over in-memory
// conns, with a stubbed per-party DOM (each user has its own document, as in a real
// 3-page session).
//
// Run: npm test   (node --test tests/js/)

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------- browser environment stubs (must exist before app modules are imported) ----------
// Each party gets its OWN document — in the real app each user has its own page, so A's
// teardown must never be observable on H's or B's rows.
function makeDoc(key) {
  const elements = new Map();
  const makeEl = (id) => ({
    id,
    style: {},
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    click() {},
    remove() {},
    appendChild() {},
    setAttribute() {},
    removeAttribute() {},
    classList: { add() {}, remove() {}, toggle() {} },
  });
  return {
    elements,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
    createElement(tag) { return makeEl(`dyn-${tag}`); },
    body: makeEl(`${key}-body`),
    addEventListener() {},
  };
}
const mainDoc = makeDoc('main');
globalThis.document = mainDoc;
const _ss = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (_ss.has(k) ? _ss.get(k) : null),
  setItem: (k, v) => _ss.set(k, String(v)),
  removeItem: (k) => _ss.delete(k),
  clear: () => _ss.clear(),
};
globalThis.window = globalThis;
globalThis.location = { search: '', href: 'http://localhost/', protocol: 'http:', origin: 'http://localhost', replace() {} };
globalThis.addEventListener = () => {};
globalThis.isSecureContext = false;
try { globalThis.navigator = { serviceWorker: undefined, clipboard: undefined }; }
catch { try { Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: undefined, clipboard: undefined }, configurable: true }); } catch {} }

// Import paths resolved relative to this file, independent of the runner's cwd.
const _userUrl = new URL('../../web/js/modules/webrtc/user.js', import.meta.url);
const _fileUrl = new URL('../../web/js/modules/webrtc/file.js', import.meta.url);
const { User } = await import(_userUrl.href);
const { File } = await import(_fileUrl.href);

// ---------- room factory ----------
const HOST = 'room-host-peer-000000000000000000000000000';
const A = 'guest-a-peer-0000000000000000000000000000000';
const B = 'guest-b-peer-0000000000000000000000000000000';
const FILE = 'file-abc123';
const FILE2 = 'file-def456';

// Builds a 3-party star topology: H <-> A, H <-> B. Guest-to-guest messaging relays
// through H, exactly like the real room. `hops` records every conn.send with endpoints.
function makeRoom() {
  const hops = [];
  const docFor = new Map();
  const users = {};

  for (const [key, id, isHost] of [['H', HOST, true], ['A', A, false], ['B', B, false]]) {
    // Real constructor contract: the host constructs with room_id '' (its own id becomes
    // the room id); guests construct with the host's peer id.
    const u = new User(isHost ? '' : HOST);
    if (!docFor.has(key)) docFor.set(key, makeDoc(key));
    u.__doc = docFor.get(key);
    u._peer = { id };
    u._files[FILE] = new File({ id: FILE, name: 'report.pdf', size: 1000, owner_id: B, owner_name: 'B', content: null });
    u._files[FILE2] = new File({ id: FILE2, name: 'other.bin', size: 2000, owner_id: B, owner_name: 'B', content: null });
    users[key] = u;
  }

  function connectPair(u1, id1, u2, id2) {
    const c1 = {
      peer: id2, open: true, close() {},
      send(m) {
        hops.push({ from: id1, to: id2, msg: m });
        queueMicrotask(() => { globalThis.document = u2.__doc; u2._handleData(c2, m); globalThis.document = mainDoc; });
      },
    };
    const c2 = {
      peer: id1, open: true, close() {},
      send(m) {
        hops.push({ from: id2, to: id1, msg: m });
        queueMicrotask(() => { globalThis.document = u1.__doc; u1._handleData(c1, m); globalThis.document = mainDoc; });
      },
    };
    return [c1, c2];
  }

  const [cH_A, cA_H] = connectPair(users.H, HOST, users.A, A);
  const [cH_B, cB_H] = connectPair(users.H, HOST, users.B, B);
  users.H._remotePeers[A] = { name: 'A', conn: cH_A, interval: null };
  users.H._remotePeers[B] = { name: 'B', conn: cH_B, interval: null };
  users.A._remotePeers[HOST] = { name: 'Host', conn: cA_H, interval: null };
  users.B._remotePeers[HOST] = { name: 'Host', conn: cB_H, interval: null };

  const el = (key, id) => docFor.get(key).getElementById(id);
  const resetDom = () => { for (const d of docFor.values()) d.elements.clear(); };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { users, hops, el, resetDom, settle };
}

// ---------- scenarios ----------
test('guest->guest cancel relays through the host and tears down the requester row', async () => {
  const { users, hops, el, settle } = makeRoom();
  // A requested B's file and is mid-download, waiting on the per-file channel.
  users.A._files[FILE].in_progress = true;

  // Trigger exactly what the sender does when file.transfer() rejects
  // (see the catch in _startOutboundTransfer):
  users.B._notifyRequesterCancel({ file_id: FILE, requester_id: A });
  await settle();

  assert.ok(
    hops.some((h) => h.from === B && h.to === HOST && 'webrtc-file-cancel' in h.msg),
    `cancel should leave B via the room conn — got: ${JSON.stringify(hops)}`,
  );
  assert.ok(
    hops.some((h) => h.from === HOST && h.to === A && 'webrtc-file-cancel' in h.msg && h.msg['webrtc-file-cancel'].file_id === FILE),
    `host should forward the cancel to A — got: ${JSON.stringify(hops)}`,
  );

  // Requester's row fully restored to its failed state.
  assert.equal(users.A._files[FILE].in_progress, false, 'A: file should leave in_progress');
  assert.equal(el('A', `file-${FILE}-icon-loading`).style.display, 'none');
  assert.equal(el('A', `file-${FILE}-icon-failed`).style.display, 'block');
  assert.equal(el('A', `file-${FILE}-download`).style.display, 'block');
  assert.equal(el('A', `file-${FILE}-abort`).style.display, 'none');
  assert.equal(el('A', `file-${FILE}-progress`).textContent, '');
  assert.equal(el('A', `file-${FILE}-error`).style.display, 'block');
  assert.equal(el('A', `file-${FILE}-error`).textContent, 'The sender stopped the transfer.');

  // Nobody else's UI is touched: the host is not the requester, B is the owner.
  assert.notEqual(el('H', `file-${FILE}-error`).style.display, 'block');
  assert.equal(users.H._files[FILE].in_progress, false);
  assert.notEqual(el('B', `file-${FILE}-error`).style.display, 'block');
  assert.equal(users.B._files[FILE].in_progress, false);
});

test('malformed cancel payload is inert', async () => {
  const { users, hops, el, settle } = makeRoom();
  users.A._files[FILE].in_progress = true;

  users.B._handleData(users.B._remotePeers[HOST].conn, { 'webrtc-file-cancel': null });
  await settle();

  assert.equal(hops.length, 0);
  assert.equal(users.A._files[FILE].in_progress, true);
  assert.notEqual(el('A', `file-${FILE}-error`).style.display, 'block');
});

test('invalid requester_id never emits a cancel', async () => {
  const { users, hops, settle } = makeRoom();

  users.B._notifyRequesterCancel({ file_id: FILE, requester_id: 'not a valid id!' });
  await settle();

  assert.equal(hops.length, 0);
});

test('cancel for an unknown file id is relayed but ignored by the requester', async () => {
  const { users, el, settle } = makeRoom();
  users.A._files[FILE].in_progress = true;

  users.B._notifyRequesterCancel({ file_id: 'unknown-file-xyz', requester_id: A });
  await settle();

  assert.equal(users.A._files[FILE].in_progress, true);
  assert.notEqual(el('A', `file-${FILE}-error`).style.display, 'block');
});

test('host-as-requester cancel tears down the host row without forwarding', async () => {
  const { users, hops, el, settle } = makeRoom();
  users.H._files[FILE2].in_progress = true; // the host itself is downloading B's file

  users.B._notifyRequesterCancel({ file_id: FILE2, requester_id: HOST });
  await settle();

  assert.equal(users.H._files[FILE2].in_progress, false);
  assert.equal(el('H', `file-${FILE2}-error`).style.display, 'block');
  assert.equal(el('H', `file-${FILE2}-error`).textContent, 'The sender stopped the transfer.');
  assert.equal(hops.length, 1, 'only B -> H should be sent, no forwarding');
});

// Pure modules: util, crypto, protocol. Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes as nodeRandom } from 'node:crypto';

const util = await import('../../web/js/app/util.js');
const cryptoMod = await import('../../web/js/app/crypto.js');
const protocol = await import('../../web/js/app/protocol.js');

// ---- util --------------------------------------------------------------------------------

test('room ids are xxx-xxxx-xxx and roughly uniform over a-z', () => {
  const counts = new Map();
  for (let i = 0; i < 2000; i++) {
    const id = util.generateRoomId();
    assert.match(id, util.ROOM_ID_RE);
    for (const c of id.replace(/-/g, '')) counts.set(c, (counts.get(c) || 0) + 1);
  }
  assert.equal(counts.size, 26);
  const expected = 20000 / 26;
  for (const n of counts.values()) assert.ok(Math.abs(n - expected) < expected * 0.2, `letter count ${n} far from ${expected}`);
});

test('randomInt never returns out of range values', () => {
  for (let i = 0; i < 5000; i++) {
    const v = util.randomInt(7);
    assert.ok(v >= 0 && v < 7);
  }
});

test('tokens and link keys have the formats the server and parser expect', () => {
  assert.match(util.randomToken(), /^[A-Za-z0-9_-]{32}$/);
  assert.match(util.randomLinkKey(), util.LINK_KEY_RE);
});

test('base64url round-trips arbitrary bytes', () => {
  for (const n of [0, 1, 2, 3, 16, 31, 100]) {
    const bytes = new Uint8Array(nodeRandom(n));
    assert.deepEqual(util.fromBase64Url(util.toBase64Url(bytes)), bytes);
  }
});

test('names: control characters and runs of spaces are cleaned, length capped', () => {
  assert.equal(util.cleanName('  Ann\u0000\u0007  \n Lee  '), 'Ann Lee');
  assert.equal(util.cleanName('x'.repeat(500)).length, util.MAX_NAME_LEN);
  assert.equal(util.cleanName(42), '');
});

test('file names can never escape the save location', () => {
  assert.equal(util.cleanFilename('../../etc/passwd'), 'passwd');
  assert.equal(util.cleanFilename('C:\\Windows\\evil.exe'), 'evil.exe');
  assert.equal(util.cleanFilename('..'), 'file');
  assert.equal(util.cleanFilename(''), 'file');
  assert.equal(util.cleanFilename('a\u0000b.txt'), 'ab.txt');
});

test('folder paths drop dot segments, empty segments and separators', () => {
  assert.equal(util.cleanFolderPath('Photos/2026/../Trip'), 'Photos/2026/Trip');
  assert.equal(util.cleanFolderPath('/abs//path\\win'), 'abs/path/win');
  assert.equal(util.cleanFolderPath('.'), '');
  assert.equal(util.cleanFolderPath('a/'.repeat(100)).split('/').length, util.MAX_PATH_DEPTH);
});

test('sizes use decimal units with sensible precision', () => {
  assert.equal(util.formatBytes(0), '0 B');
  assert.equal(util.formatBytes(999), '999 B');
  assert.equal(util.formatBytes(1000), '1.00 KB');
  assert.equal(util.formatBytes(1_234_567), '1.23 MB');
  assert.equal(util.formatBytes(45_600_000_000), '45.6 GB');
  assert.equal(util.formatDuration(5.2), '6 s');
  assert.equal(util.formatDuration(125), '2 min 05 s');
  assert.equal(util.formatDuration(3 * 3600 + 60), '3 h 01 min');
});

test('RateMeter reports bytes per second over its window', () => {
  const m = new util.RateMeter(4000);
  m.add(0, 0);
  m.add(1_000_000, 1000);
  m.add(3_000_000, 2000);
  assert.equal(Math.round(m.rate), 1_500_000);
});

// ---- crypto ------------------------------------------------------------------------------

test('streaming SHA-256 matches Node for every boundary and chunking', () => {
  for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 65536 + 7]) {
    const data = new Uint8Array(nodeRandom(n));
    const h = new cryptoMod.Sha256();
    let p = 0;
    while (p < n) {
      const k = Math.min(n - p, 1 + Math.floor(Math.random() * 97));
      h.update(data.subarray(p, p + k));
      p += k;
    }
    assert.equal(h.digestHex(), createHash('sha256').update(data).digest('hex'), `size ${n}`);
  }
});

test('SHA-256 refuses misuse after digest', () => {
  const h = new cryptoMod.Sha256();
  h.digestHex();
  assert.throws(() => h.update(new Uint8Array(1)));
  assert.throws(() => h.digestHex());
});

const SDP = 'v=0\r\na=group:BUNDLE 0\r\na=fingerprint:sha-256 ab:cd:ef:01\r\nm=application 9\r\na=fingerprint:SHA-256 AB:CD:EF:01\r\n';

test('fingerprints are normalized, deduplicated and sorted', () => {
  assert.equal(cryptoMod.sdpFingerprints(SDP), 'sha-256 AB:CD:EF:01');
  assert.equal(cryptoMod.sdpFingerprints('v=0'), '');
});

test('link MACs verify only with the same key, ids, link and fingerprint', async () => {
  const key = util.randomLinkKey();
  const mac = await cryptoMod.linkMac(key, 'offer', 'a', 'b', 'L1', SDP);
  assert.equal(await cryptoMod.verifyLinkMac(key, 'offer', 'a', 'b', 'L1', SDP, mac), true);
  assert.equal(await cryptoMod.verifyLinkMac(util.randomLinkKey(), 'offer', 'a', 'b', 'L1', SDP, mac), false, 'other key');
  assert.equal(await cryptoMod.verifyLinkMac(key, 'answer', 'a', 'b', 'L1', SDP, mac), false, 'other kind');
  assert.equal(await cryptoMod.verifyLinkMac(key, 'offer', 'b', 'a', 'L1', SDP, mac), false, 'swapped ids');
  assert.equal(await cryptoMod.verifyLinkMac(key, 'offer', 'a', 'b', 'L2', SDP, mac), false, 'other link');
  const swapped = SDP.replace(/AB:CD:EF:01/gi, '99:99:99:99');
  assert.equal(await cryptoMod.verifyLinkMac(key, 'offer', 'a', 'b', 'L1', swapped, mac), false, 'MITM fingerprint');
  assert.equal(await cryptoMod.verifyLinkMac(key, 'offer', 'a', 'b', 'L1', SDP, undefined), false);
});

test('link MAC is HMAC-SHA256 over a fixed, documented input', async () => {
  const key = util.randomLinkKey();
  const mac = await cryptoMod.linkMac(key, 'offer', 'a', 'b', 'L', SDP);
  const expected = createHmac('sha256', Buffer.from(util.fromBase64Url(key)))
    .update('filesync-link-v1|offer|a|b|L|sha-256 AB:CD:EF:01').digest('base64url');
  assert.equal(mac, expected);
});

test('password proofs: right password passes, wrong one and replayed nonce fail', async () => {
  const verifier = await cryptoMod.derivePasswordKey('correct horse', 'abc-defg-hij');
  const guess = await cryptoMod.derivePasswordKey('Correct horse', 'abc-defg-hij');
  const otherRoom = await cryptoMod.derivePasswordKey('correct horse', 'zzz-zzzz-zzz');
  assert.notEqual(verifier, otherRoom, 'room id salts the verifier');
  const proof = await cryptoMod.passwordProof(verifier, 'n'.repeat(24), 'guest1');
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await cryptoMod.checkPasswordProof(verifier, 'n'.repeat(24), 'guest1', proof), true);
  assert.equal(await cryptoMod.checkPasswordProof(verifier, 'm'.repeat(24), 'guest1', proof), false, 'new nonce');
  assert.equal(await cryptoMod.checkPasswordProof(verifier, 'n'.repeat(24), 'guest2', proof), false, 'other guest');
  const wrong = await cryptoMod.passwordProof(guess, 'n'.repeat(24), 'guest1');
  assert.equal(await cryptoMod.checkPasswordProof(verifier, 'n'.repeat(24), 'guest1', wrong), false);
});

test('safeEqual compares exactly', () => {
  assert.equal(cryptoMod.safeEqual('abc', 'abc'), true);
  assert.equal(cryptoMod.safeEqual('abc', 'abd'), false);
  assert.equal(cryptoMod.safeEqual('abc', 'ab'), false);
  assert.equal(cryptoMod.safeEqual(null, 'ab'), false);
});

// ---- protocol ----------------------------------------------------------------------------

test('parse rejects junk and unknown types', () => {
  for (const raw of [null, 1, 'x', [], {}, { t: 'nope' }, { t: '__proto__' }, { t: 'toString' }, { t: 'get' }]) {
    assert.equal(protocol.parse(raw), null, JSON.stringify(raw));
  }
});

test('file metadata is sanitized and owner is never taken from the sender', () => {
  const m = protocol.parse({ t: 'file-add', files: [
    { id: 'f1', name: '../../x.sh', path: 'a/../b', size: 10, type: 'Text/Plain', owner: 'someone-else', thumb: 'javascript:alert(1)' },
    { id: 'bad id!', name: 'y', size: 1 },
    { id: 'f2', name: 'z', size: -1 },
  ] });
  assert.equal(m.files.length, 1);
  const f = m.files[0];
  assert.deepEqual(f, { id: 'f1', name: 'x.sh', path: 'a/b', size: 10, type: 'text/plain', thumb: null });
  assert.equal('owner' in f, false);
});

test('thumbnails must be small base64 data URLs of raster images', () => {
  assert.equal(protocol.parseThumb('data:image/jpeg;base64,/9j/AA=='), 'data:image/jpeg;base64,/9j/AA==');
  assert.equal(protocol.parseThumb('data:image/svg+xml;base64,PHN2Zz4='), null);
  assert.equal(protocol.parseThumb(`data:image/png;base64,${'A'.repeat(40_000)}`), null);
  assert.equal(protocol.parseThumb('https://evil/x.png'), null);
});

test('host-relayed catalogs keep owners; entries without owners are dropped', () => {
  const m = protocol.parse({ t: 'catalog', add: [{ id: 'f', name: 'a', size: 1, owner: 'g1' }, { id: 'h', name: 'b', size: 1 }], remove: ['x', 7] });
  assert.deepEqual(m.add.map((f) => f.owner), ['g1']);
  assert.deepEqual(m.remove, ['x']);
});

test('texts: empty bodies rejected, length capped, CRLF normalized', () => {
  assert.equal(protocol.parse({ t: 'text', id: 'a', body: '   ' }), null);
  assert.equal(protocol.parse({ t: 'text', id: 'a', body: 'x'.repeat(20_000) }).body.length, protocol.LIMITS.textLength);
  assert.equal(protocol.parse({ t: 'text', id: 'a', body: 'a\r\nb' }).body, 'a\nb');
  const relayed = protocol.parse({ t: 'text', id: 'a', from: 'g', name: 'N', body: 'hi', at: 5 });
  assert.deepEqual(relayed.item, { id: 'a', from: 'g', name: 'N', body: 'hi', at: 5 });
});

test('text deletes carry only a valid message id', () => {
  assert.deepEqual(protocol.parse({ t: 'text-delete', id: 'm1', from: 'someone-else' }), { t: 'text-delete', id: 'm1' });
  assert.equal(protocol.parse({ t: 'text-delete', id: '../x' }), null);
  assert.equal(protocol.parse({ t: 'text-delete' }), null);
  assert.equal(protocol.hostAccepts('text-delete', true), true);
});

test('transfer messages need valid ids and non-negative integer offsets', () => {
  assert.ok(protocol.parse({ t: 'get', xfer: 'x1', file: 'f1', offset: 0 }));
  assert.equal(protocol.parse({ t: 'get', xfer: 'x1', file: 'f1', offset: -5 }), null);
  assert.equal(protocol.parse({ t: 'get', xfer: 'x1', file: 'f1', offset: 1.5 }), null);
  assert.equal(protocol.parse({ t: 'get', xfer: 'x1', file: 'f1', offset: Number.MAX_VALUE }), null);
});

test('who may send what (S2): room state only from the host, handshake before admission', () => {
  // Host side, before the password check: only the handshake.
  for (const t of ['rename', 'file-add', 'file-remove', 'text', 'text-delete', 'get']) assert.equal(protocol.hostAccepts(t, false), false, t);
  for (const t of ['hello', 'auth-proof', 'bye']) assert.equal(protocol.hostAccepts(t, false), true, t);
  // A guest can never push room state to the host.
  for (const t of ['welcome', 'members', 'catalog', 'auth-challenge']) assert.equal(protocol.hostAccepts(t, true), false, t);
  // Guests accept room state from the host only.
  for (const t of ['welcome', 'members', 'catalog', 'text', 'text-delete']) {
    assert.equal(protocol.guestAcceptsFromHost(t), true, t);
    assert.equal(protocol.guestAcceptsFromPeer(t), false, t);
  }
  for (const t of ['get', 'queued', 'cancel', 'bye']) assert.equal(protocol.guestAcceptsFromPeer(t), true, t);
});

test('without WebCrypto (plain HTTP), HMAC, PBKDF2 and UUIDs still work and match', async () => {
  const real = globalThis.crypto;
  const { pbkdf2Sync } = await import('node:crypto');
  Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: (a) => real.getRandomValues(a) }, configurable: true });
  try {
    const js = await import('../../web/js/app/crypto.js?insecure');
    const jsUtil = await import('../../web/js/app/util.js?insecure');
    for (const keyLen of [16, 64, 100]) {
      const key = new Uint8Array(nodeRandom(keyLen));
      const mac = await js.hmacSha256(key, 'hello world');
      assert.equal(Buffer.from(mac).toString('hex'), createHmac('sha256', key).update('hello world').digest('hex'), `key ${keyLen}`);
    }
    const bits = await js.pbkdf2Sha256(new TextEncoder().encode('pässword'), new TextEncoder().encode('salt'), 1000);
    assert.equal(Buffer.from(bits).toString('hex'), pbkdf2Sync('pässword', 'salt', 1000, 32, 'sha256').toString('hex'));
    // Same verifier and proofs as the WebCrypto path.
    assert.equal(await js.derivePasswordKey('pw', 'abc-defg-hij'), await cryptoMod.derivePasswordKey('pw', 'abc-defg-hij'));
    assert.match(jsUtil.randomId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
});

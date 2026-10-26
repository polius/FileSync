// Room protocol end to end over in-memory links: membership, passwords, authorization,
// transfers in every direction, departures, resume and bundles.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub, memorySink, until, tick } from './helpers/fakes.mjs';

globalThis.RTCPeerConnection = globalThis.RTCPeerConnection || class {};

const { Room } = await import('../../web/js/app/room.js');
const { derivePasswordKey } = await import('../../web/js/app/crypto.js');
const { downloadZip } = await import('../../web/js/vendors/client-zip.min.js');

const ROOM = 'abc-defg-hij';
const KEY = 'AAAAAAAAAAAAAAAAAAAAAA';
const FAST = {
  requestTimeoutMs: 300, resumeDelaysMs: [20, 20, 20], hostReturnWindowMs: 600, hostByeWindowMs: 300,
  joinRetryMs: 300, authWindowMs: 60_000, memberWaitMs: 300, stallMs: 400,
};

const sha = (b) => createHash('sha256').update(b).digest('hex');

function setup() {
  const hub = new Hub();
  const sinks = [];
  const make = (opts) => {
    const room = new Room({
      role: opts.role,
      roomId: ROOM,
      me: { id: opts.id || (opts.role === 'host' ? ROOM : `guest-${Math.random().toString(36).slice(2, 10)}`), token: opts.token || `tok-${Math.random()}`, name: opts.name },
      key: opts.key === undefined ? KEY : opts.key,
      verifier: opts.verifier || null,
      deps: {
        Signaling: hub.Signaling,
        Network: hub.Network,
        makeThumbnail: async () => null,
        downloadZip,
        openSink: async (o) => { const s = memorySink(); s.name = o.name; sinks.push(s); return s; },
        timing: { ...FAST, ...(opts.timing || {}) },
      },
    });
    room.toasts = [];
    room.on('toast', (t) => room.toasts.push(t.text));
    room.start();
    return room;
  };
  return { hub, make, sinks };
}

function fileEntry(name, size, path = '') {
  const bytes = new Uint8Array(randomBytes(size));
  return { bytes, entry: { file: new File([bytes], name, { type: 'application/octet-stream' }), path } };
}

async function joined(room) {
  await until(() => room.phase === 'ready');
}

test('guests join, everyone sees the same members, and the link is verified with the key', async () => {
  const { make } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  const b = make({ role: 'guest', name: 'Bob', key: null });
  await joined(a);
  await joined(b);
  await until(() => a.members.size === 3 && b.members.size === 3 && host.members.size === 3);
  assert.deepEqual([...a.members.values()].map((m) => m.name).sort(), ['Ann', 'Bob', 'Hana']);
  assert.equal(a.verified, true, 'joined with the key');
  assert.equal(b.verified, false, 'typed code, no key');
  assert.equal(host.members.get(a.me.id).verified, true);
  assert.equal(host.members.get(b.me.id).verified, false);
});

test('host files reach guests and download intact; the owner sees who received them', async () => {
  const { make, sinks } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  await joined(a);
  const { bytes, entry } = fileEntry('report.pdf', 700_000);
  host.addFiles([entry]);
  const f = await until(() => [...a.files.values()][0]);
  assert.equal(f.name, 'report.pdf');
  assert.equal(f.owner, ROOM);
  await a.download(f.id);
  await until(() => f.status === 'done');
  assert.equal(f.sha256, sha(bytes));
  assert.deepEqual(sinks[0].bytes(), bytes);
  assert.equal(sinks[0].closed, true);
  const mine = [...host.files.values()][0];
  await until(() => mine.receivers.get(a.me.id)?.status === 'done');
});

test('guest-to-guest transfers go directly between the guests', async () => {
  const { make, hub, sinks } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  const b = make({ role: 'guest', name: 'Bob' });
  await joined(a);
  await joined(b);
  const { bytes, entry } = fileEntry('photo.jpg', 300_000, 'Trip/Day 1');
  a.addFiles([entry]);
  const f = await until(() => [...b.files.values()][0]);
  assert.equal(f.owner, a.me.id);
  assert.equal(f.path, 'Trip/Day 1');
  assert.ok([...host.files.values()].some((x) => x.id === f.id), 'host lists it too');
  await b.download(f.id);
  await until(() => f.status === 'done');
  assert.deepEqual(sinks[0].bytes(), bytes);
  assert.ok(hub.nets.get(b.me.id).link(a.me.id), 'b has a direct link to a');
});

test('the host can download files shared by a guest', async () => {
  const { make, sinks } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  await joined(a);
  const { bytes, entry } = fileEntry('notes.txt', 5000);
  a.addFiles([entry]);
  const f = await until(() => [...host.files.values()].find((x) => !x.mine));
  await host.download(f.id);
  await until(() => f.status === 'done');
  assert.deepEqual(sinks[0].bytes(), bytes);
});

test('passwords: wrong answers are rejected with growing waits, the right one admits', async () => {
  const { make } = setup();
  const verifier = await derivePasswordKey('s3cret', ROOM);
  const host = make({ role: 'host', name: 'Hana', verifier });
  await joined(host);
  const g = make({ role: 'guest', name: 'Gus' });
  await until(() => g.phase === 'password');
  assert.equal(host.members.size, 1, 'not admitted before the password');

  await g.submitPassword('wrong');
  await until(() => g.passwordError);
  assert.equal(g.passwordError.retryAfter, 1);
  assert.equal(host.members.size, 1);

  await g.submitPassword('also wrong');
  await until(() => g.passwordError?.retryAfter === 2);

  await g.submitPassword('s3cret');
  await joined(g);
  assert.equal(host.members.size, 2);
  assert.equal(g.secured, true);
});

test('password guessing is limited room-wide, even with fresh peer ids', async () => {
  const { make } = setup();
  const verifier = await derivePasswordKey('s3cret', ROOM);
  const host = make({ role: 'host', name: 'Hana', verifier });
  await joined(host);
  let last;
  for (let i = 0; i < 6; i++) {
    const g = make({ role: 'guest', name: `G${i}` });
    await until(() => g.phase === 'password');
    await g.submitPassword(`guess-${i}`);
    await until(() => g.passwordError);
    last = g.passwordError.retryAfter;
  }
  assert.ok(last >= 30, `after 5 failures everyone waits (got ${last} s)`);
  // Even the right password is refused during the lockout.
  const g = make({ role: 'guest', name: 'Late' });
  await until(() => g.phase === 'password');
  await g.submitPassword('s3cret');
  await until(() => g.passwordError);
  assert.equal(host.members.has(g.me.id), false);
});

test('S2: guests can not act as someone else or push room state', async () => {
  const { make, hub } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  const b = make({ role: 'guest', name: 'Bob' });
  await joined(a);
  await joined(b);
  const { entry } = fileEntry('contract.pdf', 100);
  host.addFiles([entry]);
  const hostFile = [...host.files.values()][0];
  await until(() => b.files.has(hostFile.id));

  const aToHost = hub.nets.get(a.me.id).link(ROOM);
  // Remove the host's file: ignored, a doesn't own it.
  aToHost.send({ t: 'file-remove', ids: [hostFile.id] });
  // Announce a file with someone else's id as owner: the host stamps a as owner.
  aToHost.send({ t: 'file-add', files: [{ id: 'evil1', name: 'invoice.exe', size: 1, owner: ROOM }] });
  // Push room state to the host: not accepted from guests at all.
  aToHost.send({ t: 'members', members: [{ id: 'x', name: 'Ghost' }] });
  aToHost.send({ t: 'catalog', add: [{ id: 'evil2', name: 'y', size: 1, owner: ROOM }] });
  await until(() => host.files.has('evil1'));
  await tick(30);
  assert.equal(hostFile.status, 'shared', 'host file still shared');
  assert.equal(b.files.get(hostFile.id).status, 'available', 'still available to others');
  assert.equal(host.files.get('evil1').owner, a.me.id, 'owner stamped from the link');
  await until(() => b.files.get('evil1'));
  assert.equal(b.files.get('evil1').owner, a.me.id);
  assert.equal(host.files.has('evil2'), false);
  assert.equal(host.members.has('x'), false);

  // A guest opening a direct link to another guest can't push room state there either.
  const aToB = hub.nets.get(a.me.id).connect(b.me.id);
  await until(() => aToB.state === 'open');
  aToB.send({ t: 'members', members: [{ id: a.me.id, name: 'Ann' }] });
  aToB.send({ t: 'catalog', remove: [hostFile.id], add: [{ id: 'evil3', name: 'z', size: 1, owner: ROOM }] });
  aToB.send({ t: 'welcome', proto: 2, you: b.me.id, members: [], files: [], texts: [] });
  await tick(30);
  assert.equal(b.members.has(ROOM), true, 'host still a member for b');
  assert.equal(b.files.get(hostFile.id).status, 'available');
  assert.equal(b.files.has('evil3'), false);
});

test('renames apply only to the sender and propagate', async () => {
  const { make } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  const b = make({ role: 'guest', name: 'Bob' });
  await joined(a);
  await joined(b);
  a.rename('Annie');
  await until(() => b.members.get(a.me.id)?.name === 'Annie');
  assert.equal(b.members.get(b.me.id).name, 'Bob');
});

test('F2: when an owner leaves, their files become unavailable and downloads stop', async () => {
  const { make, hub } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  const b = make({ role: 'guest', name: 'Bob' });
  await joined(a);
  await joined(b);
  const { entry } = fileEntry('big.bin', 200_000);
  a.addFiles([entry]);
  const f = await until(() => [...b.files.values()][0]);
  hub.offline.add(a.me.id);
  hub.disconnect(a.me.id);
  await until(() => f.status === 'unavailable');
  assert.equal(b.members.has(a.me.id), false);
  await b.download(f.id);   // a no-op, not a hang
  assert.equal(f.status, 'unavailable');
});

test('F2: a request the sender never answers ends in a clear paused state', async () => {
  const { make, hub } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  await joined(a);
  const { entry } = fileEntry('x.bin', 1000);
  host.addFiles([entry]);
  const f = await until(() => [...a.files.values()][0]);
  // The host swallows every request.
  const link = hub.nets.get(ROOM).link(a.me.id);
  const emit = link.emit.bind(link);
  link.emit = (ev, msg) => (ev === 'message' && msg?.t === 'get' ? undefined : emit(ev, msg));
  await a.download(f.id);
  await until(() => f.status === 'paused', { timeout: 4000 });
  assert.match(f.error, /didn’t respond/);
});

test('an interrupted download resumes on its own and verifies', async () => {
  const { make, hub, sinks } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  await joined(a);
  const { bytes, entry } = fileEntry('movie.mp4', 6 * 1024 * 1024);
  host.addFiles([entry]);
  const f = await until(() => [...a.files.values()][0]);
  await a.download(f.id);
  await until(() => f.written > 1024 * 1024);
  // Drop just the transfer channel; the room link survives.
  hub.nets.get(ROOM).link(a.me.id).lastChannel.close();
  await until(() => f.status === 'done', { timeout: 8000 });
  assert.equal(f.sha256, sha(bytes));
  assert.deepEqual(sinks[0].bytes(), bytes);
});

test('cancelling stops the transfer and discards the partial file', async () => {
  const { make, sinks } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  await joined(a);
  const { entry } = fileEntry('huge.iso', 30 * 1024 * 1024);
  host.addFiles([entry]);
  const f = await until(() => [...a.files.values()][0]);
  await a.download(f.id);
  await until(() => f.written > 0);
  a.cancelDownload(f.id);
  await until(() => f.status === 'available');
  assert.ok(sinks[0].aborted, 'sink aborted');
  const mine = [...host.files.values()][0];
  await until(() => mine.receivers.get(a.me.id)?.status === 'stopped');
});

test('removing a shared file stops it for everyone', async () => {
  const { make } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  await joined(a);
  const { entry } = fileEntry('draft.docx', 1000);
  host.addFiles([entry]);
  const f = await until(() => [...a.files.values()][0]);
  host.removeFile([...host.files.values()][0].id);
  await until(() => f.status === 'unavailable');
});

test('the sender queues requests beyond 5 and serves them in order', async () => {
  const { make } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  await joined(a);
  host.addFiles(Array.from({ length: 7 }, (_, i) => fileEntry(`f${i}.bin`, 2 * 1024 * 1024).entry));
  await until(() => a.files.size === 7);
  for (const f of a.files.values()) await a.download(f.id);
  await until(() => [...a.files.values()].some((f) => f.status === 'queued'));
  await until(() => [...a.files.values()].every((f) => f.status === 'done'), { timeout: 15000 });
});

test('Download all saves one zip with folder paths and unique names', async () => {
  const { make, sinks } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  await joined(a);
  const one = fileEntry('a.txt', 1000);
  const two = fileEntry('a.txt', 2000, 'Docs');
  const three = fileEntry('a.txt', 3000);
  host.addFiles([one.entry]);
  host.addFiles([two.entry]);
  host.addFiles([three.entry]);
  await until(() => a.files.size === 3);
  await a.downloadAll();
  assert.equal(a.bundle.state, 'done');
  assert.match(sinks[0].name, /^filesync-abc-defg-hij-\d{4}-\d{2}-\d{2}\.zip$/);
  for (const f of a.files.values()) assert.equal(f.status, 'done', 'each file is marked as downloaded');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-zip-'));
  const zip = path.join(dir, 'b.zip');
  fs.writeFileSync(zip, sinks[0].bytes());
  const listing = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(listing, ['Docs/a.txt', 'a (2).txt', 'a.txt'].sort());
  const content = execFileSync('unzip', ['-p', zip, 'Docs/a.txt']);
  assert.deepEqual(new Uint8Array(content), two.bytes);
  execFileSync('unzip', ['-tq', zip]);
  fs.rmSync(dir, { recursive: true });
});

test('messages go to everyone with the real sender name', async () => {
  const { make } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  const b = make({ role: 'guest', name: 'Bob' });
  await joined(a);
  await joined(b);
  a.sendText('https://example.com/doc');
  await until(() => b.texts.length === 1 && host.texts.length === 1 && a.texts.length === 1);
  assert.equal(b.texts[0].name, 'Ann');
  assert.equal(b.texts[0].from, a.me.id);
  assert.equal(b.texts[0].body, 'https://example.com/doc');
});

test('you can delete your own messages for everyone, including later joiners, but no one else\'s', async () => {
  const { make, hub } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  const b = make({ role: 'guest', name: 'Bob' });
  await joined(a);
  await joined(b);
  a.sendText('my password is hunter2');
  a.sendText('keep this one');
  host.sendText('from the host');
  await until(() => b.texts.length === 3 && a.texts.length === 3);
  const [secret, keep, fromHost] = ['my password is hunter2', 'keep this one', 'from the host'].map((body) => a.texts.find((t) => t.body === body));

  // Not yours: refused locally, and the host ignores a forged request.
  assert.equal(a.deleteText(fromHost.id), false);
  const bToHost = hub.nets.get(b.me.id).link(ROOM);
  bToHost.send({ t: 'text-delete', id: secret.id });
  bToHost.send({ t: 'text', id: keep.id, body: 'reusing an existing id' });
  await tick(30);
  assert.equal(host.texts.length, 3, 'a forged delete and a duplicate id change nothing');
  assert.equal(host.texts.find((t) => t.id === keep.id).body, 'keep this one');

  // Yours: gone for everyone, and for someone who joins afterwards.
  assert.equal(a.deleteText(secret.id), true);
  await until(() => host.texts.length === 2 && a.texts.length === 2 && b.texts.length === 2);
  assert.equal(b.texts.some((t) => t.id === secret.id), false);
  const c = make({ role: 'guest', name: 'Cid' });
  await joined(c);
  assert.deepEqual(c.texts.map((t) => t.body).sort(), ['from the host', 'keep this one']);

  // The host deletes its own the same way.
  assert.equal(host.deleteText(fromHost.id), true);
  await until(() => a.texts.length === 1 && b.texts.length === 1 && c.texts.length === 1);
});

test('a guest reconnecting re-announces its files; a host reload keeps guests in the room', async () => {
  const { make, hub } = setup();
  const verifier = await derivePasswordKey('pw', ROOM);
  const host = make({ role: 'host', name: 'Hana', token: 'host-token', verifier });
  await joined(host);
  const a = make({ role: 'guest', name: 'Ann' });
  await until(() => a.phase === 'password');
  await a.submitPassword('pw');
  await joined(a);
  const { entry } = fileEntry('keep.txt', 100);
  a.addFiles([entry]);
  await until(() => host.files.size === 1);

  // The host tab reloads: same room id and token, everything else is new.
  host.leave();
  hub.nets.delete(ROOM);
  const host2 = make({ role: 'host', name: 'Hana', token: 'host-token', verifier });
  await joined(host2);
  await until(() => a.hostLink === 'open' && host2.members.has(a.me.id), { timeout: 4000 });
  await until(() => host2.files.size === 1, { timeout: 2000 });
  assert.equal(a.phase, 'ready', 'the guest answered the password challenge again by itself');
});

test('nobody else can take the room id', async () => {
  const { make } = setup();
  const host = make({ role: 'host', name: 'Hana', token: 'real' });
  await joined(host);
  const thief = make({ role: 'host', name: 'Mallory', token: 'other' });
  await until(() => thief.phase === 'error');
  assert.equal(thief.error.code, 'taken');
  assert.equal(host.phase, 'ready');
});

test('a guest gives up cleanly when the room never answers', async () => {
  const { make } = setup();
  const g = make({ role: 'guest', name: 'Gus' });
  await until(() => g.phase === 'error', { timeout: 4000 });
  assert.equal(g.error.code, 'host-gone');
});

test('busy reflects whether leaving would break something', async () => {
  const { make } = setup();
  const host = make({ role: 'host', name: 'Hana' });
  await joined(host);
  assert.equal(host.busy, false, 'empty room');
  host.addFiles([fileEntry('a', 1).entry]);
  assert.equal(host.busy, true, 'sharing a file');
});

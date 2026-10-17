// SW streaming backpressure tests (C3). Run: node --test --test-force-exit "tests/js/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------- ServiceWorkerGlobalScope stub (must exist before sw.js is imported) ----------
const listeners = new Map();
globalThis.self = {
  addEventListener(type, fn) { listeners.set(type, fn); },
  skipWaiting() {},
  clients: { claim: async () => {} },
};

await import(new URL('../../web/sw.js', import.meta.url).href);

const onMessage = listeners.get('message');
const onFetch = listeners.get('fetch');
assert.ok(onMessage && onFetch, 'sw.js must register message + fetch handlers');

const WINDOW = 64;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A deadlock here would otherwise hang the whole test file — fail loudly instead.
function readWithTimeout(reader, ms = 3000) {
  return Promise.race([
    reader.read(),
    sleep(ms).then(() => { throw new Error(`reader.read() did not settle within ${ms}ms`); }),
  ]);
}

/** Register a transfer; return the page-side port and helpers to inspect the worker. */
function register(id) {
  const channel = new MessageChannel();
  const inbox = [];
  channel.port1.onmessage = (ev) => inbox.push(ev.data);
  onMessage({
    data: { type: 'register', id, name: `${id}.bin`, size: 4096, mime: 'application/octet-stream', port: channel.port2 },
  });
  const fetchResponse = () => {
    let response = null;
    onFetch({ request: { url: `https://filesync.test/__download/${id}` }, respondWith: (r) => { response = r; } });
    return response;
  };
  return {
    port: channel.port1,
    inbox,
    credits: () => inbox.filter((m) => m?.type === 'credit').reduce((n, m) => n + m.n, 0),
    count: (type) => inbox.filter((m) => m?.type === type).length,
    fetchResponse,
  };
}

const chunk = (n = 16) => new Uint8Array(n).fill(7).buffer;

async function drain(reader) {
  const sizes = [];
  for (;;) {
    const { value, done } = await readWithTimeout(reader);
    if (done) break;
    sizes.push(value.byteLength);
  }
  return sizes;
}

test('grants a bounded initial window and nothing more while the queue is full', async () => {
  const t = register('t1');
  await sleep(20);
  assert.equal(t.count('ready'), 1, 'worker must announce readiness');
  assert.equal(t.credits(), WINDOW, 'initial window is handed to the page');

  for (let i = 0; i < WINDOW; i++) t.port.postMessage(chunk());
  await sleep(80);
  assert.equal(t.credits(), WINDOW, 'window must not grow while the queue is full');
  t.port.postMessage({ type: 'end' });
  await sleep(20);
});

test('draining the response releases exactly the freed room', async () => {
  const t = register('t2');
  await sleep(20);
  const reader = t.fetchResponse().body.getReader();
  for (let i = 0; i < WINDOW; i++) t.port.postMessage(chunk(16));
  await sleep(80);
  const before = t.credits();

  for (let i = 0; i < 10; i++) await readWithTimeout(reader);
  await sleep(150);
  assert.equal(t.credits(), before + 10, 'exactly 10 credits come back after 10 reads');

  t.port.postMessage({ type: 'end' });
  const rest = await drain(reader);
  assert.equal(rest.length, WINDOW - 10, 'every queued chunk is delivered exactly once');
  assert.ok(rest.every((n) => n === 16));
});

test('a page that ignores its window gains no credit, and still loses no bytes', async () => {
  const t = register('t3');
  await sleep(20);
  const reader = t.fetchResponse().body.getReader();
  // Over-send must never grant credit for memory the consumer has not freed.
  for (let i = 0; i < WINDOW + 20; i++) t.port.postMessage(chunk());
  await sleep(80);
  assert.equal(t.credits(), WINDOW, 'over-sending must not buy additional credit');

  for (let i = 0; i < 30; i++) await readWithTimeout(reader);   // 20 overflow + 10 real room
  await sleep(150);
  assert.equal(t.credits(), WINDOW + 10, 'credit tracks freed room, not the overflow');

  t.port.postMessage({ type: 'end' });
  const rest = await drain(reader);
  assert.equal(rest.length, WINDOW + 20 - 30, 'no bytes are lost or duplicated');
});

test('end closes the stream and preserves byte content', async () => {
  const t = register('t4');
  await sleep(20);
  const reader = t.fetchResponse().body.getReader();
  t.port.postMessage(new Uint8Array([1, 2, 3, 4, 5]).buffer);
  t.port.postMessage({ type: 'end' });
  const first = await readWithTimeout(reader);
  assert.equal(first.done, false);
  assert.deepEqual([...new Uint8Array(first.value)], [1, 2, 3, 4, 5]);
  const second = await readWithTimeout(reader);
  assert.equal(second.done, true, 'stream is closed after end');
});

test('abort errors the stream', async () => {
  const t = register('t5');
  await sleep(20);
  const reader = t.fetchResponse().body.getReader();
  t.port.postMessage({ type: 'abort', reason: 'disk full' });
  await assert.rejects(() => readWithTimeout(reader), /disk full/);
});

test('consumer cancel is reported back to the page', async () => {
  const t = register('t6');
  await sleep(20);
  const reader = t.fetchResponse().body.getReader();
  await reader.cancel();
  await sleep(30);
  assert.equal(t.count('cancel'), 1, 'the page must be told the download was cancelled');
});

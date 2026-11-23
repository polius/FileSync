// Hasher pacing against a stand-in worker: the queue of unhashed bytes must stay bounded
// when the caller produces bytes faster than the worker hashes them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tick } from './helpers/fakes.mjs';

const { Hasher } = await import('../../web/js/app/hasher.js');

const CHECKPOINT = 4 * 1024 * 1024;   // PACE_BYTES in hasher.js

// A worker that only works when told to, so a test decides how far behind it is.
class LazyWorker {
  static last = null;
  queue = [];
  terminated = false;
  constructor() { LazyWorker.last = this; }
  postMessage(msg) { this.queue.push(msg); }
  terminate() { this.terminated = true; }
  work(count = Infinity) {
    while (count-- > 0 && this.queue.length) {
      const msg = this.queue.shift();
      if (msg.op === 'sync') this.onmessage({ data: { seq: msg.seq } });
      else if (msg.op === 'digest') this.onmessage({ data: { seq: msg.seq, hex: 'digest' } });
    }
  }
}

function workerHasher() {
  const saved = { Worker: globalThis.Worker, window: globalThis.window };
  globalThis.Worker = LazyWorker;
  globalThis.window = {};
  try { return { hasher: new Hasher(), worker: LazyWorker.last }; }
  finally { globalThis.Worker = saved.Worker; globalThis.window = saved.window; }
}

// Whether pace() has let the caller go on, without waiting for it.
function watch(paced) {
  const state = { released: false };
  Promise.resolve(paced).then(() => { state.released = true; });
  return state;
}

test('pace() returns at once until a checkpoint worth of bytes is queued', () => {
  const { hasher } = workerHasher();
  hasher.update(new Uint8Array(CHECKPOINT - 1));
  assert.equal(hasher.pace(), undefined);
  hasher.dispose();
});

test('pace() holds the caller once the worker is two checkpoints behind', async () => {
  const { hasher, worker } = workerHasher();
  const chunk = new Uint8Array(CHECKPOINT);

  hasher.update(chunk);
  const first = watch(hasher.pace());
  await tick();
  assert.equal(first.released, true, 'one checkpoint may wait in the queue');

  hasher.update(chunk);
  const second = watch(hasher.pace());
  await tick();
  assert.equal(second.released, false, 'the caller waits for the first checkpoint');

  worker.work(2);            // the first chunk and its checkpoint
  await tick();
  assert.equal(second.released, true);

  const digest = hasher.digest();
  worker.work();
  assert.equal(await digest, 'digest');
  assert.equal(worker.terminated, true, 'the worker is released with the digest');
});

test('dispose() releases a caller waiting in pace()', async () => {
  const { hasher, worker } = workerHasher();
  const chunk = new Uint8Array(CHECKPOINT);
  hasher.update(chunk);
  hasher.pace();
  hasher.update(chunk);
  const waiting = watch(hasher.pace());
  await tick();
  assert.equal(waiting.released, false);

  hasher.dispose();
  await tick();
  assert.equal(waiting.released, true);
  assert.equal(worker.terminated, true);
  assert.doesNotThrow(() => hasher.update(chunk), 'updates after dispose are ignored');
});

test('without a worker, hashing is inline and pace() never waits', async () => {
  const hasher = new Hasher();
  hasher.update(new Uint8Array(CHECKPOINT * 3));
  assert.equal(hasher.pace(), undefined);
  assert.match(await hasher.digest(), /^[0-9a-f]{64}$/);
});

// OPFS staging-sweep tests (C4). Run: node --test --test-force-exit "tests/js/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------- minimal browser stubs (needed for sink.js to import) ----------
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, remove() {}, appendChild() {} }),
  body: { appendChild() {} },
  addEventListener() {},
};
globalThis.window = globalThis;
globalThis.location = {
  search: '', href: 'http://localhost/', protocol: 'http:', hostname: 'localhost',
  host: 'localhost', origin: 'http://localhost', replace() {},
};
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.isSecureContext = true;

// ---------- fake OPFS ----------
const dir = new Map();          // name -> { lastModified }
const removed = [];

const fakeRoot = {
  async *entries() {
    for (const [name, meta] of dir) {
      yield [name, { getFile: async () => ({ lastModified: meta.lastModified }) }];
    }
  },
  async removeEntry(name) { removed.push(name); dir.delete(name); },
};

function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}
setNavigator({ storage: { getDirectory: async () => fakeRoot } });

const { sweepStaleStaging } = await import(new URL('../../web/js/modules/sink.js', import.meta.url).href);

const HOUR = 60 * 60 * 1000;

test('sweeps stale staging files only, never fresh ones or foreign names', async () => {
  const now = Date.now();
  dir.clear();
  removed.length = 0;
  dir.set('filesync-part-stale', { lastModified: now - 2 * HOUR });
  dir.set('filesync-part-fresh', { lastModified: now - 1_000 });
  dir.set('filesync-part-boundary', { lastModified: now - HOUR + 60_000 });
  dir.set('some-other-app-file', { lastModified: now - 5 * HOUR });

  await sweepStaleStaging();

  assert.deepEqual(removed, ['filesync-part-stale'], 'only the aged staging file is removed');
  assert.ok(dir.has('filesync-part-fresh'), 'a fresh staging file must survive (may be live)');
  assert.ok(dir.has('filesync-part-boundary'), 'a file just inside the age limit must survive');
  assert.ok(dir.has('some-other-app-file'), 'files we do not own must never be removed');
});

test('is a no-op (never throws) when OPFS is unavailable or throws', async () => {
  setNavigator({});
  await sweepStaleStaging();

  setNavigator({ storage: { getDirectory: async () => { throw new Error('denied'); } } });
  await sweepStaleStaging();

  // Restore for any later test.
  setNavigator({ storage: { getDirectory: async () => fakeRoot } });
});

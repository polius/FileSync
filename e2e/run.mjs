// FileSync E2E runner.
//
// Drives a sender + receiver Playwright page against a running FileSync deployment,
// uploads a generated fixture file from the sender, waits for the receiver to download
// it, and compares SHA-256 of source vs received bytes. Reports a pass/fail matrix
// across {engine} × {sink} × {ice}.
//
// Today this file owns the whole runner; it will get split into lib/ + specs/ once the
// matrix grows beyond what fits comfortably in one file. The single-file shape is on
// purpose for the first iteration — it makes the end-to-end shape easy to follow.

import { chromium, firefox, webkit } from 'playwright';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

// ----- Arg parsing -----------------------------------------------------------

const argv = parseArgs(process.argv.slice(2));

const SMOKE = argv.smoke === true;
const BASE_URL    = (argv['base-url'] || 'http://localhost').replace(/\/$/, '');
const ENGINES     = parseList(argv.engines, SMOKE ? ['chromium'] : ['chromium', 'firefox', 'webkit']);
const SINKS       = parseList(argv.sinks,   SMOKE ? ['sw']       : ['sw', 'fs', 'blob']);
// 'turn' is opt-in: the deployed coturn denies relaying into private ranges
// (deploy/docker-compose.yml), so turn cells against a localhost stack fail by
// design. Pass --ice=auto,stun,turn after commenting out the deny flags.
const ICE_MODES   = parseList(argv.ice,     SMOKE ? ['auto']     : ['auto', 'stun']);
const SIZE_BYTES  = parseSize(argv.size,    '100M');
const KEEP        = argv.keep === true;

// Per-sink size cap. Blob holds the whole file in memory and the app documents a
// ~500 MB practical ceiling; we cap at 400 MB so a 1 GB matrix run still exercises
// Blob meaningfully without OOMing the headless browser.
const SINK_SIZE_CAP = {
  blob: 400 * 1024 * 1024,
};

// Per-cell budgets. ICE setup hangs are the most common failure mode — fail fast.
const PAIR_TIMEOUT_MS     = 30_000;
const TRANSFER_TIMEOUT_MS = 5 * 60_000;

// ----- Main ------------------------------------------------------------------

(async () => {
  console.log(`FileSync E2E — base URL: ${BASE_URL}`);
  console.log(`           engines: ${ENGINES.join(', ')}`);
  console.log(`             sinks: ${SINKS.join(', ')}`);
  console.log(`               ice: ${ICE_MODES.join(', ')}`);
  console.log(`              size: ${formatBytes(SIZE_BYTES)}`);
  console.log('');

  await fsp.mkdir(FIXTURES_DIR, { recursive: true });
  await fsp.mkdir(DOWNLOADS_DIR, { recursive: true });

  // Pre-generate the source fixture(s) we'll need. The Blob row may use a smaller
  // file than the rest of the matrix.
  const fixtureCache = new Map(); // sizeBytes -> { path, sha256 }
  const sizesNeeded = new Set([SIZE_BYTES]);
  for (const sink of SINKS) {
    if (SINK_SIZE_CAP[sink] && SIZE_BYTES > SINK_SIZE_CAP[sink]) {
      sizesNeeded.add(SINK_SIZE_CAP[sink]);
    }
  }
  for (const sz of sizesNeeded) {
    fixtureCache.set(sz, await ensureFixture(sz));
  }

  const cells = [];
  for (const engine of ENGINES) {
    for (const sink of SINKS) {
      for (const ice of ICE_MODES) {
        cells.push({ engine, sink, ice });
      }
    }
  }

  const results = [];
  for (const cell of cells) {
    const skip = preCheckSkip(cell);
    if (skip) {
      results.push({ ...cell, status: 'na', reason: skip, durationMs: 0 });
      printRow(cell, 'na', skip);
      continue;
    }
    const effectiveSize = effectiveSizeFor(cell.sink);
    const fixture = fixtureCache.get(effectiveSize);
    const t0 = Date.now();
    let result;
    try {
      result = await runCell(cell, fixture);
    } catch (err) {
      result = { status: 'fail', reason: stringifyError(err) };
    }
    const durationMs = Date.now() - t0;
    results.push({ ...cell, sizeBytes: effectiveSize, durationMs, ...result });
    printRow(cell, result.status, result.reason, durationMs);
  }

  console.log('');
  console.log(renderMatrix(results));

  const ok = results.every((r) => r.status === 'pass' || r.status === 'na');
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});

// ----- Cell runner -----------------------------------------------------------

function preCheckSkip(cell) {
  // FS Access API only exists in Chromium-family engines. Reporting these as ❌
  // would falsely suggest a regression — they're "not applicable" by spec.
  if (cell.sink === 'fs' && cell.engine !== 'chromium') {
    return 'FS Access API is Chromium-only by spec';
  }
  return null;
}

function effectiveSizeFor(sink) {
  const cap = SINK_SIZE_CAP[sink];
  if (cap && SIZE_BYTES > cap) return cap;
  return SIZE_BYTES;
}

async function runCell(cell, fixture) {
  const launcher = { chromium, firefox, webkit }[cell.engine];
  if (!launcher) throw new Error(`Unknown engine: ${cell.engine}`);

  const browser = await launcher.launch({ headless: true });
  try {
    // Each peer gets its own browser context so cookies/localStorage/SW state are
    // independent — same engine binary but two isolated browser profiles.
    const senderCtx   = await browser.newContext({ acceptDownloads: true });
    const receiverCtx = await browser.newContext({ acceptDownloads: true });

    // FS Access sink doesn't trigger a browser download — it writes to a user-picked
    // file via showSaveFilePicker(). Install a shim on the receiver context that
    // returns a fake handle whose writable streams chunks back to Node, where we
    // hash them incrementally. Done before any page navigation so the override is
    // in place before the app's first JS runs.
    const fsCapture = cell.sink === 'fs'
      ? await installFsSinkShim(receiverCtx)
      : null;

    const sender   = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();

    // Surface page console errors to the runner output so a broken cell is debuggable.
    for (const [label, page] of [['S', sender], ['R', receiver]]) {
      page.on('pageerror', (err) => console.log(`  [${label} pageerror] ${err.message}`));
      page.on('console',   (msg) => {
        if (msg.type() === 'error') console.log(`  [${label} console.error] ${msg.text()}`);
      });
    }

    const qs = `sink=${cell.sink}&ice=${cell.ice}`;
    await sender.goto(`${BASE_URL}/?${qs}`, { waitUntil: 'domcontentloaded', timeout: PAIR_TIMEOUT_MS });
    await sender.waitForSelector('#transfer-div', { state: 'visible', timeout: PAIR_TIMEOUT_MS });
    const shareUrl = await sender.locator('#transfer-url-value').textContent({ timeout: PAIR_TIMEOUT_MS });
    if (!shareUrl) throw new Error('Sender never produced a share URL');

    const receiverUrl = `${shareUrl.trim()}?${qs}`;
    await receiver.goto(receiverUrl, { waitUntil: 'domcontentloaded', timeout: PAIR_TIMEOUT_MS });
    await receiver.waitForSelector('#transfer-div', { state: 'visible', timeout: PAIR_TIMEOUT_MS });

    // Pairing complete when sender's "Connection established" badge appears.
    await sender.waitForSelector('#transfer-status-success', { state: 'visible', timeout: PAIR_TIMEOUT_MS });

    // Push the file into the sender's hidden file input.
    await sender.setInputFiles('#transfer-select-file-input', fixture.path);

    // Wait for the file row to materialise in the receiver's UI, then click its
    // download button. Selector: any list item in the files list except the
    // "No files transferred" placeholder.
    const fileRow = receiver.locator('#transfer-files-list li:not(#transfer-files-list-empty)').first();
    await fileRow.waitFor({ state: 'visible', timeout: PAIR_TIMEOUT_MS });
    const downloadButton = fileRow.locator('[id^="file-"][id$="-download"]').first();
    await downloadButton.waitFor({ state: 'visible', timeout: PAIR_TIMEOUT_MS });

    // Capture the receiver-side bytes. Two paths:
    //   - sw / blob: app triggers a browser download → page.on('download').
    //   - fs:        app writes via our shim → bytes stream back via the binding.
    let receivedHash, receivedSize;
    if (fsCapture) {
      await downloadButton.click();
      await Promise.race([
        fsCapture.donePromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('FS Access shim: close() never fired')), TRANSFER_TIMEOUT_MS),
        ),
      ]);
      receivedHash = fsCapture.hash.digest('hex');
      receivedSize = fsCapture.bytes;
    } else {
      const downloadPromise = receiver.waitForEvent('download', { timeout: TRANSFER_TIMEOUT_MS });
      await downloadButton.click();
      const download = await downloadPromise;
      const dlPath = await download.path();
      if (!dlPath) throw new Error('Download produced no path');
      receivedHash = await sha256File(dlPath);
      receivedSize = (await fsp.stat(dlPath)).size;
      if (KEEP) {
        const kept = path.join(DOWNLOADS_DIR, `${cell.engine}-${cell.sink}-${cell.ice}-${path.basename(dlPath)}`);
        await fsp.copyFile(dlPath, kept);
      }
    }

    if (receivedSize !== fixture.size) {
      return { status: 'fail', reason: `size mismatch: sent ${fixture.size}, got ${receivedSize}` };
    }
    if (receivedHash !== fixture.sha256) {
      return { status: 'fail', reason: `hash mismatch: sent ${fixture.sha256.slice(0,12)}…, got ${receivedHash.slice(0,12)}…` };
    }
    return { status: 'pass' };
  } finally {
    await browser.close();
  }
}

// Shim `window.showSaveFilePicker` on the given context to capture writes into a
// Node-side SHA-256 incrementally, without ever holding the whole file in memory.
// Returns an object with the running hash + a promise that resolves when the page
// calls close() on the writable.
async function installFsSinkShim(ctx) {
  const cap = {
    hash: createHash('sha256'),
    bytes: 0,
    donePromise: null,
    resolveDone: null,
  };
  cap.donePromise = new Promise((r) => { cap.resolveDone = r; });

  // Chunks come across as Uint8Array (structured-clone of the TypedArray the app
  // passes to writable.write()). Hash them, count them, return nothing.
  await ctx.exposeBinding('__fsChunk', async (_src, chunk) => {
    const buf = Buffer.from(chunk.buffer ?? chunk, chunk.byteOffset ?? 0, chunk.byteLength ?? chunk.length);
    cap.hash.update(buf);
    cap.bytes += buf.length;
  });
  await ctx.exposeBinding('__fsDone', async () => { cap.resolveDone(); });

  // The init script runs at the start of every navigation, so the override is in
  // place before file.js / sink.js load. The shim returns a fake FileSystemFileHandle
  // whose writable accepts the same input shapes the real API does.
  await ctx.addInitScript(() => {
    window.showSaveFilePicker = async () => ({
      kind: 'file',
      name: 'shim.bin',
      async createWritable() {
        // Emulate FileSystemWritableFileStream's lock: a real writable throws if write()
        // is called while a previous write() is still pending. This catches the app
        // issuing overlapping (unserialized) writes.
        let busy = false;
        let closed = false;
        return {
          async write(input) {
            if (closed) throw new DOMException('Stream is closed', 'InvalidStateError');
            if (busy) throw new DOMException('write() called during a pending write()', 'InvalidStateError');
            busy = true;
            try {
            // The real API accepts ArrayBuffer/TypedArray/Blob, or
            // { type: 'write', data, position?, size? }. The app currently calls
            // write(Uint8Array) directly, but handle the others defensively.
            let data = input;
            if (data && typeof data === 'object' && data.type === 'write') data = data.data;
            let bytes;
            if (data instanceof Blob) {
              bytes = new Uint8Array(await data.arrayBuffer());
            } else if (ArrayBuffer.isView(data)) {
              // Make a tight, transferable copy — the underlying buffer may be
              // a shared view the caller reuses.
              bytes = new Uint8Array(data.byteLength);
              bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            } else if (data instanceof ArrayBuffer) {
              bytes = new Uint8Array(data.slice(0));
            } else {
              throw new Error('FS shim: unsupported write input: ' + Object.prototype.toString.call(data));
            }
            await window.__fsChunk(bytes);
            } finally {
              busy = false;
            }
          },
          async close() { closed = true; await window.__fsDone(); },
          async abort() { closed = true; try { await window.__fsDone(); } catch {} },
          async seek()      { /* no-op */ },
          async truncate()  { /* no-op */ },
        };
      },
    });
  });

  return cap;
}

// ----- Fixture generation ----------------------------------------------------

// Generate an incompressible file of the given size, cached on disk under fixtures/.
// We hash with SHA-256 once at creation; cache the hash next to the file so re-runs
// don't re-hash.
async function ensureFixture(sizeBytes) {
  const filePath = path.join(FIXTURES_DIR, `fixture-${sizeBytes}.bin`);
  const hashPath = filePath + '.sha256';
  if (fs.existsSync(filePath) && fs.existsSync(hashPath) && (await fsp.stat(filePath)).size === sizeBytes) {
    const sha256 = (await fsp.readFile(hashPath, 'utf8')).trim();
    return { path: filePath, size: sizeBytes, sha256 };
  }
  process.stdout.write(`Generating fixture ${formatBytes(sizeBytes)}… `);
  const t0 = Date.now();
  const fh = await fsp.open(filePath, 'w');
  try {
    // 1 MiB write chunks. crypto.randomBytes is fast on macOS arm64 (~GB/s).
    const chunkSize = 1024 * 1024;
    let remaining = sizeBytes;
    while (remaining > 0) {
      const n = Math.min(chunkSize, remaining);
      await fh.write(randomBytes(n));
      remaining -= n;
    }
  } finally {
    await fh.close();
  }
  const sha256 = await sha256File(filePath);
  await fsp.writeFile(hashPath, sha256 + '\n');
  console.log(`done (${(Date.now() - t0)/1000}s, sha256 ${sha256.slice(0, 12)}…)`);
  return { path: filePath, size: sizeBytes, sha256 };
}

async function sha256File(p) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(p, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

// ----- Output ----------------------------------------------------------------

function printRow(cell, status, reason, durationMs) {
  const icon = { pass: '✅', fail: '❌', na: '⚪' }[status] || '?';
  const dur = durationMs != null ? ` (${(durationMs/1000).toFixed(1)}s)` : '';
  const tag = `${cell.engine.padEnd(8)} ${cell.sink.padEnd(4)} ${cell.ice.padEnd(4)}`;
  const detail = reason ? ` — ${reason}` : '';
  console.log(`${icon} ${tag}${dur}${detail}`);
}

function renderMatrix(results) {
  // Group by engine × sink, with ICE modes as sub-columns.
  const engines = [...new Set(results.map(r => r.engine))];
  const sinks   = [...new Set(results.map(r => r.sink))];
  const ices    = [...new Set(results.map(r => r.ice))];
  const iconOf = (r) => ({ pass: '✅', fail: '❌', na: '⚪' }[r?.status] || '?');

  const headerCols = ['engine \\ sink·ice'];
  for (const sink of sinks) {
    for (const ice of ices) headerCols.push(`${sink}·${ice}`);
  }
  const rows = [headerCols, headerCols.map(() => '---')];
  for (const engine of engines) {
    const row = [engine];
    for (const sink of sinks) {
      for (const ice of ices) {
        const r = results.find((x) => x.engine === engine && x.sink === sink && x.ice === ice);
        row.push(iconOf(r));
      }
    }
    rows.push(row);
  }
  return rows.map(cols => '| ' + cols.join(' | ') + ' |').join('\n');
}

// ----- Helpers ---------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq < 0) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

function parseList(value, dflt) {
  if (value === undefined || value === true) return dflt;
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

function parseSize(value, dflt) {
  if (value === undefined || value === true) value = dflt;
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*([KMG]?)B?$/i);
  if (!m) throw new Error(`Invalid --size: ${value}`);
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult = unit === 'G' ? 1024**3 : unit === 'M' ? 1024**2 : unit === 'K' ? 1024 : 1;
  return Math.round(n * mult);
}

function formatBytes(n) {
  if (n >= 1024**3) return (n / 1024**3).toFixed(2) + ' GiB';
  if (n >= 1024**2) return (n / 1024**2).toFixed(1) + ' MiB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
  return n + ' B';
}

function stringifyError(err) {
  if (!err) return 'unknown error';
  return err.message || String(err);
}

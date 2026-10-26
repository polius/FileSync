// FileSync transfer-interruption investigation harness (Phase 2).
//
// Drives a real sender + receiver (two separate Chromium browsers) against a running
// FileSync deployment and injects a deterministic mid-transfer network interruption,
// then records what both sides actually do:
//
//   - every RTCPeerConnection's ICE/connection state transitions (wall-clock)
//   - every DataChannel's open/close/error events and every string (control) frame
//     that crosses the wire + binary frame counts, so "the sender never sent a
//     cancel frame" is provable from the wire, not from reading code
//   - the file-row UI state on both sides (progress %, spinner, error text)
//   - the room phase and any fatal error (window.__filesync.room)
//   - the receiver's browser-download lifecycle (started / failed / completed)
//
// Scenarios (--scenario=):
//   t1    baseline, no interruption (transfer completes, hash compared)
//   t1b   whole receiver browser SIGSTOP 2s mid-transfer (< 4s grace), then resume
//   t2    receiver's Chromium network-service process SIGSTOP 10s (page JS keeps
//         running), then SIGCONT -> does the transfer recover, or does the receiver
//         end up stranded with an open channel and no error?
//   t3    coturn (the TURN relay carrying the data path, ice=turn) stopped for 10s
//         with BOTH pages live, then restarted -> recovery or hang?
//   t4    coturn stopped for 45s and left down -> how long until the receiver shows
//         an error vs the sender's 4s watchdog?
//   t5    sender browser SIGKILLed mid-transfer -> receiver's detection latency
//   zip   "Download all" bundle (2 files): receiver's network service SIGSTOP 20s
//         while file 2 is mid-transfer -> transparent resume; final bundle zip is
//         unpacked and every member hash is compared against the source fixtures
//
// Usage:  node run.mjs --scenario=t2 [--sink=sw] [--ice=auto] [--size=419430400]
//                      [--observe=60000] [--base-url=http://localhost:8080]
// Requires: FileSync running (app + coturn), `npm install` done in e2e/, `unzip`
// on PATH for the zip scenario.

import { chromium } from 'playwright';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const REPORTS_DIR = path.join(__dirname, 'reports');

// ---------- args ----------
const argv = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z-]+)(?:=(.*))?$/i);
  if (m) argv[m[1]] = m[2] === undefined ? true : m[2];
}
const SCENARIO  = argv.scenario || 't1';
const BASE_URL  = (argv['base-url'] || 'http://localhost:8080').replace(/\/$/, '');
const SINK      = argv.sink || 'sw';
const ICE       = argv.ice || 'auto';
const SIZE      = Number(argv.size || 419430400);
const OBSERVE_MS = Number(argv.observe || 60000);
const COTURN    = argv.coturn || 'filesync-coturn';
// The SW sink delivers the browser download only at completion, so slow (throttled or
// relayed) runs need longer than the default.
const DOWNLOAD_TIMEOUT_MS = Math.max(300000, OBSERVE_MS + 180000);

// ---------- process-tree helpers (macOS ps) ----------
function procTable() {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8' });
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] });
  }
  return rows;
}
function treeOf(rootPid, table = procTable()) {
  const kids = new Map();
  for (const r of table) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r.pid);
  }
  const out = [];
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    out.push(pid);
    for (const c of kids.get(pid) || []) stack.push(c);
  }
  return out;
}
function networkServicePids(rootPid, table = procTable()) {
  const inTree = new Set(treeOf(rootPid, table));
  return table
    .filter((r) => inTree.has(r.pid) && r.args.includes('network.mojom.NetworkService'))
    .map((r) => r.pid);
}
function signalPids(pids, sig) {
  for (const p of pids) { try { process.kill(p, sig); } catch {} }
}

async function freezeReceiverNetworkService(browserRootPid, freezeMs) {
  const nsPids = networkServicePids(browserRootPid, procTable());
  if (!nsPids.length) throw new Error('receiver network-service process not found');
  mark('sigstop-receiver-network-service', { pids: nsPids, freezeMs });
  signalPids(nsPids, 'SIGSTOP');
  await timeout(freezeMs);
  signalPids(nsPids, 'SIGCONT');
  mark('sigcont-receiver-network-service');
}

// ---------- in-page instrumentation ----------
// Records every RTCPeerConnection + DataChannel event and every control frame with
// wall-clock timestamps. Test-only; injected via addInitScript before app JS loads.
const INIT_SCRIPT = `
(() => {
  const rec = { pcs: [], dcs: [], t0: Date.now() };
  window.__rec = rec;
  const OrigPC = window.RTCPeerConnection;
  if (!OrigPC) return;
  function PatchedPC(cfg) {
    const pc = new OrigPC(cfg);
    const entry = {
      id: rec.pcs.length,
      createdAt: Date.now(),
      relay: !!(cfg && cfg.iceTransportPolicy === 'relay'),
      ice: [{ t: Date.now(), s: pc.iceConnectionState }],
      conn: [{ t: Date.now(), s: pc.connectionState }],
    };
    rec.pcs.push(entry);
    pc.addEventListener('iceconnectionstatechange', () => {
      const s = pc.iceConnectionState;
      const last = entry.ice[entry.ice.length - 1];
      if (!last || last.s !== s) entry.ice.push({ t: Date.now(), s });
    });
    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState;
      const last = entry.conn[entry.conn.length - 1];
      if (!last || last.s !== s) entry.conn.push({ t: Date.now(), s });
    });
    const origCreate = pc.createDataChannel.bind(pc);
    pc.createDataChannel = (label, opts) => __wireDc(origCreate(label, opts), entry, 'local');
    pc.addEventListener('datachannel', (ev) => __wireDc(ev.channel, entry, 'remote'));
    return pc;
  }
  PatchedPC.prototype = OrigPC.prototype;
  window.RTCPeerConnection = PatchedPC;
  function __wireDc(dc, entry, side) {
    const e = {
      id: rec.dcs.length, pcId: entry.id, side, label: dc.label,
      events: [], strFrames: [], bin: { count: 0, bytes: 0, firstAt: null, lastAt: null },
    };
    rec.dcs.push(e);
    dc.addEventListener('open',  () => e.events.push({ t: Date.now(), s: 'open' }));
    dc.addEventListener('close', () => e.events.push({ t: Date.now(), s: 'close' }));
    dc.addEventListener('error', (ev) => e.events.push({ t: Date.now(), s: 'error',
      msg: ev.error && (ev.error.message || String(ev.error)) }));
    dc.addEventListener('message', (ev) => {
      const d = ev.data;
      if (typeof d === 'string') {
        let type = 'str';
        try { const m = JSON.parse(d); if (m && (m.t || m.type)) type = m.t || m.type; } catch {}
        if (type === 'header' || d.length < 400) e.strFrames.push({ t: Date.now(), type, raw: d.length < 120 ? d : undefined });
        else e.strFrames.push({ t: Date.now(), type });
      } else {
        e.bin.count += 1;
        e.bin.bytes += (d && (d.byteLength !== undefined ? d.byteLength : 0)) || 0;
        if (e.bin.firstAt === null) e.bin.firstAt = Date.now();
        e.bin.lastAt = Date.now();
      }
    });
    return dc;
  }
})();
`;

// ---------- page state sampling ----------
async function samplePage(page, label, t) {
  const s = { label, t, alive: true };
  try {
    s.ui = await Promise.race([
      page.evaluate(() => {
        const room = window.__filesync?.room;
        const f = room ? [...room.files.values()][0] : null;
        const row = document.querySelector('#files li.file');
        return {
          file: f ? { status: f.status, written: f.written, size: f.size, error: f.error, sha256: f.sha256 } : null,
          // Row buttons the person can actually use right now (e.g. resume, retry, download).
          actions: row ? [...row.querySelectorAll('button[data-act]')].filter((b) => !b.hidden).map((b) => b.dataset.act) : [],
          bundle: room?.bundle ? { state: room.bundle.state, index: room.bundle.index, count: room.bundle.count, error: room.bundle.error } : null,
          phase: room?.phase ?? null,
          fatal: room?.error ?? null,
          hostLink: room?.hostLink ?? null,
        };
      }),
      timeout(2000),
    ]).catch(() => ({ unreachable: true }));
    s.rec = await Promise.race([page.evaluate(() => window.__rec), timeout(2000)]).catch(() => null);
  } catch {
    s.alive = false;
  }
  return s;
}
const timeout = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fixture ----------
async function fixtureFor(size) {
  const p = path.join(FIXTURES_DIR, `fixture-${size}.bin`);
  const hp = p + '.sha256';
  if (!fs.existsSync(p)) throw new Error(`missing fixture ${p}`);
  let sha256 = null;
  if (fs.existsSync(hp)) sha256 = (await fsp.readFile(hp, 'utf8')).trim();
  return { path: p, size, sha256 };
}
async function ensureFixture(size) {
  const p = path.join(FIXTURES_DIR, `fixture-${size}.bin`);
  const hp = p + '.sha256';
  if (fs.existsSync(p) && fs.existsSync(hp)) return fixtureFor(size);
  await fsp.mkdir(FIXTURES_DIR, { recursive: true });
  const h = createHash('sha256');
  const fd = fs.openSync(p, 'w');
  let left = size;
  while (left > 0) {
    const n = Math.min(left, 1024 * 1024);
    const buf = randomBytes(n);
    fs.writeSync(fd, buf);
    h.update(buf);
    left -= n;
  }
  fs.closeSync(fd);
  await fsp.writeFile(hp, h.digest('hex') + '\n');
  return fixtureFor(size);
}
async function sha256File(p) {
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(p, { highWaterMark: 1024 * 1024 })) h.update(chunk);
  return h.digest('hex');
}

// Unpack the delivered bundle and compare every member against its source fixture.
async function verifyZipMembers(zipPath, fixtures) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fszip-'));
  try {
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', out], { stdio: 'pipe' });
    return await Promise.all(fixtures.map(async (fx) => {
      const name = path.basename(fx.path);
      const member = path.join(out, name);
      if (!fs.existsSync(member)) return { name, result: 'missing' };
      const got = await sha256File(member);
      return { name, size: (await fsp.stat(member)).size, result: got === fx.sha256 ? 'hash-match' : 'hash-mismatch' };
    }));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

// ---------- session helpers ----------
async function newInstrumentedBrowser() {
  // Playwright 1.63 exposes no browser.process(); discover the freshly spawned
  // chromium main process as a new direct child of this node process.
  const before = new Set(treeOf(process.pid));
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.addInitScript(INIT_SCRIPT);
  await timeout(500);
  const table = procTable();
  const mine = new Set(treeOf(process.pid, table));
  const fresh = table.filter((r) => mine.has(r.pid) && !before.has(r.pid) && r.ppid === process.pid);
  return { browser, ctx, rootPid: fresh.length ? fresh[0].pid : null };
}

async function pair({ senderB, receiverB, qs }) {
  const sender = await senderB.ctx.newPage();
  const receiver = await receiverB.ctx.newPage();
  for (const [page, label] of [[sender, 'S'], [receiver, 'R']]) {
    page.on('pageerror', (e) => console.log(`  [${label} pageerror] ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        report.consoles.push({ t: Date.now(), label, type: msg.type(), text: msg.text().slice(0, 300) });
        console.log(`  [${label} ${msg.type()}] ${msg.text().slice(0, 200)}`);
      }
    });
  }

  await sender.goto(`${BASE_URL}/?${qs}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sender.waitForSelector('#room', { state: 'visible', timeout: 30000 });
  const shareUrl = await sender.getAttribute('#share-link', 'data-link', { timeout: 30000 });
  if (!shareUrl) throw new Error('no share URL');

  const u = new URL(shareUrl);
  u.search = qs;   // the query goes before the #k= security key
  await receiver.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
  await receiver.waitForSelector('#room', { state: 'visible', timeout: 30000 });
  await sender.waitForSelector('#status-dot.ok', { timeout: 30000 });
  return { sender, receiver, shareUrl };
}

// Starts the download click; returns { downloadPromise } (resolves with the Playwright
// Download at delivery — SW staging delivers the browser download only at completion).
async function startTransfer({ sender, receiver, fixture }) {
  const downloadPromise = receiver.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS });
  await sender.setInputFiles('#file-input', fixture.path);
  const row = receiver.locator('#files li.file').first();
  await row.waitFor({ state: 'visible', timeout: 30000 });
  await row.locator('[data-act="download"]').click();
  return { downloadPromise };
}

async function waitForReceiverProgress(receiver, pct, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const txt = await Promise.race([
      receiver.evaluate(() => {
        const f = window.__filesync?.room ? [...window.__filesync.room.files.values()][0] : null;
        return f && f.size ? Math.floor((f.written / f.size) * 100) : 0;
      }),
      timeout(1500).then(() => null),
    ]);
    if (txt !== null && txt >= pct) return txt;
    await timeout(250);
  }
  throw new Error(`receiver never reached ${pct}%`);
}

async function waitForModalProgress(receiver, pct, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const txt = await Promise.race([
      receiver.evaluate(() => {
        const b = window.__filesync?.room?.bundle;
        if (!b || !b.total) return 0;
        const cur = b.current?.file?.written || 0;
        return Math.floor(((b.doneBytes + cur) / b.total) * 100);
      }),
      timeout(1500).then(() => null),
    ]);
    if (txt !== null && txt >= pct) return txt;
    await timeout(250);
  }
  throw new Error(`bundle progress never reached ${pct}%`);
}

// ---------- report helpers ----------
const pct = (f) => (f && f.size ? Math.floor((f.written / f.size) * 100) : 0);
const rowSummary = (ui) => (ui?.file ? `${ui.file.status} ${pct(ui.file)}%` : null);
const hasError = (ui) => !!(ui && (ui.file?.error || ui.fatal || ui.bundle?.error));
function summarizeDc(rec) {
  if (!rec) return null;
  return rec.dcs.map((d) => ({
    pcId: d.pcId, side: d.side, label: d.label,
    events: d.events,
    strFrames: d.strFrames,
    binCount: d.bin.count,
    binBytes: d.bin.bytes,
    firstBinAt: d.bin.firstAt,
    lastBinAt: d.bin.lastAt,
  }));
}

// ---------- scenarios ----------
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const report = { scenario: SCENARIO, baseUrl: BASE_URL, sink: SINK, ice: ICE, size: SIZE, events: [], samples: [], consoles: [] };
const mark = (msg, data = {}) => {
  const e = { t: Date.now(), msg, ...data };
  report.events.push(e);
  log(`## ${msg}`, Object.keys(data).length ? JSON.stringify(data) : '');
};

async function observe({ sender, receiver, ms, downloadPromise }) {
  // download.failure() resolves only when the download settles (null = success),
  // so kick it off once and use it as the completion signal instead of awaiting it
  // inside the sampling loop (which would stall sampling until transfer end).
  const dlSettled = downloadPromise
    ? downloadPromise.then((d) => d.failure()).then((err) => ({ err }))
    : null;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const t = Date.now();
    const [s, r] = await Promise.all([
      samplePage(sender, 'S', t),
      samplePage(receiver, 'R', t),
    ]);
    if (dlSettled) {
      const settled = await Promise.race([
        dlSettled.then((v) => v),
        timeout(50).then(() => null),
      ]);
      r.downloadSettled = settled !== null;
      if (settled) r.downloadError = settled.err;
    }
    report.samples.push({ t, s, r });
    log(`observe tick ${report.samples.length}`, JSON.stringify({
      sAlive: s.alive && !s.ui?.unreachable, rAlive: r.alive && !r.ui?.unreachable,
      r: rowSummary(r.ui), host: r.ui?.hostLink, phase: r.ui?.phase, bundle: r.ui?.bundle?.state,
    }));
    await timeout(1000);
  }
  return { dlSettled };
}

async function main() {
  await fsp.mkdir(REPORTS_DIR, { recursive: true });
  const fixture = await fixtureFor(SIZE);
  report.fixture = fixture;
  if (!fixture.sha256) fixture.sha256 = await sha256File(fixture.path);
  const qs = `sink=${SINK}&ice=${ICE}`;
  const zipMode = SCENARIO === 'zip';
  let zipFixtures = null;

  const senderB = await newInstrumentedBrowser();
  const receiverB = await newInstrumentedBrowser();
  mark('browsers-launched', { senderPid: senderB.rootPid, receiverPid: receiverB.rootPid });

  try {
    const { sender, receiver } = await pair({ senderB, receiverB, qs });
    mark('paired');

    let downloadPromise = null;
    if (zipMode) {
      // Bundle: one small file (finishes fast) + the big one — the interruption must
      // land mid-entry of file 2 so the resume has to continue client-zip mid-stream.
      const small = await ensureFixture(Math.min(8 * 1024 * 1024, Math.max(1024 * 1024, Math.floor(SIZE / 4))));
      zipFixtures = [small, fixture];
      report.fixtures = zipFixtures;
      for (const f of zipFixtures) {
        if (!f.sha256) f.sha256 = await sha256File(f.path);
      }
      downloadPromise = receiver.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS });
      await sender.setInputFiles('#file-input', zipFixtures.map((f) => f.path));
      await receiver.waitForSelector('#download-all-btn', { state: 'visible', timeout: 30000 });
      await receiver.click('#download-all-btn');
      await receiver.waitForSelector('#bundle', { state: 'visible', timeout: 30000 });
      mark('download-all-started', { files: zipFixtures.map((f) => f.size) });
      const threshold = Math.ceil((small.size / (small.size + fixture.size)) * 100) + 5;
      const pct = await waitForModalProgress(receiver, threshold);
      mark('interrupt-point', { modalProgress: pct });
    } else {
      const { downloadPromise: dp } = await startTransfer({ sender, receiver, fixture });
      downloadPromise = dp;
      mark('download-started');

      // Mid-transfer trigger point.
      const pct = await waitForReceiverProgress(receiver, 15);
      mark('interrupt-point', { receiverProgress: pct });
    }

    switch (SCENARIO) {
      case 't1': {
        mark('no-interruption-baseline');
        break;
      }
      case 't1b': {
        const rpid = receiverB.rootPid;
        mark('sigstop-receiver-tree-2s', { pid: rpid });
        signalPids(treeOf(rpid), 'SIGSTOP');
        await timeout(2000);
        signalPids(treeOf(rpid), 'SIGCONT');
        mark('sigcont-receiver-tree');
        break;
      }
      case 't2': {
        await freezeReceiverNetworkService(receiverB.rootPid, Number(argv['freeze-ms'] || 10000));
        break;
      }
      case 'zip': {
        await freezeReceiverNetworkService(receiverB.rootPid, Number(argv['freeze-ms'] || 20000));
        break;
      }
      case 't3':
      case 't4': {
        const downMs = SCENARIO === 't3' ? 10000 : 45000;
        mark('coturn-stop', { container: COTURN, downMs });
        execFileSync('docker', ['stop', COTURN]);
        mark('coturn-stopped');
        await timeout(downMs);
        if (SCENARIO === 't3') {
          execFileSync('docker', ['start', COTURN]);
          mark('coturn-restarted');
        } else {
          mark('coturn-left-down');
        }
        break;
      }
      case 't5': {
        const spid = senderB.rootPid;
        mark('sigkill-sender-tree', { pid: spid });
        signalPids(treeOf(spid), 'SIGKILL');
        break;
      }
      default:
        throw new Error(`unknown scenario ${SCENARIO}`);
    }

    // Observe both sides after the interruption window.
    const { dlSettled } = await observe({ sender, receiver, ms: OBSERVE_MS, downloadPromise });
    mark('observe-done');

    // Final state extraction.
    const finalR = await samplePage(receiver, 'R', Date.now());
    report.finalReceiver = finalR;
    // failure() only resolves once the download settles — never true in a hang
    // scenario, so bound it.
    const settledOut = await Promise.race([dlSettled, timeout(3000).then(() => null)]);
    report.downloadFailure = settledOut ? settledOut.err : 'did-not-settle-during-test';

    // If the download completed, verify the bytes.
    let dlCheck = null;
    try {
      const download = await Promise.race([downloadPromise, timeout(180000).then(() => null)]);
      if (!download) throw new Error('download never delivered');
      const dlPath = await Promise.race([
        download.path(),
        timeout(5000).then(() => null),
      ]);
      if (dlPath && fs.existsSync(dlPath)) {
        if (zipMode) {
          dlCheck = { kind: 'zip', members: await verifyZipMembers(dlPath, zipFixtures) };
        } else {
          const sz = (await fsp.stat(dlPath)).size;
          dlCheck = { size: sz, complete: sz === fixture.size };
          if (sz === fixture.size) {
            const got = await sha256File(dlPath);
            dlCheck.hashMatch = got === fixture.sha256;
            dlCheck.sha256 = got;
          }
        }
      }
    } catch { /* download never completed */ }
    report.downloadCheck = dlCheck;
    mark('download-check', dlCheck || { completed: false });
  } finally {
    report.senderRec = summarizeDc(await safeEval(senderB, 'window.__rec'));
    report.receiverRec = summarizeDc(await safeEval(receiverB, 'window.__rec'));
    report.senderPcStates = await pcStates(senderB);
    report.receiverPcStates = await pcStates(receiverB);
    for (const b of [senderB, receiverB]) {
      try { await b.browser.close(); } catch {}
    }
  }

  const out = path.join(REPORTS_DIR, `${SCENARIO}-${SINK}-${ICE}-${Date.now()}.json`);
  await fsp.writeFile(out, JSON.stringify(report, null, 2));
  log('report written:', out);
  printVerdict();
}

async function safeEval(b, expr) {
  try {
    const page = b.ctx.pages()[0];
    if (!page || page.isClosed()) return null;
    return await Promise.race([page.evaluate(expr), timeout(3000)]);
  } catch { return null; }
}
async function pcStates(b) {
  try {
    const page = b.ctx.pages()[0];
    if (!page || page.isClosed()) return null;
    return await Promise.race([
      page.evaluate(() => (window.__rec ? window.__rec.pcs.map((p) => ({ id: p.id, relay: p.relay, ice: p.ice, conn: p.conn })) : null)),
      timeout(3000),
    ]);
  } catch { return null; }
}

function printVerdict() {
  const R = report;
  const lastSampleR = [...R.samples].reverse().find((x) => x.r?.ui && !x.r.ui.unreachable);
  const firstReceiverError = R.samples.find((x) => hasError(x.r?.ui));
  const statuses = [];
  for (const x of R.samples) {
    const st = x.r?.ui?.file?.status;
    if (st && statuses[statuses.length - 1] !== st) statuses.push(st);
  }
  const recDcs = R.receiverRec || [];
  // One data channel per transfer attempt (a resume opens a new one), so report them all.
  const dataDcs = recDcs.filter((d) => d.binCount > 0);
  const at = (t) => `+${((t - T0) / 1000).toFixed(1)}s`;
  console.log('\n================ VERDICT SUMMARY ================');
  console.log(`scenario:            ${SCENARIO} (sink=${SINK} ice=${ICE})`);
  if (dataDcs.length) {
    const sum = (k) => dataDcs.reduce((s, d) => s + d[k], 0);
    console.log(`receiver data dcs:   ${dataDcs.length} channels, bins=${sum('binCount')} bytes=${sum('binBytes')}`);
    console.log(`last byte at:        ${at(Math.max(...dataDcs.map((d) => d.lastBinAt)))}`);
    for (const d of dataDcs) {
      const close = d.events.find((e) => e.s === 'close');
      console.log(`  ${d.label.padEnd(18)} bytes=${d.binBytes} frames=${d.strFrames.map((f) => f.type).join(',') || 'none'} close=${close ? at(close.t) : 'NEVER'}`);
    }
  } else {
    console.log(`receiver data dc:    none seen (rec=${R.receiverRec ? 'present' : 'unavailable'})`);
  }
  console.log(`receiver error UI:   ${firstReceiverError ? `at +${((firstReceiverError.t - T0) / 1000).toFixed(1)}s` : 'NEVER during observation'}`);
  console.log(`receiver statuses:   ${statuses.join(' -> ') || 'none sampled'}`);
  if (lastSampleR) {
    const ui = lastSampleR.r.ui;
    console.log(`receiver final row:  ${rowSummary(ui)} error=${JSON.stringify(ui.file?.error ?? null)} actions=[${ui.actions.join(',')}]`);
    if (ui.bundle) console.log(`receiver bundle:     ${ui.bundle.state} ${ui.bundle.index}/${ui.bundle.count} error=${JSON.stringify(ui.bundle.error)}`);
    console.log(`receiver room:       phase=${ui.phase} hostLink=${ui.hostLink} fatal=${JSON.stringify(ui.fatal)}`);
  }
  console.log(`download outcome:    failure=${JSON.stringify(R.downloadFailure)} check=${JSON.stringify(R.downloadCheck)}`);
  if (R.downloadCheck && R.downloadCheck.members) {
    console.log(`zip members:         ${R.downloadCheck.members.map((m) => `${m.name}=${m.result}`).join('  ')}`);
  }
  // Invariant: a paused or failed single-file row must offer a way to continue.
  const stuck = [...R.samples].reverse().find((x) => !x.r?.ui?.bundle && ['paused', 'failed'].includes(x.r?.ui?.file?.status));
  if (stuck) {
    const ui = stuck.r.ui;
    const ok = ui.actions.includes(ui.file.status === 'paused' ? 'resume' : 'retry');
    console.log(`resume affordance:   ${ok ? 'OK' : 'FAIL'} (${ui.file.status}, actions=[${ui.actions.join(',')}])`);
  }
  console.log('================================================\n');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(2); });

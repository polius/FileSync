import { addDevBadge } from './devBadge.js';

// Sink: where received bytes go.
//
// Three implementations:
//   - 'fs'   File System Access API (Chromium): direct streaming write to a file the user picks.
//   - 'sw'   Staged download: bytes are written to a private file (OPFS), which the browser
//            then saves as a normal download. Named after the Service Worker that used to
//            stream that file out; the name stays because overrides and reports use it.
//   - 'blob' In-memory Blob (legacy fallback). The browser holds the whole file in memory.
//
// All sinks expose the same interface:
//   const sink = await openSink({ id, name, mime })
//   await sink.write(uint8Array)            // resolves once the bytes are stored
//   await sink.close()                      // success
//   await sink.abort(reason?)               // cleanup on failure / user abort
//
// `openSink` may throw or return null if the chosen mode is unsupported.

const SINK_MODES = ['auto', 'fs', 'sw', 'blob'];

function readOverride() {
  let mode = null;
  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('sink');
    if (fromQuery && SINK_MODES.includes(fromQuery)) {
      mode = fromQuery;
      if (mode === 'auto') window.sessionStorage.removeItem('filesync.sink');
      else window.sessionStorage.setItem('filesync.sink', mode);
    }
    if (!mode) {
      const stored = window.sessionStorage.getItem('filesync.sink');
      if (stored && SINK_MODES.includes(stored) && stored !== 'auto') mode = stored;
    }
  } catch {}
  return mode; // null means "auto"
}

// Per-sink availability — populated at module load and refreshed when the SW activates.
// Each entry: { available: bool, reason: string }
// `reason` is human-readable ("Requires HTTPS or localhost", "Not supported by this
// browser", "Available") so the diagnostic page can render it verbatim.
function detectSinkAvailability() {
  const secure = typeof window !== 'undefined' && window.isSecureContext === true;
  const out = {
    fs:   { available: false, reason: '' },
    sw:   { available: false, reason: '' },
    blob: { available: true,  reason: 'Available (always — fallback path).' },
  };

  if (typeof window === 'undefined') {
    out.fs.reason = 'Not in a browser context.';
    out.sw.reason = 'Not in a browser context.';
    return out;
  }

  if (typeof window.showSaveFilePicker !== 'function') {
    out.fs.reason = 'Not supported by this browser (Chromium-only API).';
  } else if (!secure) {
    out.fs.reason = 'Requires HTTPS or localhost (secure context).';
  } else {
    out.fs.available = true;
    out.fs.reason = 'Available.';
  }

  if (!('serviceWorker' in navigator)) {
    out.sw.reason = 'Not supported by this browser.';
  } else if (!secure) {
    out.sw.reason = 'Requires HTTPS or localhost (secure context).';
  } else {
    // Pre-SW-registration: API exists and context is OK, but the worker may not be
    // active yet. We mark available=true and let serviceWorkerReady refine this.
    out.sw.available = true;
    out.sw.reason = 'Available (Service Worker registering…).';
  }
  return out;
}

function detectAuto(avail) {
  // Selection priority: FS > SW > Blob. Same order as defined in the public docs.
  if (avail.fs.available)  return 'fs';
  if (avail.sw.available)  return 'sw';
  return 'blob';
}

const _initialAvailability = detectSinkAvailability();

export const sinkState = {
  forced: readOverride(),                 // null | 'fs' | 'sw' | 'blob'
  availability: _initialAvailability,     // per-sink { available, reason }
  auto: detectAuto(_initialAvailability), // what auto would pick right now
  serviceWorkerReady: false,              // set true once SW registration resolves
  serviceWorkerRegistration: null,
};

export function activeMode() {
  return sinkState.forced || sinkState.auto;
}

export function resolveSinkMode() {
  const mode = activeMode();
  // Hard guards: if forced to something unsupported, surface a clear error.
  if (mode === 'fs' && typeof window.showSaveFilePicker !== 'function') {
    throw new Error('File System Access API is not available in this browser.');
  }
  if (mode === 'sw') {
    if (!window.isSecureContext) throw new Error('Service Worker sink requires HTTPS (or localhost).');
    if (!('serviceWorker' in navigator)) throw new Error('Service Workers are not available in this browser.');
    if (!sinkState.serviceWorkerReady) throw new Error('Service Worker has not finished registering yet.');
  }
  return mode;
}

// Cap how long we'll wait for a not-yet-active worker to transition to 'activated'.
// Without this cap, a worker that gets stuck (or transitions to 'redundant' after a
// 5xx on the script fetch) hangs onLoad() forever and the user sees a blank page.
const _SW_ACTIVATION_TIMEOUT_MS = 10_000;

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) return; // SW only works in secure contexts
  try {
    // updateViaCache:'none' — SW update checks must never be served from the
    // HTTP cache, or a deployed worker fix can stay invisible for hours.
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    sinkState.serviceWorkerRegistration = reg;
    if (reg.active) {
      sinkState.serviceWorkerReady = true;
    } else {
      const activated = await new Promise((resolve) => {
        const worker = reg.installing || reg.waiting;
        if (!worker) { resolve(false); return; }
        let done = false;
        const finish = (ok) => { if (done) return; done = true; resolve(ok); };
        worker.addEventListener('statechange', () => {
          // 'activated' is the only success state. 'redundant' means the worker was
          // discarded (install failed, or a newer registration superseded it). Either
          // of those resolves us — without 'redundant' we'd hang on a failed install.
          if (worker.state === 'activated') finish(true);
          else if (worker.state === 'redundant') finish(false);
        });
        // Hard timeout so a worker stuck in 'installing' doesn't block app boot.
        setTimeout(() => finish(false), _SW_ACTIVATION_TIMEOUT_MS);
      });
      sinkState.serviceWorkerReady = activated;
    }
    if (sinkState.serviceWorkerReady) {
      // SW just became active — refine its availability reason and re-resolve auto.
      if (sinkState.availability.sw.available) {
        sinkState.availability.sw.reason = 'Available (Service Worker active).';
      }
      // Best-effort cleanup of staging files left by an abandoned paused download.
      sweepStaleStaging();
    } else {
      // Registration succeeded but the worker never reached 'activated'. Don't lie about
      // sw availability — the next openSink call would throw otherwise.
      sinkState.availability.sw.available = false;
      sinkState.availability.sw.reason = 'Service Worker registered but did not activate within '
        + (_SW_ACTIVATION_TIMEOUT_MS / 1000) + 's (stuck or marked redundant).';
    }
    sinkState.auto = detectAuto(sinkState.availability);
  } catch (err) {
    console.warn('Service Worker registration failed:', err);
    sinkState.availability.sw.available = false;
    sinkState.availability.sw.reason = 'Registration failed: ' + (err && err.message || err);
    sinkState.auto = detectAuto(sinkState.availability);
  }
}

// ---- FS Access sink -----------------------------------------------------------------

async function openFsSink({ name, mime }) {
  const handle = await window.showSaveFilePicker({
    suggestedName: name,
    types: mime
      ? [{ description: 'File', accept: { [mime]: [extensionFromName(name)] } }]
      : undefined,
  });
  const writable = await handle.createWritable();
  return {
    mode: 'fs',
    async write(chunk) { await writable.write(chunk); },
    async close() { await writable.close(); },
    async abort(reason) {
      try { await writable.abort(reason); } catch {}
    },
  };
}

function extensionFromName(name) {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx) : '';
}

// ---- Staged sink ('sw') ---------------------------------------------------------------
//
// Bytes are staged into an OPFS file while the transfer runs; the browser download is
// created only at close(). A failed/interrupted transfer therefore never leaves a partial
// download behind, and the staged file doubles as the resume buffer across reconnections.
//
// The staged file is then copied by the browser into the download: ~2x free space,
// OPFS-quota subject.

// Abandoned staging files (transfer interrupted, then the tab closed) are swept on boot.
const _STAGING_PREFIX = 'filesync-part-';
const _STAGING_MAX_AGE_MS = 60 * 60 * 1000;

export async function sweepStaleStaging() {
  if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return;
  try {
    const root = await navigator.storage.getDirectory();
    const now = Date.now();
    const candidates = [];
    for await (const [name, handle] of root.entries()) {
      if (typeof name === 'string' && name.startsWith(_STAGING_PREFIX)) candidates.push([name, handle]);
    }
    for (const [name, handle] of candidates) {
      try {
        const file = await handle.getFile();
        if (now - file.lastModified > _STAGING_MAX_AGE_MS) await root.removeEntry(name);
      } catch {}
    }
  } catch {}
}

// Nothing tells the page when the browser has finished copying a download, so a staged file
// outlives its hand-over: ten minutes, plus the time a slow disk (8 MiB/s) would need to copy
// it. Starting another staged download reclaims the ones handed over a while ago, so files
// received one after another don't add up in the origin's storage.
const _stagingKeepMs = (bytes) => 10 * 60_000 + (bytes / (8 * 1024 * 1024)) * 1000;
const _DELIVERED_GRACE_MS = 30_000;
const _delivered = new Map();   // staging name -> { at, drop }

function keepDelivered(root, stagingName, url, bytes) {
  const entry = { at: Date.now() };
  const timer = setTimeout(() => entry.drop(), _stagingKeepMs(bytes));
  entry.drop = () => {
    clearTimeout(timer);
    _delivered.delete(stagingName);
    URL.revokeObjectURL(url);
    root.removeEntry(stagingName).catch(() => {});   // if it can't go now, the boot sweep takes it
  };
  _delivered.set(stagingName, entry);
}

function reclaimDelivered() {
  const now = Date.now();
  for (const entry of [..._delivered.values()]) {
    if (now - entry.at >= _DELIVERED_GRACE_MS) entry.drop();
  }
}

async function openSwSink({ id, name, mime }) {
  if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
    throw new Error('OPFS is not available in this browser.');
  }
  const root = await navigator.storage.getDirectory();
  reclaimDelivered();
  const stagingName = `${_STAGING_PREFIX}${id}`;
  // Leftover staging from an earlier session with this id is dead weight — drop it.
  try { await root.removeEntry(stagingName); } catch {}
  const handle = await root.getFileHandle(stagingName, { create: true });
  const writable = await handle.createWritable();

  // Hand the staged file to the browser as a download. The Blob behind the link is the file
  // on disk, so the browser copies it by itself and none of it passes through this page.
  // Pumping it through the Service Worker instead read the file a second time in script,
  // and Firefox holds such a response in memory: about 3 GiB for a 1 GiB file.
  const deliver = async () => {
    await writable.close();
    const file = await handle.getFile();
    // slice() only relabels the same bytes on disk with the file's type; nothing is read.
    const url = URL.createObjectURL(mime ? file.slice(0, file.size, mime) : file);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    keepDelivered(root, stagingName, url, file.size);
  };

  return {
    mode: 'sw',
    async write(chunk) { await writable.write(chunk); },
    async close() { await deliver(); },
    async abort() {
      try { await writable.close(); } catch {}
      try { await root.removeEntry(stagingName); } catch {}
    },
  };
}

// ---- Blob (legacy) sink -------------------------------------------------------------

// Received bytes are folded into Blobs as they arrive. A Blob's bytes belong to the browser,
// which can keep them outside the page (Chromium moves large ones to disk), so the page only
// ever holds the last few MiB. Building one Blob from every chunk at the end instead held
// the whole file twice.
const _BLOB_PART_BYTES = 8 * 1024 * 1024;

function openBlobSink({ name, mime }) {
  let parts = [];      // Blobs already folded
  let chunks = [];     // chunks not folded yet
  let pending = 0;
  const fold = () => {
    if (!chunks.length) return;
    parts.push(new Blob(chunks));
    chunks = [];
    pending = 0;
  };
  return {
    mode: 'blob',
    async write(chunk) {
      // Each received chunk is a fresh buffer that nothing else mutates, so no copy needed.
      chunks.push(chunk);
      pending += chunk.byteLength;
      if (pending >= _BLOB_PART_BYTES) fold();
    },
    async close() {
      fold();
      const blob = new Blob(parts, mime ? { type: mime } : undefined);
      parts = [];
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    async abort() {
      parts = [];
      chunks = [];
      pending = 0;
    },
  };
}

// ---- Selection --------------------------------------------------------------------

export async function openSink({ id, name, mime }) {
  const mode = resolveSinkMode();
  try {
    if (mode === 'fs') return await openFsSink({ name, mime });
    if (mode === 'sw') return await openSwSink({ id, name, mime });
    return openBlobSink({ name, mime });
  } catch (err) {
    // User-initiated cancel (e.g., dismissed the save picker) — propagate without
    // silently falling back to a different sink. The caller treats AbortError as
    // "user said no" and aborts the transfer cleanly.
    if (err && err.name === 'AbortError') throw err;
    // Forced mode — propagate the real error rather than masking it with a fallback.
    if (sinkState.forced) throw err;
    // Otherwise, try the next available option down the chain.
    if (mode === 'fs') {
      try {
        if (sinkState.serviceWorkerReady) return await openSwSink({ id, name, mime });
      } catch (swErr) {
        if (swErr && swErr.name === 'AbortError') throw swErr;
      }
      return openBlobSink({ name, mime });
    }
    if (mode === 'sw') return openBlobSink({ name, mime });
    throw err;
  }
}

// ---- Dev badge --------------------------------------------------------------------

export function installSinkBadge() {
  if (!sinkState.forced) return;
  addDevBadge({
    label: `sink: ${sinkState.forced} (forced)`,
    tooltip: 'Sink override active. Remove ?sink=… or run __filesync.resetSink() to clear.',
    onClear: resetSink,
  });
}

function resetSink() {
  try { window.sessionStorage.removeItem('filesync.sink'); } catch {}
  const url = new URL(window.location.href);
  url.searchParams.delete('sink');
  window.location.replace(url.toString());
}

// Expose dev helpers on the window for console access.
if (typeof window !== 'undefined') {
  window.__filesync = window.__filesync || {};
  window.__filesync.sinkState = sinkState;
  window.__filesync.activeSink = activeMode;
  window.__filesync.resetSink = resetSink;
}

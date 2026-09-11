import { addDevBadge } from './devBadge.js';

// Sink: where received bytes go.
//
// Three implementations:
//   - 'fs'   File System Access API (Chromium): direct streaming write to a file the user picks.
//   - 'sw'   Service Worker streaming download: bytes flow through a MessageChannel into the
//            response body of an intercepted /__download/{id} request.
//   - 'blob' In-memory Blob (legacy fallback). Holds the whole file in JS heap.
//
// All sinks expose the same interface:
//   const sink = await openSink({ id, name, size, mime })
//   await sink.write(uint8Array)            // backpressured
//   await sink.close()                      // success
//   await sink.abort(reason?)               // cleanup on failure / user abort
//
// `openSink` may throw or return null if the chosen mode is unsupported.

const LARGE_FILE_THRESHOLD = 500 * 1024 * 1024; // 500 MB

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
  LARGE_FILE_THRESHOLD,
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
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
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

// ---- SW streaming sink --------------------------------------------------------------

async function openSwSink({ id, name, size, mime }) {
  const reg = sinkState.serviceWorkerRegistration;
  const sw = reg && (reg.active || reg.waiting || reg.installing);
  if (!sw) throw new Error('Service Worker not available.');

  const channel = new MessageChannel();
  // Forward-reference holder so the port message handler below can route 'cancel' to
  // THIS sink's _onCancel rather than to a global "last sink" — required to keep
  // concurrent SW sinks (e.g. files.zip + a separate per-file download) routing their
  // own browser-cancel events independently.
  let sink = null;
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Service Worker did not respond.')), 5000);
    channel.port1.onmessage = (ev) => {
      if (ev.data?.type === 'ready') {
        clearTimeout(timeout);
        resolve();
      } else if (ev.data?.type === 'cancel') {
        // User cancelled the browser download — call this sink's onCancel hook (if any).
        if (sink && typeof sink._onCancel === 'function') sink._onCancel();
      }
    };
  });

  (reg.active || sw).postMessage(
    { type: 'register', id, name, size, mime, port: channel.port2 },
    [channel.port2],
  );

  await ready;

  // Trigger the download by navigating a hidden iframe to the intercepted URL.
  // Iframe is more reliable than window.open() (no popup blocker) and gives Safari
  // a navigation event the SW can intercept.
  const iframe = document.createElement('iframe');
  iframe.hidden = true;
  iframe.src = `/__download/${encodeURIComponent(id)}`;
  document.body.appendChild(iframe);

  // Keep the Service Worker alive during long, slow, or backpressured transfers.
  // Browsers terminate idle SWs aggressively; an active streaming Response keeps it
  // alive while bytes are flowing, but on slow disks or very large files bytes can
  // pause for tens of seconds. A no-op message on a known port resets the SW's idle
  // clock without doing any work; the SW's `message` handler ignores unknown types.
  const swTarget = reg.active || sw;
  const keepalive = setInterval(() => {
    try { swTarget.postMessage({ type: 'keepalive', id }); } catch {}
  }, 20_000);

  const port = channel.port1;
  sink = {
    mode: 'sw',
    // Callers (user.downloadFile / user.downloadAll) assign a callback here so that a
    // browser-side cancel (closing the download tray, deleting the in-progress entry)
    // aborts the WebRTC transfer instead of leaving the sender pumping bytes into a
    // dead stream.
    _onCancel: null,
    async write(chunk) {
      // MessageChannel auto-buffers; we still throttle via the caller's backpressure
      // on the WebRTC side, which keeps memory bounded.
      const buf = chunk.buffer
        ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
        : chunk;
      port.postMessage(buf, [buf]);
    },
    async close() {
      clearInterval(keepalive);
      port.postMessage({ type: 'end' });
      port.close();
      setTimeout(() => iframe.remove(), 1000);
    },
    async abort(reason) {
      clearInterval(keepalive);
      try { port.postMessage({ type: 'abort', reason: reason ? String(reason) : 'aborted' }); } catch {}
      try { port.close(); } catch {}
      setTimeout(() => iframe.remove(), 250);
    },
  };
  return sink;
}

// ---- Blob (legacy) sink -------------------------------------------------------------

function openBlobSink({ name, mime }) {
  const chunks = [];
  return {
    mode: 'blob',
    async write(chunk) {
      // Copy into a stable Uint8Array reference (the caller may reuse the buffer).
      chunks.push(new Uint8Array(chunk));
    },
    async close() {
      const blob = new Blob(chunks, mime ? { type: mime } : undefined);
      chunks.length = 0;
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
      chunks.length = 0;
    },
  };
}

// ---- Selection --------------------------------------------------------------------

export async function openSink({ id, name, size, mime }) {
  const mode = resolveSinkMode();
  try {
    if (mode === 'fs') return await openFsSink({ name, mime });
    if (mode === 'sw') return await openSwSink({ id, name, size, mime });
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
        if (sinkState.serviceWorkerReady) return await openSwSink({ id, name, size, mime });
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

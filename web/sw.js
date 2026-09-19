// FileSync streaming-download Service Worker.
//
// The page registers a transfer by posting `{ type: 'register', id, name, size, mime, port }`
// where `port` is one end of a MessageChannel. The page then navigates (or anchor-clicks)
// to `/__download/{id}`; this SW intercepts that fetch and returns a Response whose body
// is a ReadableStream fed by chunks pushed through the port.
//
// Port messages from the page:
//   ArrayBuffer | Uint8Array  -> enqueued as a chunk
//   { type: 'end' }           -> stream is closed cleanly
//   { type: 'abort' }         -> stream is errored (browser will show an incomplete download)
//
// The transfer entry deliberately stays in the map after 'end': in Firefox the
// navigation's fetch event can arrive AFTER the page finished streaming (fast
// drain of small staged files), so deleting on 'end' would 404 a download whose
// bytes are already fully buffered in the closed stream. The fetch handler
// guards re-serving with `served`; the GC reclaims old entries.

const transfers = new Map();
const KEEPALIVE_MS = 15_000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'register') return;

  const { id, name, size, mime, port } = msg;
  if (!id || !port) return;

  let controller;
  const stream = new ReadableStream({
    start(c) { controller = c; },
    cancel() {
      // User cancelled the download in the browser UI.
      try { port.postMessage({ type: 'cancel' }); } catch {}
      transfers.delete(id);
    },
  });

  port.onmessage = (ev) => {
    const data = ev.data;
    if (data instanceof ArrayBuffer) {
      controller.enqueue(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      controller.enqueue(data);
      return;
    }
    if (data && data.type === 'end') {
      try { controller.close(); } catch {}
      return;
    }
    if (data && data.type === 'abort') {
      try { controller.error(new Error(data.reason || 'aborted')); } catch {}
      transfers.delete(id);
    }
  };

  transfers.set(id, { name, size, mime: mime || 'application/octet-stream', stream, createdAt: Date.now() });

  // Tell the page we're ready to receive bytes.
  port.postMessage({ type: 'ready' });
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/^\/__download\/([A-Za-z0-9._-]+)$/);
  if (!match) return;

  const id = match[1];
  const entry = transfers.get(id);
  if (!entry || entry.served) {
    event.respondWith(new Response('Transfer not found or expired.', { status: 404 }));
    return;
  }
  entry.served = true;

  const headers = new Headers({
    'Content-Type': entry.mime,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (Number.isFinite(entry.size) && entry.size > 0) {
    headers.set('Content-Length', String(entry.size));
  }

  event.respondWith(new Response(entry.stream, { headers }));
});

// Garbage-collect transfers that were never fetched, or whose download has long finished.
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of transfers) {
    if (now - entry.createdAt > 5 * 60_000) transfers.delete(id);
  }
}, KEEPALIVE_MS);

// "Download all": helpers for streaming several downloads into one zip with client-zip.

// A sink-shaped writer for one zip entry. write() waits while client-zip's input queue is
// full, so bundle downloads get the same bounded-memory flow control as single files.
export class ZipEntrySink {
  #controller = null;
  #wake = null;
  stream;

  constructor() {
    this.stream = new ReadableStream({
      start: (c) => { this.#controller = c; },
      pull: () => { this.#notify(); },
      cancel: () => { this.cancelled = true; this.#notify(); },
    }, { highWaterMark: 8 * 1024 * 1024, size: (chunk) => chunk.byteLength });
  }

  async write(bytes) {
    if (this.cancelled) throw new Error('bundle-cancelled');
    // Each received chunk is a fresh buffer that nothing else mutates, so no copy needed.
    this.#controller.enqueue(bytes);
    while (this.#controller.desiredSize <= 0 && !this.cancelled) {
      await new Promise((resolve) => { this.#wake = resolve; });
    }
  }

  async close() {
    this.#controller.close();
  }

  async abort(reason = 'aborted') {
    try { this.#controller.error(new Error(reason)); } catch { /* already closed */ }
    this.#notify();
  }

  #notify() {
    const w = this.#wake;
    this.#wake = null;
    if (w) w();
  }
}

// Unique entry names: "a.txt", "a (2).txt"; folder paths are kept.
export function zipEntryNamer() {
  const used = new Set();
  return (file) => {
    const full = file.path ? `${file.path}/${file.name}` : file.name;
    if (!used.has(full.toLowerCase())) {
      used.add(full.toLowerCase());
      return full;
    }
    const dot = full.lastIndexOf('.');
    const slash = full.lastIndexOf('/');
    const hasExt = dot > slash + 1;
    const stem = hasExt ? full.slice(0, dot) : full;
    const ext = hasExt ? full.slice(dot) : '';
    for (let n = 2; ; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (!used.has(candidate.toLowerCase())) {
        used.add(candidate.toLowerCase());
        return candidate;
      }
    }
  };
}

export function bundleName(roomId, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return `filesync-${roomId}-${day}.zip`;
}

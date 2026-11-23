// Streaming SHA-256 off the main thread. Updates are queued to a module worker in order;
// digest() resolves once every queued chunk is hashed. Falls back to hashing inline where
// workers aren't available (unit tests, very old engines).
//
// The queue to the worker has no limit of its own, so a caller that can produce bytes faster
// than SHA-256 runs (a disk read, a fast link on a slow CPU) awaits pace() after update().

import { Sha256 } from './crypto.js';

let nextId = 1;

// How far the worker may fall behind: pace() holds the caller once about two of these are
// queued. Small next to everything else a transfer buffers, large enough that the worker
// never runs dry while the caller waits.
const PACE_BYTES = 4 * 1024 * 1024;

export class Hasher {
  #worker = null;
  #inline = null;
  #id = nextId++;
  #pending = new Map();
  #seq = 0;
  #unpaced = 0;
  #mark = null;
  bytes = 0;

  constructor() {
    if (typeof Worker === 'function' && typeof window !== 'undefined') {
      try {
        this.#worker = new Worker(new URL('./hash-worker.js', import.meta.url), { type: 'module' });
        this.#worker.onmessage = (ev) => {
          const { seq, hex, error } = ev.data || {};
          const p = this.#pending.get(seq);
          if (!p) return;
          this.#pending.delete(seq);
          if (error) p.reject(new Error(error)); else p.resolve(hex);
        };
        this.#worker.onerror = (ev) => {
          for (const p of this.#pending.values()) p.reject(new Error(ev.message || 'hash worker failed'));
          this.#pending.clear();
        };
      } catch {
        this.#worker = null;
      }
    }
    if (!this.#worker) this.#inline = new Sha256();
  }

  update(bytes) {
    this.bytes += bytes.byteLength;
    this.#unpaced += bytes.byteLength;
    if (this.#inline) this.#inline.update(bytes);
    else this.#worker?.postMessage({ op: 'update', id: this.#id, bytes });   // no-op once disposed
  }

  // Resolves at once while the worker keeps up, and otherwise once it has hashed everything
  // up to the previous checkpoint. The backlog then stays within about two checkpoints,
  // instead of growing for as long as the caller is the faster side.
  pace() {
    if (!this.#worker || this.#unpaced < PACE_BYTES) return undefined;
    this.#unpaced = 0;
    const previous = this.#mark;
    this.#mark = this.#ask('sync');
    this.#mark.catch(() => {});   // a worker failure is reported by digest()
    return previous;
  }

  digest() {
    if (this.#inline) {
      const hex = this.#inline.digestHex();
      return Promise.resolve(hex);
    }
    return this.#ask('digest').finally(() => this.dispose());
  }

  #ask(op) {
    const seq = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(seq, { resolve, reject, op });
      this.#worker.postMessage({ op, id: this.#id, seq });
    });
  }

  dispose() {
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }
    // Nothing more will be hashed: let anyone waiting in pace() go on.
    for (const [seq, p] of this.#pending) {
      if (p.op !== 'sync') continue;
      this.#pending.delete(seq);
      p.resolve();
    }
  }
}

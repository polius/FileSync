// Streaming SHA-256 off the main thread. Updates are queued to a module worker in order;
// digest() resolves once every queued chunk is hashed. Falls back to hashing inline where
// workers aren't available (unit tests, very old engines).

import { Sha256 } from './crypto.js';

let nextId = 1;

export class Hasher {
  #worker = null;
  #inline = null;
  #id = nextId++;
  #pending = new Map();
  #seq = 0;
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
    if (this.#inline) this.#inline.update(bytes);
    else this.#worker.postMessage({ op: 'update', id: this.#id, bytes });
  }

  digest() {
    if (this.#inline) {
      const hex = this.#inline.digestHex();
      return Promise.resolve(hex);
    }
    const seq = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(seq, { resolve, reject });
      this.#worker.postMessage({ op: 'digest', id: this.#id, seq });
    }).finally(() => this.dispose());
  }

  dispose() {
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }
  }
}

// Module worker behind Hasher: keeps SHA-256 work off the UI thread.
import { Sha256 } from './crypto.js';

const hash = new Sha256();

self.onmessage = (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.op === 'update') hash.update(msg.bytes);
    else if (msg.op === 'digest') self.postMessage({ seq: msg.seq, hex: hash.digestHex() });
  } catch (err) {
    self.postMessage({ seq: msg.seq, error: String(err && err.message || err) });
  }
};

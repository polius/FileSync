// Crypto helpers: a streaming SHA-256 (WebCrypto has no incremental digest), link-key
// MACs over DTLS fingerprints, and the room-password challenge/response.

import { fromBase64Url, toBase64Url, toHex } from './util.js';

// ---- Streaming SHA-256 -----------------------------------------------------------------
//
// Files are hashed chunk by chunk as they stream, on both sides, so a transfer can be
// verified end to end without ever holding the file in memory. A plain-JS SHA-256 runs
// at hundreds of MB/s on current hardware, faster than typical WebRTC throughput.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  #h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  #w = new Uint32Array(64);
  #buf = new Uint8Array(64);
  #bufLen = 0;
  #bytes = 0;
  #done = false;

  get bytesHashed() { return this.#bytes; }

  update(data) {
    if (this.#done) throw new Error('Sha256: update after digest');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.#bytes += bytes.length;
    this.#absorb(bytes);
    return this;
  }

  #absorb(bytes) {
    let pos = 0;
    if (this.#bufLen > 0) {
      const take = Math.min(64 - this.#bufLen, bytes.length);
      this.#buf.set(bytes.subarray(0, take), this.#bufLen);
      this.#bufLen += take;
      pos = take;
      if (this.#bufLen === 64) {
        this.#block(this.#buf, 0);
        this.#bufLen = 0;
      }
    }
    while (pos + 64 <= bytes.length) {
      this.#block(bytes, pos);
      pos += 64;
    }
    if (pos < bytes.length) {
      this.#buf.set(bytes.subarray(pos), 0);
      this.#bufLen = bytes.length - pos;
    }
  }

  digestHex() {
    if (this.#done) throw new Error('Sha256: digest called twice');
    this.#done = true;
    const bitLen = this.#bytes * 8;
    const pad = new Uint8Array(((this.#bufLen < 56 ? 56 : 120) - this.#bufLen) + 8);
    pad[0] = 0x80;
    const view = new DataView(pad.buffer);
    // 64-bit big-endian length; split because bit counts exceed 2^32 for files > 512 MB.
    view.setUint32(pad.length - 8, Math.floor(bitLen / 2 ** 32));
    view.setUint32(pad.length - 4, bitLen >>> 0);
    this.#absorb(pad);
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, this.#h[i]);
    return toHex(out);
  }

  #block(bytes, off) {
    // Hot path: locals only. Private-field access inside the round loop costs ~2x.
    const w = this.#w, h = this.#h, k = K;
    for (let i = 0; i < 16; i++) {
      const j = off + (i << 2);
      w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    let a = h[0] | 0, b = h[1] | 0, c = h[2] | 0, d = h[3] | 0, e = h[4] | 0, f = h[5] | 0, g = h[6] | 0, hh = h[7] | 0;
    for (let i = 0; i < 64; i++) {
      let wi;
      if (i < 16) {
        wi = w[i] | 0;
      } else {
        const x = w[(i - 15) & 63] | 0, y = w[(i - 2) & 63] | 0;
        wi = (w[i - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + w[i - 7] +
          (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0;
        w[i] = wi;
      }
      const t1 = (hh + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) +
        ((e & f) ^ (~e & g)) + k[i] + wi) | 0;
      const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) +
        ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
}

// ---- Constant-time comparison ----------------------------------------------------------

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- HMAC and PBKDF2 --------------------------------------------------------------------
//
// WebCrypto (crypto.subtle) exists only in secure contexts. Over plain HTTP on a LAN it is
// missing, so these fall back to the streaming SHA-256 above. Both paths give identical
// results (tested against Node's crypto).

const enc = new TextEncoder();
const subtle = globalThis.crypto?.subtle;

function sha256Bytes(...parts) {
  const h = new Sha256();
  for (const p of parts) h.update(p);
  return hexToBytes(h.digestHex());
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Precomputed inner/outer pads, so PBKDF2's many HMACs don't redo the key setup.
function hmacPads(key) {
  const k = key.length > 64 ? sha256Bytes(key) : key;
  const block = new Uint8Array(64);
  block.set(k);
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    ipad[i] = block[i] ^ 0x36;
    opad[i] = block[i] ^ 0x5c;
  }
  return { ipad, opad };
}

function hmacJs(pads, message) {
  return sha256Bytes(pads.opad, sha256Bytes(pads.ipad, message));
}

export async function hmacSha256(rawKey, message) {
  const msg = typeof message === 'string' ? enc.encode(message) : message;
  if (subtle) {
    const key = await subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await subtle.sign('HMAC', key, msg));
  }
  return hmacJs(hmacPads(rawKey), msg);
}

export async function pbkdf2Sha256(password, salt, iterations) {
  if (subtle) {
    const base = await subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
  }
  // One 32-byte block is all we derive: T1 = U1 ^ U2 ^ ... ^ Uc.
  const pads = hmacPads(password);
  const first = new Uint8Array(salt.length + 4);
  first.set(salt);
  first[salt.length + 3] = 1;
  let u = hmacJs(pads, first);
  const out = u.slice();
  for (let i = 1; i < iterations; i++) {
    u = hmacJs(pads, u);
    for (let j = 0; j < 32; j++) out[j] ^= u[j];
  }
  return out;
}

const hmac = hmacSha256;

// ---- Link verification (end-to-end) ----------------------------------------------------
//
// WebRTC encrypts with DTLS, but each side learns the other's DTLS fingerprint from SDP
// relayed by the signaling server, which could swap it. When the share link carries a key
// in its fragment (never sent to any server), each side MACs its own fingerprint with that
// key. A server that swaps SDP can't forge the MAC, so a verified link is end to end.

// All DTLS fingerprints in an SDP, normalized and sorted so both sides compute the same text.
export function sdpFingerprints(sdp) {
  const found = new Set();
  for (const line of String(sdp || '').split(/\r?\n/)) {
    const m = /^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/.exec(line.trim());
    if (m) found.add(`${m[1].toLowerCase()} ${m[2].toUpperCase()}`);
  }
  return [...found].sort().join(',');
}

function linkMacInput(kind, fromId, toId, linkId, fingerprints) {
  return ['filesync-link-v1', kind, fromId, toId, linkId, fingerprints].join('|');
}

export async function linkMac(keyB64, kind, fromId, toId, linkId, sdp) {
  const fp = sdpFingerprints(sdp);
  if (!fp) throw new Error('No DTLS fingerprint in SDP');
  return toBase64Url(await hmac(fromBase64Url(keyB64), linkMacInput(kind, fromId, toId, linkId, fp)));
}

export async function verifyLinkMac(keyB64, kind, fromId, toId, linkId, sdp, mac) {
  if (typeof mac !== 'string') return false;
  try {
    return safeEqual(await linkMac(keyB64, kind, fromId, toId, linkId, sdp), mac);
  } catch {
    return false;
  }
}

// ---- Room password ---------------------------------------------------------------------
//
// The host keeps only a PBKDF2-derived verifier, never the password. A guest proves
// knowledge by answering a fresh random challenge, so nothing replayable crosses the wire
// and every guess costs a full key derivation.

const PBKDF2_ITERATIONS = 210_000;

export async function derivePasswordKey(password, roomId) {
  const bits = await pbkdf2Sha256(enc.encode(password.normalize('NFKC')), enc.encode(`filesync-room-v1|${roomId}`), PBKDF2_ITERATIONS);
  return toBase64Url(bits);
}

export async function passwordProof(verifierB64, nonce, guestId) {
  return toBase64Url(await hmac(fromBase64Url(verifierB64), `filesync-auth-v1|${nonce}|${guestId}`));
}

export async function checkPasswordProof(verifierB64, nonce, guestId, proof) {
  if (typeof proof !== 'string') return false;
  return safeEqual(await passwordProof(verifierB64, nonce, guestId), proof);
}

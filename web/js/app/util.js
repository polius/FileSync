// Small shared helpers: ids, encoding, formatting, sanitizing, and a tiny event emitter.

// ---- Event emitter ---------------------------------------------------------------------

export class Emitter {
  #handlers = new Map();

  on(event, fn) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this.#handlers.get(event)?.delete(fn);
  }

  emit(event, ...args) {
    // Snapshot so a handler can unsubscribe itself while we iterate.
    for (const fn of [...(this.#handlers.get(event) || [])]) {
      try { fn(...args); }
      catch (err) { console.error(`Listener for '${event}' threw:`, err); }
    }
  }
}

// ---- Randomness and encoding -----------------------------------------------------------

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  let b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(bytes) {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// Uniform integer in [0, max) without modulo bias (rejection sampling).
export function randomInt(max) {
  const limit = Math.floor(256 / max) * max;
  for (;;) {
    const [b] = randomBytes(1);
    if (b < limit) return b % max;
  }
}

// crypto.randomUUID exists only in secure contexts; FileSync must also work over plain
// HTTP on a LAN, so build a v4 UUID from getRandomValues (available everywhere).
export function randomId() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Secret proving ownership of a peer id to the signaling server (never leaves the tab).
export const randomToken = () => toBase64Url(randomBytes(24));

// 128-bit link key carried in the URL fragment; browsers never send fragments to servers.
export const randomLinkKey = () => toBase64Url(randomBytes(16));

export const ROOM_ID_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
export const LINK_KEY_RE = /^[A-Za-z0-9_-]{22}$/;

// Room ids read well aloud and type easily: xxx-xxxx-xxx over a-z (~47 bits).
export function generateRoomId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 10; i++) s += alphabet[randomInt(alphabet.length)];
  return `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7)}`;
}

// ---- Display names ---------------------------------------------------------------------

const COLORS = ['Amber', 'Aqua', 'Azure', 'Beige', 'Blue', 'Bronze', 'Coral', 'Crimson', 'Cyan', 'Gold',
  'Green', 'Indigo', 'Ivory', 'Jade', 'Khaki', 'Lavender', 'Lemon', 'Lilac', 'Lime', 'Magenta', 'Maroon',
  'Mint', 'Navy', 'Olive', 'Orange', 'Orchid', 'Peach', 'Pink', 'Plum', 'Purple', 'Red', 'Rose', 'Ruby',
  'Saffron', 'Salmon', 'Sand', 'Sapphire', 'Scarlet', 'Silver', 'Sky', 'Teal', 'Tomato', 'Topaz',
  'Turquoise', 'Violet', 'Wheat', 'White', 'Yellow'];
const ANIMALS = ['Albatross', 'Alpaca', 'Badger', 'Bat', 'Bear', 'Beaver', 'Bison', 'Camel', 'Capybara',
  'Cat', 'Cheetah', 'Crane', 'Crow', 'Deer', 'Dolphin', 'Dove', 'Duck', 'Eagle', 'Elk', 'Falcon', 'Ferret',
  'Finch', 'Flamingo', 'Fox', 'Frog', 'Gazelle', 'Gecko', 'Giraffe', 'Goose', 'Hare', 'Hawk', 'Hedgehog',
  'Heron', 'Ibex', 'Jaguar', 'Koala', 'Lemur', 'Leopard', 'Lion', 'Llama', 'Lynx', 'Magpie', 'Manatee',
  'Meerkat', 'Mole', 'Moose', 'Narwhal', 'Newt', 'Octopus', 'Otter', 'Owl', 'Panda', 'Panther', 'Parrot',
  'Pelican', 'Penguin', 'Puffin', 'Quail', 'Rabbit', 'Raccoon', 'Raven', 'Robin', 'Salmon', 'Seal',
  'Shark', 'Sparrow', 'Squirrel', 'Stork', 'Swan', 'Tapir', 'Tiger', 'Toucan', 'Turtle', 'Walrus',
  'Whale', 'Wolf', 'Wombat', 'Wren', 'Yak', 'Zebra'];

export function generateName() {
  return `${COLORS[randomInt(COLORS.length)]} ${ANIMALS[randomInt(ANIMALS.length)]}`;
}

// ---- Sanitizing wire strings -----------------------------------------------------------

export const MAX_NAME_LEN = 60;
export const MAX_FILENAME_LEN = 255;
export const MAX_PATH_LEN = 1024;
export const MAX_PATH_DEPTH = 32;

// Collapse whitespace and drop control characters; names are display-only text.
export function cleanName(value, max = MAX_NAME_LEN) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// One path segment (a file or folder name). Separators and control characters go, and
// '.'/'..' can't survive, so a hostile sender can never steer a save location.
export function cleanSegment(value) {
  const s = (typeof value === 'string' ? value : '').replace(/[\u0000-\u001f\u007f/\\]/g, '').trim();
  const clipped = s.slice(0, MAX_FILENAME_LEN);
  return clipped === '' || clipped === '.' || clipped === '..' ? '' : clipped;
}

export function cleanFilename(value) {
  // Senders may send a path; keep only the last segment for a plain file name.
  const last = (typeof value === 'string' ? value : '').split(/[\\/]+/).pop();
  return cleanSegment(last) || 'file';
}

// Relative folder path ('Photos/2026/Trip'), or '' when the file isn't inside a folder.
export function cleanFolderPath(value) {
  if (typeof value !== 'string' || value === '') return '';
  const parts = value.split(/[\\/]+/).map(cleanSegment).filter(Boolean).slice(0, MAX_PATH_DEPTH);
  const path = parts.join('/');
  return path.length <= MAX_PATH_LEN ? path : '';
}

// ---- Formatting ------------------------------------------------------------------------

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

// Decimal units (1 KB = 1000 B), matching how operating systems show file sizes today.
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1000) return `${bytes} B`;
  const exp = Math.min(UNITS.length - 1, Math.floor(Math.log10(bytes) / 3));
  const value = bytes / 1000 ** exp;
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[exp]}`;
}

export function formatRate(bytesPerSecond) {
  return `${formatBytes(Math.max(0, Math.round(bytesPerSecond)))}/s`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.ceil(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Rolling throughput over the last few seconds, for speed and time-left estimates.
export class RateMeter {
  #samples = [];
  #windowMs;

  constructor(windowMs = 4000) {
    this.#windowMs = windowMs;
  }

  add(totalBytes, now = performance.now()) {
    this.#samples.push([now, totalBytes]);
    while (this.#samples.length > 2 && now - this.#samples[0][0] > this.#windowMs) this.#samples.shift();
  }

  reset() {
    this.#samples = [];
  }

  get rate() {
    if (this.#samples.length < 2) return 0;
    const [t0, b0] = this.#samples[0];
    const [t1, b1] = this.#samples[this.#samples.length - 1];
    return t1 > t0 ? ((b1 - b0) * 1000) / (t1 - t0) : 0;
  }
}

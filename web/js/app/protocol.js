// FileSync room protocol (version 2): message validation and who may send what.
//
// Every message is a JSON object {t: <type>, ...} on a link's control channel. Nothing
// from the wire is trusted: parse() returns a normalized copy or null, and the accepts*
// tables decide whether a sender in a given role may send that type at all. Keeping this
// pure (no DOM, no WebRTC) means the security rules are tested in isolation.

import { cleanName, cleanFilename, cleanFolderPath } from './util.js';

export const PROTO = 2;

export const LIMITS = {
  filesPerMessage: 1000,
  members: 256,
  textLength: 10_000,
  thumbLength: 32_768,
  mimeLength: 100,
};

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PROOF_RE = /^[A-Za-z0-9_-]{43}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const THUMB_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- Field parsers ---------------------------------------------------------------------

export function parseThumb(v) {
  return typeof v === 'string' && v.length <= LIMITS.thumbLength && THUMB_RE.test(v) ? v : null;
}

// File metadata as announced by its owner. `owner` is NOT taken from here: the receiver
// stamps it from the authenticated link, so nobody can announce files as someone else.
export function parseFileMeta(raw) {
  if (!isObject(raw) || !isId(raw.id) || !isCount(raw.size)) return null;
  const type = typeof raw.type === 'string' && raw.type.length <= LIMITS.mimeLength && MIME_RE.test(raw.type.toLowerCase())
    ? raw.type.toLowerCase() : '';
  return {
    id: raw.id,
    name: cleanFilename(raw.name),
    path: cleanFolderPath(raw.path),
    size: raw.size,
    type,
    thumb: parseThumb(raw.thumb),
  };
}

function parseFileList(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > LIMITS.filesPerMessage) return null;
  const out = [];
  for (const item of v) {
    const meta = parseFileMeta(item);
    if (meta) out.push(meta);
  }
  return out.length ? out : null;
}

function parseIdList(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > LIMITS.filesPerMessage) return null;
  const ids = v.filter(isId);
  return ids.length ? ids : null;
}

// Host-authored listings carry an owner per file (the host already enforced it).
function parseCatalog(v) {
  if (!Array.isArray(v) || v.length > LIMITS.filesPerMessage * 10) return null;
  const out = [];
  for (const item of v) {
    const meta = parseFileMeta(item);
    if (meta && isId(item.owner)) out.push({ ...meta, owner: item.owner });
  }
  return out;
}

function parseMembers(v) {
  if (!Array.isArray(v) || v.length > LIMITS.members) return null;
  const out = [];
  for (const m of v) {
    if (isObject(m) && isId(m.id)) out.push({ id: m.id, name: cleanName(m.name) || 'Someone', verified: m.verified === true });
  }
  return out;
}

function parseText(v) {
  if (typeof v !== 'string') return null;
  const body = v.replace(/\r\n/g, '\n').slice(0, LIMITS.textLength);
  return body.trim() ? body : null;
}

function parseTextItem(raw) {
  if (!isObject(raw) || !isId(raw.id) || !isId(raw.from)) return null;
  const body = parseText(raw.body);
  if (!body) return null;
  return { id: raw.id, from: raw.from, name: cleanName(raw.name) || 'Someone', body, at: Number.isFinite(raw.at) ? raw.at : Date.now() };
}

// ---- Message table ---------------------------------------------------------------------

const PARSERS = {
  // guest -> host
  hello: (m) => (Number.isInteger(m.proto) ? { proto: m.proto, name: cleanName(m.name) || 'Someone' } : null),
  'auth-proof': (m) => (typeof m.proof === 'string' && PROOF_RE.test(m.proof) ? { proof: m.proof } : null),
  rename: (m) => { const name = cleanName(m.name); return name ? { name } : null; },
  'file-add': (m) => { const files = parseFileList(m.files); return files ? { files } : null; },
  'file-remove': (m) => { const ids = parseIdList(m.ids); return ids ? { ids } : null; },
  'file-thumb': (m) => (isId(m.id) && parseThumb(m.thumb) ? { id: m.id, thumb: m.thumb } : null),
  text: (m) => {
    // From a guest: {id, body}. From the host: a full item with sender stamped.
    if (isId(m.from)) { const item = parseTextItem(m); return item ? { item } : null; }
    const body = parseText(m.body);
    return isId(m.id) && body ? { id: m.id, body } : null;
  },
  // Both ways: a guest asks the host to delete one of its own messages; the host then tells
  // everyone. The host checks the requester sent it, so nobody deletes someone else's.
  'text-delete': (m) => (isId(m.id) ? { id: m.id } : null),

  // host -> guest
  'auth-challenge': (m) => (typeof m.nonce === 'string' && NONCE_RE.test(m.nonce) ? { nonce: m.nonce, retry: m.retry === true } : null),
  'auth-fail': (m) => ({ retryAfter: Number.isFinite(m.retryAfter) ? Math.min(Math.max(0, m.retryAfter), 600) : 0 }),
  welcome: (m) => {
    if (!Number.isInteger(m.proto) || !isId(m.you)) return null;
    const members = parseMembers(m.members);
    const files = parseCatalog(m.files);
    if (!members || !files) return null;
    const texts = Array.isArray(m.texts) ? m.texts.slice(-100).map(parseTextItem).filter(Boolean) : [];
    return { proto: m.proto, you: m.you, members, files, texts, secured: m.secured === true };
  },
  members: (m) => { const members = parseMembers(m.members); return members ? { members } : null; },
  catalog: (m) => {
    // Host-relayed file additions/removals, each stamped with its owner.
    const add = m.add === undefined ? [] : parseCatalog(m.add);
    const remove = m.remove === undefined ? [] : (Array.isArray(m.remove) ? m.remove.filter(isId) : null);
    const thumbs = Array.isArray(m.thumbs) ? m.thumbs.filter((x) => isObject(x) && isId(x.id) && parseThumb(x.thumb)) : [];
    if (!add || !remove) return null;
    return { add, remove, thumbs: thumbs.map((x) => ({ id: x.id, thumb: x.thumb })) };
  },

  // any member <-> any member, about a single transfer
  get: (m) => (isId(m.xfer) && isId(m.file) && isCount(m.offset) ? { xfer: m.xfer, file: m.file, offset: m.offset } : null),
  queued: (m) => (isId(m.xfer) && isCount(m.position) ? { xfer: m.xfer, position: m.position } : null),
  cancel: (m) => (isId(m.xfer) ? { xfer: m.xfer, reason: typeof m.reason === 'string' ? m.reason.slice(0, 40) : 'cancelled' } : null),

  bye: () => ({}),
};

export function parse(raw) {
  if (!isObject(raw) || typeof raw.t !== 'string' || !Object.hasOwn(PARSERS, raw.t)) return null;
  const body = PARSERS[raw.t](raw);
  return body ? { t: raw.t, ...body } : null;
}

// ---- Who may send what -----------------------------------------------------------------

const TRANSFER = ['get', 'queued', 'cancel'];

// The host receiving from a guest. Before the guest is admitted (password checked), only
// the handshake is allowed.
export function hostAccepts(type, admitted) {
  if (!admitted) return type === 'hello' || type === 'auth-proof' || type === 'bye';
  return ['hello', 'rename', 'file-add', 'file-remove', 'file-thumb', 'text', 'text-delete', 'bye', ...TRANSFER].includes(type);
}

// A guest receiving from the host link: room state is authoritative only from here.
export function guestAcceptsFromHost(type) {
  return ['auth-challenge', 'auth-fail', 'welcome', 'members', 'catalog', 'text', 'text-delete', 'bye', ...TRANSFER].includes(type);
}

// A guest receiving from another guest: only transfer coordination, never room state.
export function guestAcceptsFromPeer(type) {
  return type === 'bye' || TRANSFER.includes(type);
}

export const isSha256 = (v) => typeof v === 'string' && SHA_RE.test(v);

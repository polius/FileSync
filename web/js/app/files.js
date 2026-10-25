// Getting files into FileSync: picker, folder picker, drag and drop (folders included),
// and paste. Each entry is {file, path}, where path is the folder inside the selection
// ('' for loose files), kept so bundles recreate the folder structure.

import { cleanFolderPath } from './util.js';

const MAX_ENTRIES = 10_000;

function dirOf(relativePath) {
  const i = relativePath.lastIndexOf('/');
  return i > 0 ? relativePath.slice(0, i) : '';
}

export function filesFromInput(input) {
  return [...(input.files || [])].slice(0, MAX_ENTRIES).map((file) => ({
    file,
    path: cleanFolderPath(dirOf(file.webkitRelativePath || '')),
  }));
}

// Clipboard images arrive as "image.png"; give them a name people can find later.
function pastedName(file, i) {
  if (!/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file;
  const ext = file.name.split('.').pop();
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
  return new File([file], `Pasted image ${stamp}${i ? ` ${i + 1}` : ''}.${ext}`, { type: file.type, lastModified: Date.now() });
}

export function filesFromPaste(clipboardData) {
  return [...(clipboardData?.files || [])].slice(0, MAX_ENTRIES).map((file, i) => ({ file: pastedName(file, i), path: '' }));
}

// Drag and drop: walk dropped folders with the entries API (all current browsers).
export async function filesFromDrop(dataTransfer) {
  const items = [...(dataTransfer?.items || [])].filter((it) => it.kind === 'file');
  const entries = items.map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dataTransfer?.files || [])].map((file) => ({ file, path: '' }));
  const out = [];
  for (const entry of entries) {
    await walk(entry, '', out);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out.slice(0, MAX_ENTRIES);
}

async function walk(entry, parent, out) {
  if (out.length >= MAX_ENTRIES) return;
  if (entry.isFile) {
    const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
    if (file) out.push({ file, path: cleanFolderPath(parent) });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  const here = parent ? `${parent}/${entry.name}` : entry.name;
  // readEntries returns results in batches; call until it returns none.
  for (;;) {
    const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (!batch.length) break;
    for (const child of batch) await walk(child, here, out);
  }
}

// ---- Thumbnails ------------------------------------------------------------------------

const THUMB_PX = 112;          // 2x of the 56 px tile
const THUMB_MAX_BYTES = 24_000;
const THUMB_MAX_SOURCE = 60 * 1024 * 1024;

export async function makeThumbnail(file) {
  if (!/^image\/(jpeg|png|gif|webp|avif|bmp)$/.test(file.type) || file.size > THUMB_MAX_SOURCE) return null;
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, THUMB_PX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    for (const q of [0.72, 0.5]) {
      const url = canvas.toDataURL('image/jpeg', q);
      if (url.length <= THUMB_MAX_BYTES) return url;
    }
    return null;
  } finally {
    bitmap.close?.();
  }
}

// Short label for the file-type tile when there's no thumbnail.
export function typeLabel(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || '');
  return m ? m[1].toUpperCase() : 'FILE';
}

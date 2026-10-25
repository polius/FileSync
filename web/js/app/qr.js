// QR code for the room link, drawn like v1: modules in the theme's text color on the box's
// own surface, which doubles as the quiet zone. The canvas is rendered at device resolution
// for whatever CSS size it has, so it stays sharp at any size.

import { encode } from '../vendors/uqr.js';

export function drawQr(canvas, text) {
  const qr = encode(text, { ecc: 'M', border: 0 });
  const n = qr.size;
  const cssSize = canvas.clientWidth || 185;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const size = Math.round(cssSize * dpr);
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = getComputedStyle(canvas).color;
  // Round each module's edges to whole pixels so neighbors meet without seams.
  const edge = (i) => Math.round((i * size) / n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.data[y][x]) ctx.fillRect(edge(x), edge(y), edge(x + 1) - edge(x), edge(y + 1) - edge(y));
    }
  }
}

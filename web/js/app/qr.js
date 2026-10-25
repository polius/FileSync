// QR code for the room link: always dark modules on white with the standard 4-module quiet
// zone, in both themes. Inverted (light-on-dark) codes fail in many scanner apps.

import { encode } from '../vendors/uqr.js';

export function drawQr(canvas, text) {
  const qr = encode(text, { ecc: 'M', border: 4 });
  const n = qr.size;
  const cssSize = canvas.clientWidth || 184;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const px = Math.max(1, Math.floor((cssSize * dpr) / n));
  canvas.width = canvas.height = px * n;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111111';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.data[y][x]) ctx.fillRect(x * px, y * px, px, px);
    }
  }
}

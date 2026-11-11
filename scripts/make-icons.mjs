// Generates icons/icon{16,32,48,128}.png with no dependencies (node scripts/make-icons.mjs).
// Design: indigo rounded square with a white "form" (three lines) and a green check badge.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'icons');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes in a 0..1 coordinate space, sampled 4x4 per pixel for anti-aliasing.
function inRoundRect(u, v, x0, y0, x1, y1, r) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
}

function distToSegment(u, v, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(u - (ax + t * dx), v - (ay + t * dy));
}

function shade(u, v) {
  const INDIGO = [79, 70, 229];
  const WHITE = [255, 255, 255];
  const GREEN = [34, 197, 94];
  if (!inRoundRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.2)) return null;
  // green badge with a white check, bottom-right
  const bx = 0.72;
  const by = 0.72;
  if (Math.hypot(u - bx, v - by) <= 0.22) {
    const d = Math.min(distToSegment(u, v, 0.62, 0.72, 0.69, 0.8), distToSegment(u, v, 0.69, 0.8, 0.83, 0.63));
    return d <= 0.035 ? WHITE : GREEN;
  }
  // white "form" lines
  const lines = [
    [0.2, 0.24, 0.8],
    [0.2, 0.42, 0.66],
    [0.2, 0.6, 0.44],
  ];
  for (const [x0, y, x1] of lines) if (inRoundRect(u, v, x0, y - 0.05, x1, y + 0.05, 0.05)) return WHITE;
  return INDIGO;
}

function pixel(x, y, size) {
  const S = 4;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let sy = 0; sy < S; sy++) {
    for (let sx = 0; sx < S; sx++) {
      const c = shade((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
      if (c) {
        r += c[0];
        g += c[1];
        b += c[2];
        a += 1;
      }
    }
  }
  if (!a) return [0, 0, 0, 0];
  return [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((255 * a) / (S * S))];
}

for (const size of [16, 32, 48, 128]) {
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, png(size, pixel));
  console.log('wrote', file);
}

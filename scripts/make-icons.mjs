// Renders the extension icon (a browser tab with a clock face) to PNGs. No dependencies.
// Usage: node scripts/make-icons.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const BG = [15, 118, 110]; // teal
const FG = [255, 255, 255];
const SIZES = [16, 32, 48, 128];
const SAMPLES = 4; // 4x4 supersampling for anti-aliasing

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = clamp(x, x0 + r, x1 - r);
  const cy = clamp(y, y0 + r, y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function nearSegment(x, y, ax, ay, bx, by, width) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= width / 2;
}

/** Color at a point in unit space, or null for transparent. */
function shade(x, y) {
  if (!inRoundedRect(x, y, 0, 0, 1, 1, 0.22)) return null;
  const inTabShape =
    inRoundedRect(x, y, 0.17, 0.22, 0.52, 0.42, 0.06) || inRoundedRect(x, y, 0.17, 0.33, 0.83, 0.8, 0.08);
  if (!inTabShape) return BG;
  const [cx, cy] = [0.5, 0.575];
  if ((x - cx) ** 2 + (y - cy) ** 2 > 0.16 ** 2) return FG;
  const hand = nearSegment(x, y, cx, cy, cx, cy - 0.1, 0.05) || nearSegment(x, y, cx, cy, cx + 0.08, cy, 0.05);
  return hand ? FG : BG;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const color = shade((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size);
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          hits++;
        }
      }
      const i = (py * size + px) * 4;
      if (hits) {
        rgba[i] = Math.round(r / hits);
        rgba[i + 1] = Math.round(g / hits);
        rgba[i + 2] = Math.round(b / hits);
        rgba[i + 3] = Math.round((255 * hits) / SAMPLES ** 2);
      }
    }
  }
  return rgba;
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);

  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = new URL('../icons/', import.meta.url);
mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  writeFileSync(new URL(`icon-${size}.png`, outDir), encodePng(size, render(size)));
  console.log(`icons/icon-${size}.png`);
}

#!/usr/bin/env node
/**
 * Render the team-drawing sprites (#683):
 *
 *   node scripts/map/build-draw-icons.mjs
 *
 * Signed distance fields (like the waypoint pins, scripts/map/build-waypoint-icons.mjs),
 * so ONE white image per shape is tinted per feature with `icon-color`
 * (the author's colour), scaled with `icon-size` and ringed with `icon-halo-*`:
 *
 * - `draw-head-fill` / `draw-head-open` — an arrowhead pointing UP (north),
 *   its tip at the top centre (`icon-anchor: top`), 30 dp long at the L size;
 * - `draw-pointer` — the compact 32 dp pointer an arrow becomes when its
 *   shaft would be shorter than 32 dp on screen, centred, pointing up;
 * - `draw-pill` — behind the author badge, the pen tip and a collapsed
 *   note's "…" (`icon-text-fit: both`).
 *
 * 2 px per dp. SDF encoding as MapLibre's symbol_sdf shader wants it: edge at
 * 0.75, alpha = clamp((6 - d) / 8), d the signed distance in px (+ outside).
 * Writes `assets/map/draw/*.png` and `src/features/team/draw/drawImages.ts`.
 * The numbers must match `src/features/team/draw/drawStyle.ts`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'assets', 'map', 'draw');
const TABLE_PATH = join(ROOT, 'src', 'features', 'team', 'draw', 'drawImages.ts');

const D = 2; // px per dp
const B = 6; // SDF buffer, px

// ---------------------------------------------------------------- PNG
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- fields
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
};
/** Signed distance to a closed polygon (+ outside). */
const polygon = (poly) => (px, py) => {
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [bx, by] = poly[i];
    best = Math.min(best, segDist(px, py, ax, ay, bx, by));
    if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside ? -best : best;
};
/** Distance to a polyline minus half its width. */
const stroke = (line, width) => (px, py) => {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const [bx, by] = line[i];
    best = Math.min(best, segDist(px, py, ax, ay, bx, by));
  }
  return best - width / 2;
};
const union =
  (...fs) =>
  (x, y) =>
    Math.min(...fs.map((f) => f(x, y)));

function render(w, h, field) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = Math.max(0, Math.min(1, (6 - field(x + 0.5, y + 0.5)) / 8));
      rgba[i * 4] = 255;
      rgba[i * 4 + 1] = 255;
      rgba[i * 4 + 2] = 255;
      rgba[i * 4 + 3] = Math.round(a * 255);
    }
  }
  return { w, h, rgba };
}

// ---------------------------------------------------------------- shapes
const HEAD_L = 30 * D; // tip to base
const HEAD_HW = 0.55 * HEAD_L;
function headFill() {
  const w = Math.ceil(2 * HEAD_HW + 2 * B);
  const h = Math.ceil(HEAD_L + 2 * B);
  const cx = w / 2;
  return render(
    w,
    h,
    polygon([
      [cx, B],
      [cx + HEAD_HW, B + HEAD_L],
      [cx - HEAD_HW, B + HEAD_L],
    ]),
  );
}
function headOpen() {
  const sw = 4 * D;
  const w = Math.ceil(2 * HEAD_HW + 2 * B + sw);
  const h = Math.ceil(HEAD_L + 2 * B + sw);
  const cx = w / 2;
  const top = B + sw / 2;
  return render(
    w,
    h,
    stroke(
      [
        [cx - HEAD_HW, top + HEAD_L],
        [cx, top],
        [cx + HEAD_HW, top + HEAD_L],
      ],
      sw,
    ),
  );
}
function pointer() {
  const L = 32 * D;
  const hw = 9 * D;
  const shaft = 5 * D;
  const w = Math.ceil(2 * hw + 2 * B);
  const h = Math.ceil(L + 2 * B);
  const cx = w / 2;
  const headBase = B + 13 * D;
  return render(
    w,
    h,
    union(
      polygon([
        [cx, B],
        [cx + hw, headBase],
        [cx - hw, headBase],
      ]),
      stroke(
        [
          [cx, headBase - 2],
          [cx, B + L - shaft / 2],
        ],
        shaft,
      ),
    ),
  );
}
function pill() {
  const pw = 44 * D;
  const ph = 24 * D;
  const w = pw + 2 * B;
  const h = ph + 2 * B;
  const r = ph / 2;
  return render(
    w,
    h,
    stroke(
      [
        [B + r, h / 2],
        [w - B - r, h / 2],
      ],
      ph,
    ),
  );
}
const IMAGES = {
  'draw-head-fill': headFill(),
  'draw-head-open': headOpen(),
  'draw-pointer': pointer(),
  'draw-pill': pill(),
};

mkdirSync(OUT_DIR, { recursive: true });
const lines = [];
for (const [name, img] of Object.entries(IMAGES)) {
  writeFileSync(join(OUT_DIR, `${name}.png`), png(img.w, img.h, img.rgba));
  lines.push(`  '${name}': require('../../../../assets/map/draw/${name}.png'),`);
  console.log(`${name}: ${img.w}×${img.h}`);
}
writeFileSync(
  TABLE_PATH,
  `// GENERATED by scripts/map/build-draw-icons.mjs — do not edit by hand.
import type { ImageRequireSource } from 'react-native';

/** Team-drawing sprites (#683): SDF, white, tinted per feature with \`icon-color\`. */
export const DRAW_IMAGES: Readonly<Record<string, ImageRequireSource>> = {
${lines.join('\n')}
};
`,
);

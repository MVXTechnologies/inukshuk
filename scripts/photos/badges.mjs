#!/usr/bin/env node
/**
 * Render the trail-photo map images (#587):
 *
 *   node scripts/photos/badges.mjs
 *
 * - `assets/photos/badges/count-<n>.png` for n = 2…99, and `count-100.png`
 *   reading "99+": the count badge on a photo stack. MapLibre's raster and
 *   satellite styles declare no glyphs, so a `text-field` count would vanish
 *   there; bundled images always draw. One neutral design for both themes
 *   (stone pill, paper ring, paper digits), like the circles themselves.
 * - `assets/photos/badges/selected-ring.png`: the sage disc drawn behind the
 *   selected photo (profile cursor, "Show on map"), so it shows as a ring.
 * - `src/features/photos/photoBadgeImages.ts`: the literal `require` table
 *   Metro needs (it cannot resolve computed paths).
 *
 * Everything is rendered at 3× (one file per image, no @2x/@3x set: the map
 * layer scales them with `icon-size`, see `@core/photos/mapStyle`).
 * Standard library only: the digits are stroked polylines (a small rounded
 * geometric numeral set drawn here), sampled 4×4 per pixel as signed
 * distances, and written as RGBA PNGs with node:zlib. Deterministic, so
 * `badges.test.mjs` checks the committed files are exactly what this makes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT_DIR = join(ROOT, 'assets', 'photos', 'badges');
export const TABLE_PATH = join(ROOT, 'src', 'features', 'photos', 'photoBadgeImages.ts');

/** Pixels per point: everything is drawn at 3×. */
export const SCALE = 3;
const SS = 4; // supersamples per axis

// Colours (the app's palette, @ui/tokens): stone pill, the sprites' paper
// ring, surface digits, sage-deep selection.
const STONE = [0x2d, 0x37, 0x40];
const RING = [0xf7, 0xf4, 0xee];
const DIGIT = [0xfb, 0xf8, 0xf2];
const SAGE = [0x56, 0x6b, 0x33];

// Badge geometry, points.
const BADGE_H = 20; // outer height, ring included
const RING_PT = 1.75;
const DIGIT_H = 9.6; // numeral height
const STROKE_PT = 1.9; // numeral stroke width
const ADVANCE = 0.8; // per glyph, in numeral heights (stroke and a clear gap included)
const PAD_PT = 4.6; // pill padding either side of the text

// ---------------------------------------------------------------- glyphs

const W = 0.56; // numeral width in em (height 1, y grows downwards)

/** Points along an elliptical arc; angles in degrees, 0 = +x, 90 = down. */
function arc(cx, cy, rx, ry, a0, a1, steps = 24) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

/** Points along a quadratic Bézier. */
function quad(p0, c, p1, steps = 16) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([
      u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
      u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1],
    ]);
  }
  return out;
}

const rot180 = (polys) => polys.map((p) => p.map(([x, y]) => [W - x, 1 - y]));

const SIX = [
  quad([W * 0.86, 0.02], [W * 0.06, 0.12], [0.005, 0.68]),
  arc(W / 2, 0.71, W / 2, 0.29, 0, 360, 40),
];

/** Each numeral: polylines in a W × 1 box. */
const GLYPHS = {
  0: [arc(W / 2, 0.5, W / 2, 0.5, 0, 360, 48)],
  1: [
    [
      [W * 0.12, 0.2],
      [W * 0.62, 0],
      [W * 0.62, 1],
    ],
  ],
  2: [
    [
      ...arc(W / 2, 0.27, W / 2, 0.27, 195, 360, 18),
      ...quad([W, 0.27], [W, 0.52], [0, 1], 14).slice(1),
      [W, 1],
    ],
  ],
  3: [arc(W / 2, 0.26, W * 0.46, 0.26, 200, 450, 24), arc(W / 2, 0.73, W / 2, 0.27, 270, 520, 26)],
  4: [
    [
      [W * 0.74, 1],
      [W * 0.74, 0],
      [0, 0.7],
      [W, 0.7],
    ],
  ],
  5: [
    [
      [W * 0.92, 0],
      [W * 0.14, 0],
      [W * 0.08, 0.46],
      ...quad([W * 0.08, 0.46], [W * 0.3, 0.38], [W * 0.55, 0.4], 6).slice(1),
      ...arc(W * 0.48, 0.69, W * 0.52, 0.31, 290, 495, 26).slice(1),
    ],
  ],
  6: SIX,
  7: [
    [
      [0, 0],
      [W, 0],
      [W * 0.3, 1],
    ],
  ],
  8: [arc(W / 2, 0.255, W * 0.42, 0.255, 0, 360, 40), arc(W / 2, 0.735, W / 2, 0.265, 0, 360, 40)],
  9: rot180(SIX),
  '+': [
    [
      [0.04, 0.55],
      [W - 0.04, 0.55],
    ],
    [
      [W / 2, 0.3],
      [W / 2, 0.8],
    ],
  ],
};

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Text as segments in pixel space, centred on (cx, cy). */
function layoutText(text, cx, cy, heightPx) {
  const adv = ADVANCE * heightPx;
  const total = adv * (text.length - 1) + W * heightPx;
  const x0 = cx - total / 2;
  const y0 = cy - heightPx / 2;
  const segs = [];
  [...text].forEach((ch, i) => {
    for (const poly of GLYPHS[ch]) {
      const pts = poly.map(([x, y]) => [x0 + i * adv + x * heightPx, y0 + y * heightPx]);
      for (let k = 1; k < pts.length; k++) segs.push([...pts[k - 1], ...pts[k]]);
    }
  });
  return segs;
}

// ---------------------------------------------------------------- shapes

/** Signed distance to a horizontal capsule (pill) centred at (cx, cy). */
function sdPill(x, y, cx, cy, halfLen, r) {
  const dx = Math.max(Math.abs(x - cx) - halfLen, 0);
  return Math.hypot(dx, y - cy) - r;
}

/**
 * Render one image: `layers` are drawn back to front, each a signed-distance
 * function (px) and a colour. Coverage is sampled SS×SS per pixel.
 */
function render(width, height, layers) {
  const rgba = new Uint8Array(width * height * 4);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0; // premultiplied accumulation
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          for (const { sd, color } of layers) {
            if (sd(x, y) > 0) continue;
            cr = color[0];
            cg = color[1];
            cb = color[2];
            ca = 1;
          }
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const i = (py * width + px) * 4;
      if (a > 0) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
        rgba[i + 3] = Math.round((255 * a) / (SS * SS));
      }
    }
  }
  return rgba;
}

/** The badge for a stack of `n` (100 and up read "99+"). */
export function badgeText(n) {
  return n >= 100 ? '99+' : String(n);
}

function badgeImage(text) {
  const h = Math.round(BADGE_H * SCALE);
  const r = h / 2;
  // Two numerals and more sit a touch smaller, so a stack of 38 stays a compact pill.
  const digitH = (text.length > 1 ? DIGIT_H * 0.92 : DIGIT_H) * SCALE;
  const textW = ADVANCE * digitH * (text.length - 1) + W * digitH + STROKE_PT * SCALE;
  // One numeral: a circle. More: a pill just wide enough.
  const halfLen = Math.max(0, (textW + 2 * PAD_PT * SCALE - h) / 2);
  const w = Math.ceil(2 * (halfLen + r));
  const cx = w / 2;
  const cy = h / 2;
  const segs = layoutText(text, cx, cy, digitH);
  const half = (STROKE_PT * SCALE) / 2;
  const rgba = render(w, h, [
    { sd: (x, y) => sdPill(x, y, cx, cy, halfLen, r - 0.25), color: RING },
    { sd: (x, y) => sdPill(x, y, cx, cy, halfLen, r - RING_PT * SCALE), color: STONE },
    {
      sd: (x, y) => {
        let d = Infinity;
        for (const s of segs) d = Math.min(d, segDist(x, y, s[0], s[1], s[2], s[3]));
        return d - half;
      },
      color: DIGIT,
    },
  ]);
  return { width: w, height: h, rgba };
}

/** Selected-photo disc: 54 pt sprite + a 3 pt sage ring each side. */
export const SELECTED_RING_PT = 60;

function selectedRingImage() {
  const size = SELECTED_RING_PT * SCALE;
  const c = size / 2;
  const rgba = render(size, size, [
    { sd: (x, y) => Math.hypot(x - c, y - c) - (c - 0.5), color: SAGE },
  ]);
  return { width: size, height: size, rgba };
}

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

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An 8-bit RGBA PNG (each row "Sub"-filtered, which suits flat shapes). */
export function encodePng({ width, height, rgba }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 1; // Sub
    for (let x = 0; x < width * 4; x++) {
      const v = rgba[y * width * 4 + x];
      const left = x >= 4 ? rgba[y * width * 4 + x - 4] : 0;
      raw[row + 1 + x] = (v - left) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- outputs

/** Smallest and largest stack the badges cover (100 = "99+"). */
export const MIN_COUNT = 2;
export const MAX_COUNT = 100;

/** Every file this script writes: name → bytes (PNGs) or text (the table). */
export function renderAll() {
  const files = new Map();
  for (let n = MIN_COUNT; n <= MAX_COUNT; n++) {
    files.set(`count-${n}.png`, encodePng(badgeImage(badgeText(n))));
  }
  files.set('selected-ring.png', encodePng(selectedRingImage()));
  return files;
}

/** The generated `require` table (formatted as Prettier would). */
export function requireTable() {
  const lines = [
    '// GENERATED by scripts/photos/badges.mjs — do not edit by hand.',
    "import type { ImageRequireSource } from 'react-native';",
    '',
    '/**',
    ' * Trail-photo map images (#587), rendered at 3× (see `@core/photos/mapStyle`):',
    ' * stack count badges keyed by `countImageName(n)`, and the selection ring.',
    ' */',
    'export const PHOTO_BADGE_IMAGES: Readonly<Record<string, ImageRequireSource>> = {',
  ];
  for (let n = MIN_COUNT; n <= MAX_COUNT; n++) {
    lines.push(`  'ph-count-${n}': require('../../../assets/photos/badges/count-${n}.png'),`);
  }
  lines.push("  'ph-selected-ring': require('../../../assets/photos/badges/selected-ring.png'),");
  lines.push('};', '');
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(OUT_DIR, { recursive: true });
  let bytes = 0;
  for (const [name, data] of renderAll()) {
    writeFileSync(join(OUT_DIR, name), data);
    bytes += data.length;
  }
  writeFileSync(TABLE_PATH, requireTable());
  console.log(
    `wrote ${MAX_COUNT - MIN_COUNT + 2} images (${(bytes / 1024).toFixed(1)} KB) and the table`,
  );
}

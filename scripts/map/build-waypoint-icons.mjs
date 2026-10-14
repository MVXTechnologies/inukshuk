#!/usr/bin/env node
/**
 * Render the waypoint pin sprites (#675):
 *
 *   node scripts/map/build-waypoint-icons.mjs
 *
 * The main map draws every waypoint in symbol layers (never one view per pin),
 * with a colour, a size and an icon per pin. 350 icons × 18 colours × 4 sizes
 * pre-tinted would be 25 200 images, so the sprites are SIGNED DISTANCE FIELDS
 * instead: MapLibre tints an SDF image with `icon-color` per feature, scales it
 * with `icon-size` without blurring, and draws the ring with `icon-halo-*`.
 * Each image is rendered once:
 *
 * - `assets/map/waypoints/wp-pin.png` — the pin body (a disc with one sharp
 *   corner pointing down), at the XL diameter, 1 px per dp;
 * - `assets/map/waypoints/wpg-<id>.png` — one per catalogue icon
 *   (`src/core/library/waypointIconCatalog.ts`), the MaterialCommunityIcons
 *   glyph read straight from the bundled TTF, 2 px per dp;
 * - `assets/map/waypoints/wpg-default.png` — the inukshuk silhouette
 *   (`src/ui/components/inukshukStones.ts`), for a pin with no icon;
 * - `assets/map/waypoints/wp-photo.png` — the "has a photo" badge, a plain
 *   (non-SDF) RGBA image, 3 px per dp;
 * - `src/features/map/waypoints/waypointPinImages.ts` — the literal `require`
 *   table Metro needs.
 *
 * SDF encoding (MapLibre's symbol_sdf shader: edge at 0.75, 8 px per 0.25):
 * alpha = clamp((6 - d) / 8) where d is the signed distance in image pixels,
 * positive outside. The halo reaches at most 6 px out; the layer keeps its
 * width within that (see `@core/map/waypointPinStyle`).
 *
 * Standard library only: a minimal TrueType reader (cmap 4/12, loca, glyf,
 * quadratic contours flattened), exact point-to-segment distances, nonzero
 * winding, and PNGs written with node:zlib. Deterministic output.
 *
 * The numbers below must match `@core/map/waypointPinStyle`;
 * `waypointPinImages.test.ts` reads the PNG headers to check.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { WAYPOINT_ICON_GROUPS } from '../../src/core/library/waypointIconCatalog.ts';
import { FIGURE_H, FIGURE_W, STONES } from '../../src/ui/components/inukshukStones.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'assets', 'map', 'waypoints');
const TABLE_PATH = join(ROOT, 'src', 'features', 'map', 'waypoints', 'waypointPinImages.ts');
const FONT = join(
  ROOT,
  'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/MaterialCommunityIcons.ttf',
);
const GLYPH_MAP = join(
  ROOT,
  'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/MaterialCommunityIcons.json',
);

// ---------------------------------------------------------------- geometry
// Keep in step with @core/map/waypointPinStyle.
const SDF_BUFFER = 6; // px of field around every shape
const PIN_BASE_D = 50; // dp: the XL head diameter; smaller sizes scale down
const PIN_DENSITY = 1; // px per dp
const GLYPH_BOX = 28; // dp: the glyph's em box at XL (0.56 of the diameter)
const GLYPH_DENSITY = 2; // px per dp
const PHOTO_D = 15; // dp: badge diameter
const PHOTO_DENSITY = 3;

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
/** RGBA8 PNG from a Uint8Array of w*h*4. */
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
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

// ---------------------------------------------------------------- distance fields
/** Signed distance (px, + outside) of every pixel centre to a set of closed polygons (nonzero). */
function polygonField(w, h, polys) {
  const segs = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a[0] !== b[0] || a[1] !== b[1]) segs.push([a[0], a[1], b[0], b[1]]);
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const py = y + 0.5;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      let best = Infinity;
      let wind = 0;
      for (const [ax, ay, bx, by] of segs) {
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
        const ex = ax + t * dx - px;
        const ey = ay + t * dy - py;
        const d2 = ex * ex + ey * ey;
        if (d2 < best) best = d2;
        if (ay <= py) {
          if (by > py && dx * (py - ay) - (px - ax) * dy > 0) wind++;
        } else if (by <= py && dx * (py - ay) - (px - ax) * dy < 0) wind--;
      }
      const d = Math.sqrt(best);
      out[y * w + x] = wind !== 0 ? -d : d;
    }
  }
  return out;
}

/** An SDF field → white RGBA with the field in alpha. */
function sdfImage(w, h, field) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = Math.max(0, Math.min(1, (6 - field[i]) / 8));
    rgba[i * 4] = 255;
    rgba[i * 4 + 1] = 255;
    rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = Math.round(a * 255);
  }
  return rgba;
}

// ---------------------------------------------------------------- the pin body
function pinBody() {
  const d = PIN_BASE_D * PIN_DENSITY;
  const r = d / 2;
  const headCy = d * Math.SQRT1_2; // above the tip
  const w = Math.ceil(d + 2 * SDF_BUFFER);
  const h = Math.ceil(r + headCy + 2 * SDF_BUFFER);
  const cx = w / 2;
  const tipY = SDF_BUFFER + r + headCy;
  const cy = tipY - headCy;
  const field = new Float64Array(w * h);
  // Union of the head disc and the diamond between its centre and the tip
  // (the CSS mockup's square with three rounded corners, rotated 45°).
  const s = r; // the diamond is a square of side r
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - cx;
      const py = y + 0.5 - cy;
      const disc = Math.hypot(px, py) - r;
      // Rotate so the square [0,s]x[0,s] has its corner at the centre and
      // its opposite corner at the tip (straight down).
      const u = (px + py) * Math.SQRT1_2;
      const v = (py - px) * Math.SQRT1_2;
      const qx = Math.abs(u - s / 2) - s / 2;
      const qy = Math.abs(v - s / 2) - s / 2;
      const box = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
      field[y * w + x] = Math.min(disc, box);
    }
  }
  return { w, h, rgba: sdfImage(w, h, field) };
}

// ---------------------------------------------------------------- TrueType
function readFont(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tables = {};
  const numTables = dv.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const o = 12 + 16 * i;
    const tag = String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
    tables[tag] = { offset: dv.getUint32(o + 8), length: dv.getUint32(o + 12) };
  }
  const head = tables.head.offset;
  const unitsPerEm = dv.getUint16(head + 18);
  const locFormat = dv.getInt16(head + 50);
  const hhea = tables.hhea.offset;
  const ascender = dv.getInt16(hhea + 4);
  const descender = dv.getInt16(hhea + 6);
  const numHMetrics = dv.getUint16(hhea + 34);
  const hmtx = tables.hmtx.offset;
  const advance = (g) => dv.getUint16(hmtx + 4 * Math.min(g, numHMetrics - 1));
  const loca = (g) =>
    locFormat === 0
      ? dv.getUint16(tables.loca.offset + 2 * g) * 2
      : dv.getUint32(tables.loca.offset + 4 * g);

  // cmap: prefer format 12 (full Unicode: MCI lives in the supplementary PUA).
  const cmap = tables.cmap.offset;
  const nSub = dv.getUint16(cmap + 2);
  let lookup = null;
  for (let i = 0; i < nSub && lookup === null; i++) {
    const sub = cmap + dv.getUint32(cmap + 4 + 8 * i + 4);
    if (dv.getUint16(sub) !== 12) continue;
    const nGroups = dv.getUint32(sub + 12);
    lookup = (cp) => {
      for (let g = 0; g < nGroups; g++) {
        const o = sub + 16 + 12 * g;
        const start = dv.getUint32(o);
        const end = dv.getUint32(o + 4);
        if (cp >= start && cp <= end) return dv.getUint32(o + 8) + (cp - start);
      }
      return 0;
    };
  }
  for (let i = 0; i < nSub && lookup === null; i++) {
    const sub = cmap + dv.getUint32(cmap + 4 + 8 * i + 4);
    if (dv.getUint16(sub) !== 4) continue;
    const segX2 = dv.getUint16(sub + 6);
    const ends = sub + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    lookup = (cp) => {
      for (let s = 0; s < segX2; s += 2) {
        if (cp > dv.getUint16(ends + s)) continue;
        const start = dv.getUint16(starts + s);
        if (cp < start) return 0;
        const ro = dv.getUint16(ranges + s);
        if (ro === 0) return (cp + dv.getInt16(deltas + s)) & 0xffff;
        const g = dv.getUint16(ranges + s + ro + 2 * (cp - start));
        return g === 0 ? 0 : (g + dv.getInt16(deltas + s)) & 0xffff;
      }
      return 0;
    };
  }
  if (lookup === null) throw new Error('no usable cmap');

  /** Contours of a glyph as arrays of {x, y, on}. */
  function contours(g, depth = 0) {
    const start = loca(g);
    const end = loca(g + 1);
    if (end <= start) return [];
    const o = tables.glyf.offset + start;
    const n = dv.getInt16(o);
    if (n < 0) {
      if (depth > 4) return [];
      const out = [];
      let p = o + 10;
      for (;;) {
        const flags = dv.getUint16(p);
        const idx = dv.getUint16(p + 2);
        p += 4;
        let dx;
        let dy;
        if (flags & 1) {
          dx = dv.getInt16(p);
          dy = dv.getInt16(p + 2);
          p += 4;
        } else {
          dx = dv.getInt8(p);
          dy = dv.getInt8(p + 1);
          p += 2;
        }
        let a = 1;
        let b = 0;
        let c = 0;
        let d = 1;
        if (flags & 8) {
          a = d = dv.getInt16(p) / 16384;
          p += 2;
        } else if (flags & 0x40) {
          a = dv.getInt16(p) / 16384;
          d = dv.getInt16(p + 2) / 16384;
          p += 4;
        } else if (flags & 0x80) {
          a = dv.getInt16(p) / 16384;
          b = dv.getInt16(p + 2) / 16384;
          c = dv.getInt16(p + 4) / 16384;
          d = dv.getInt16(p + 6) / 16384;
          p += 8;
        }
        for (const contour of contours(idx, depth + 1)) {
          out.push(
            contour.map((pt) => ({
              x: a * pt.x + c * pt.y + dx,
              y: b * pt.x + d * pt.y + dy,
              on: pt.on,
            })),
          );
        }
        if (!(flags & 0x20)) break;
      }
      return out;
    }
    const endPts = [];
    for (let i = 0; i < n; i++) endPts.push(dv.getUint16(o + 10 + 2 * i));
    const nPts = n === 0 ? 0 : endPts[n - 1] + 1;
    let p = o + 10 + 2 * n;
    p += 2 + dv.getUint16(p); // instructions
    const flags = [];
    while (flags.length < nPts) {
      const f = buf[p++];
      flags.push(f);
      if (f & 8) {
        let rep = buf[p++];
        while (rep-- > 0) flags.push(f);
      }
    }
    const xs = [];
    let v = 0;
    for (const f of flags) {
      if (f & 2) {
        const dlt = buf[p++];
        v += f & 16 ? dlt : -dlt;
      } else if (!(f & 16)) {
        v += dv.getInt16(p);
        p += 2;
      }
      xs.push(v);
    }
    const ys = [];
    v = 0;
    for (const f of flags) {
      if (f & 4) {
        const dlt = buf[p++];
        v += f & 32 ? dlt : -dlt;
      } else if (!(f & 32)) {
        v += dv.getInt16(p);
        p += 2;
      }
      ys.push(v);
    }
    const out = [];
    let first = 0;
    for (const last of endPts) {
      const c = [];
      for (let i = first; i <= last; i++) c.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
      out.push(c);
      first = last + 1;
    }
    return out;
  }

  return { unitsPerEm, ascender, descender, advance, lookup, contours };
}

/** Flatten a TrueType contour (quadratic B-spline) into a polygon. */
function flatten(contour, map, steps = 8) {
  const n = contour.length;
  if (n === 0) return [];
  // Start on an on-curve point (or the midpoint of two off-curve ones).
  let startIdx = contour.findIndex((p) => p.on);
  let pts = contour;
  if (startIdx === -1) {
    const a = contour[0];
    const b = contour[1 % n];
    pts = [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true }, ...contour.slice(1), contour[0]];
    startIdx = 0;
  } else {
    pts = [...contour.slice(startIdx), ...contour.slice(0, startIdx)];
  }
  const poly = [];
  const push = (x, y) => poly.push(map(x, y));
  let cur = pts[0];
  push(cur.x, cur.y);
  let ctrl = null;
  for (let i = 1; i <= pts.length; i++) {
    const p = pts[i % pts.length];
    if (p.on) {
      if (ctrl) {
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const mt = 1 - t;
          push(
            mt * mt * cur.x + 2 * mt * t * ctrl.x + t * t * p.x,
            mt * mt * cur.y + 2 * mt * t * ctrl.y + t * t * p.y,
          );
        }
        ctrl = null;
      } else {
        push(p.x, p.y);
      }
      cur = p;
    } else if (ctrl) {
      const mid = { x: (ctrl.x + p.x) / 2, y: (ctrl.y + p.y) / 2 };
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const mt = 1 - t;
        push(
          mt * mt * cur.x + 2 * mt * t * ctrl.x + t * t * mid.x,
          mt * mt * cur.y + 2 * mt * t * ctrl.y + t * t * mid.y,
        );
      }
      cur = mid;
      ctrl = p;
    } else {
      ctrl = p;
    }
  }
  return poly;
}

function glyphImage(font, codepoint) {
  const g = font.lookup(codepoint);
  if (g === 0) throw new Error(`no glyph for U+${codepoint.toString(16)}`);
  const box = GLYPH_BOX * GLYPH_DENSITY;
  const size = box + 2 * SDF_BUFFER;
  const scale = box / font.unitsPerEm;
  // An icon font draws its glyph in the em square between ascender and
  // descender; centre that square (and the advance) in the image.
  const emH = font.ascender - font.descender;
  const yOff = (box - emH * scale) / 2;
  const xOff = (box - font.advance(g) * scale) / 2;
  const map = (x, y) => [
    SDF_BUFFER + xOff + x * scale,
    SDF_BUFFER + yOff + (font.ascender - y) * scale,
  ];
  const polys = font.contours(g).map((c) => flatten(c, map));
  return { w: size, h: size, rgba: sdfImage(size, size, polygonField(size, size, polys)) };
}

// ---------------------------------------------------------------- the inukshuk
function parseOutline(d) {
  const nums = d.replace(/[MZ]/g, ' ').trim().split(/\s+/).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}

function inukshukImage() {
  const box = GLYPH_BOX * GLYPH_DENSITY;
  const size = box + 2 * SDF_BUFFER;
  // As InukshukGlyph frame="square" tone="mono": 20/24 of the box tall,
  // each stone shrunk about its centre so neighbours stay apart.
  const height = (box * 20) / 24;
  const k = height / FIGURE_H;
  const width = FIGURE_W * k;
  const gapPx = Math.max(GLYPH_DENSITY, height * 0.06);
  const inset = gapPx / (2 * k);
  const ox = SDF_BUFFER + (box - width) / 2;
  const oy = SDF_BUFFER + (box - height) / 2;
  const polys = STONES.map((s) => {
    const sx = Math.max(0.5, (s.w - 2 * inset) / s.w);
    const sy = Math.max(0.5, (s.h - 2 * inset) / s.h);
    const cx = s.w / 2;
    const cy = s.h / 2;
    return parseOutline(s.outline).map(([x, y]) => [
      ox + (s.x + cx - cx * sx + x * sx) * k,
      oy + (s.y + cy - cy * sy + y * sy) * k,
    ]);
  });
  return { w: size, h: size, rgba: sdfImage(size, size, polygonField(size, size, polys)) };
}

// ---------------------------------------------------------------- the photo badge
function photoBadge(font, glyphMap) {
  const d = PHOTO_D * PHOTO_DENSITY;
  const size = d + 2;
  const c = size / 2;
  const ring = 1.5 * PHOTO_DENSITY;
  const rgba = new Uint8Array(size * size * 4);
  // The camera glyph's coverage, from its distance field.
  const glyphBox = 9 * PHOTO_DENSITY;
  const scale = glyphBox / font.unitsPerEm;
  const g = font.lookup(glyphMap.camera);
  const emH = font.ascender - font.descender;
  const ox = c - glyphBox / 2 + (glyphBox - font.advance(g) * scale) / 2;
  const oy = c - glyphBox / 2 + (glyphBox - emH * scale) / 2;
  const map = (x, y) => [ox + x * scale, oy + (font.ascender - y) * scale];
  const glyph = polygonField(
    size,
    size,
    font.contours(g).map((ct) => flatten(ct, map)),
  );
  const cover = (sd) => Math.max(0, Math.min(1, 0.5 - sd));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const outer = cover(r - d / 2);
      const inner = cover(r - (d / 2 - ring));
      const ink = cover(glyph[i]) * inner;
      // Paper ring, stone disc, paper camera.
      const dark = inner - ink;
      const light = outer - inner + ink;
      const a = outer;
      const mix = a > 0 ? (dark * 0x2b + light * 0xff) / a : 0;
      rgba[i * 4] = Math.round(mix);
      rgba[i * 4 + 1] = Math.round(mix);
      rgba[i * 4 + 2] = Math.round(mix);
      rgba[i * 4 + 3] = Math.round(a * 255);
    }
  }
  return { w: size, h: size, rgba };
}

// ---------------------------------------------------------------- main
const font = readFont(readFileSync(FONT));
const glyphMap = JSON.parse(readFileSync(GLYPH_MAP, 'utf8'));
mkdirSync(OUT_DIR, { recursive: true });
for (const f of readdirSync(OUT_DIR)) if (f.endsWith('.png')) unlinkSync(join(OUT_DIR, f));

const write = (name, img) =>
  writeFileSync(join(OUT_DIR, `${name}.png`), png(img.w, img.h, img.rgba));
const entries = [];
write('wp-pin', pinBody());
entries.push(['wp-pin', 'wp-pin']);
write('wp-photo', photoBadge(font, glyphMap));
entries.push(['wp-photo', 'wp-photo']);
write('wpg-default', inukshukImage());
entries.push(['wpg-default', 'wpg-default']);
for (const group of WAYPOINT_ICON_GROUPS) {
  for (const [id, , glyph] of group.icons) {
    const cp = glyphMap[glyph];
    if (cp === undefined) throw new Error(`${id}: no glyph "${glyph}" in MaterialCommunityIcons`);
    write(`wpg-${id}`, glyphImage(font, cp));
    entries.push([`wpg-${id}`, `wpg-${id}`]);
  }
}

const lines = entries.map(
  ([key, file]) => `  '${key}': require('../../../../assets/map/waypoints/${file}.png'),`,
);
writeFileSync(
  TABLE_PATH,
  `// GENERATED by scripts/map/build-waypoint-icons.mjs — do not edit by hand.
import type { ImageRequireSource } from 'react-native';

/**
 * Waypoint pin sprites (#675), keyed by the image names
 * \`@core/map/waypointPinStyle\` asks for: the SDF pin body, one SDF glyph per
 * catalogue icon plus the inukshuk, and the photo badge.
 */
export const WAYPOINT_PIN_IMAGES: Readonly<Record<string, ImageRequireSource>> = {
${lines.join('\n')}
};
`,
);
console.log(`wrote ${entries.length} images to ${OUT_DIR}`);

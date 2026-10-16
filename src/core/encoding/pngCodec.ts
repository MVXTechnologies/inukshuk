/**
 * Worklet-safe PNG codec for the terrain overlays (#722): decode the
 * Terrarium DEM tiles and encode the slope overlay without UPNG/pako, so the
 * whole slope pipeline can run on a background worklet runtime instead of the
 * JS thread. Every function is marked `'worklet'` (a plain string under
 * Node/Jest) and uses nothing but typed arrays and Math.
 *
 * - {@link inflateZlib}: zlib/deflate decoder (stored, fixed and dynamic
 *   Huffman blocks) with table-driven symbol lookup.
 * - {@link decodePng}: 8-bit, non-interlaced PNGs of every colour type → RGBA.
 * - {@link encodeIndexedPng}: an 8-bit palette PNG (PLTE + tRNS) whose IDAT is
 *   deflated with fixed Huffman codes and run-length (distance-1) matches —
 *   the slope overlay is long runs of one index, so this compresses it ~20–50×
 *   at a fraction of a general compressor's cost.
 */

/** CRC-32 (IEEE 802.3) of `bytes[start, end)`; PNG chunk checksums. */
export function crc32(bytes: Uint8Array, start: number, end: number): number {
  'worklet';
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = -1;
  for (let i = start; i < end; i++)
    crc = (table[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** Adler-32 (the zlib trailer), with the modulo deferred per 5552 bytes. */
export function adler32(bytes: Uint8Array): number {
  'worklet';
  let a = 1;
  let b = 0;
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const end = Math.min(i + 5552, n);
    for (; i < end; i++) {
      a += bytes[i] as number;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const LBASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LEXT = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DBASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DEXT = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/**
 * A canonical Huffman decoding table: `table[bits]` (the next `maxLen` input
 * bits, LSB-first) = `symbol << 4 | codeLength`; 0 = invalid code.
 */
interface HuffTable {
  table: Int32Array;
  maxLen: number;
}

function buildHuffman(lengths: ArrayLike<number>, n: number): HuffTable {
  'worklet';
  const count = new Int32Array(16);
  let maxLen = 0;
  for (let s = 0; s < n; s++) {
    const l = lengths[s] as number;
    count[l] = (count[l] as number) + 1;
    if (l > maxLen) maxLen = l;
  }
  if (maxLen === 0) maxLen = 1;
  count[0] = 0;
  const next = new Int32Array(16);
  let code = 0;
  for (let l = 1; l < 16; l++) {
    code = (code + (count[l - 1] as number)) << 1;
    next[l] = code;
  }
  const size = 1 << maxLen;
  const table = new Int32Array(size);
  for (let s = 0; s < n; s++) {
    const l = lengths[s] as number;
    if (l === 0) continue;
    const c = next[l] as number;
    next[l] = c + 1;
    // Codes are packed MSB-first; the bit reader is LSB-first: reverse.
    let rev = 0;
    for (let k = 0; k < l; k++) rev |= ((c >> k) & 1) << (l - 1 - k);
    for (let j = rev; j < size; j += 1 << l) table[j] = (s << 4) | l;
  }
  return { table, maxLen };
}

/** Inflate a zlib stream (RFC 1950/1951); throws on malformed input or past `maxOut` bytes. */
export function inflateZlib(src: Uint8Array, maxOut = 1 << 30): Uint8Array {
  'worklet';
  if (src.length < 6 || (src[0]! & 0x0f) !== 8 || ((src[0]! << 8) | src[1]!) % 31 !== 0) {
    throw new Error('inflate: not a zlib stream');
  }
  if (src[1]! & 0x20) throw new Error('inflate: preset dictionary unsupported');
  let pos = 2;
  let bitBuf = 0;
  let bitCnt = 0;
  let out = new Uint8Array(maxOut < 1 << 30 ? maxOut : Math.max(1024, src.length * 4));
  let o = 0;
  const need = (n: number) => {
    while (bitCnt < n) {
      // A few zero bytes of slack past the end (the final code may sit in
      // the last byte while the decoder peeks a full table width); beyond
      // that the stream is truncated — zeros could otherwise decode forever.
      if (pos >= src.length + 4) throw new Error('inflate: truncated stream');
      const byte = pos < src.length ? (src[pos] as number) : 0;
      pos++;
      bitBuf |= byte << bitCnt;
      bitCnt += 8;
    }
  };
  const bits = (n: number) => {
    need(n);
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const decode = (h: HuffTable) => {
    need(h.maxLen);
    const e = h.table[bitBuf & ((1 << h.maxLen) - 1)] as number;
    const l = e & 15;
    if (l === 0) throw new Error('inflate: bad Huffman code');
    bitBuf >>>= l;
    bitCnt -= l;
    return e >> 4;
  };
  const ensure = (extra: number) => {
    if (o + extra > maxOut) throw new Error('inflate: output larger than expected');
    if (o + extra <= out.length) return;
    let size = out.length * 2;
    while (size < o + extra) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(out.subarray(0, o));
    out = grown;
  };

  let fixedLit: HuffTable | null = null;
  let fixedDist: HuffTable | null = null;
  let final = 0;
  while (final === 0) {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      // Stored: byte-align (returning whole bytes the bit buffer pre-read),
      // then LEN, NLEN, raw bytes.
      pos -= bitCnt >> 3;
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > src.length) throw new Error('inflate: truncated stored block');
      const len = src[pos]! | (src[pos + 1]! << 8);
      const nlen = src[pos + 2]! | (src[pos + 3]! << 8);
      pos += 4;
      if ((len ^ 0xffff) !== nlen) throw new Error('inflate: bad stored length');
      if (pos + len > src.length) throw new Error('inflate: truncated stored block');
      ensure(len);
      out.set(src.subarray(pos, pos + len), o);
      o += len;
      pos += len;
      continue;
    }
    let lit: HuffTable;
    let dist: HuffTable;
    if (type === 1) {
      if (fixedLit === null || fixedDist === null) {
        const l = new Uint8Array(288);
        for (let s = 0; s < 288; s++) l[s] = s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8;
        fixedLit = buildHuffman(l, 288);
        fixedDist = buildHuffman(new Uint8Array(30).fill(5), 30);
      }
      lit = fixedLit;
      dist = fixedDist;
    } else if (type === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let k = 0; k < hclen; k++) cl[CL_ORDER[k]!] = bits(3);
      const clTable = buildHuffman(cl, 19);
      const lens = new Uint8Array(hlit + hdist);
      for (let k = 0; k < hlit + hdist;) {
        const sym = decode(clTable);
        if (sym < 16) {
          lens[k++] = sym;
          continue;
        }
        let rep: number;
        let val = 0;
        if (sym === 16) {
          if (k === 0) throw new Error('inflate: repeat with no previous length');
          val = lens[k - 1]!;
          rep = 3 + bits(2);
        } else if (sym === 17) {
          rep = 3 + bits(3);
        } else {
          rep = 11 + bits(7);
        }
        if (k + rep > hlit + hdist) throw new Error('inflate: code lengths overflow');
        while (rep-- > 0) lens[k++] = val;
      }
      lit = buildHuffman(lens.subarray(0, hlit), hlit);
      dist = buildHuffman(lens.subarray(hlit), hdist);
    } else {
      throw new Error('inflate: bad block type');
    }
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        ensure(1);
        out[o++] = sym;
      } else if (sym === 256) {
        break;
      } else {
        const li = sym - 257;
        if (li >= 29) throw new Error('inflate: bad length code');
        const len = (LBASE[li] as number) + bits(LEXT[li] as number);
        const di = decode(dist);
        if (di >= 30) throw new Error('inflate: bad distance code');
        const d = (DBASE[di] as number) + bits(DEXT[di] as number);
        if (d > o) throw new Error('inflate: distance too far back');
        ensure(len);
        for (let k = 0; k < len; k++, o++) out[o] = out[o - d] as number;
      }
    }
  }
  // Trailer: Adler-32 of the output, big-endian, after byte alignment.
  const unread = bitCnt >> 3; // whole bytes pulled into the bit buffer but unused
  const t = pos - unread;
  const result = out.subarray(0, o);
  if (t + 4 > src.length) throw new Error('inflate: missing adler32');
  const want = ((src[t]! << 24) | (src[t + 1]! << 16) | (src[t + 2]! << 8) | src[t + 3]!) >>> 0;
  if (adler32(result) !== want) throw new Error('inflate: adler32 mismatch');
  return result;
}

/** A decoded image: RGBA, row 0 = top. */
export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** A PNG's unfiltered samples, before any conversion to RGBA. */
export interface PngPixels {
  width: number;
  height: number;
  /** PNG colour type: 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
  colorType: number;
  depth: number;
  channels: number;
  /** Bytes per row of `px`. */
  stride: number;
  px: Uint8Array;
  palette: Uint8Array | null;
  trns: Uint8Array | null;
}

/**
 * Parse, inflate and unfilter an 8-bit, non-interlaced PNG (grey, grey+alpha,
 * RGB, RGBA or palette; grey and palette also at 1/2/4 bits). Throws on
 * anything else (16-bit, interlaced) — callers keep a general decoder as
 * fallback.
 */
export function decodePngPixels(bytes: Uint8Array): PngPixels {
  'worklet';
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('png: bad signature');
  const u32 = (q: number) =>
    ((bytes[q]! << 24) | (bytes[q + 1]! << 16) | (bytes[q + 2]! << 8) | bytes[q + 3]!) >>> 0;
  let p = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let depth = 8;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatLen = 0;
  while (p + 8 <= bytes.length) {
    const len = u32(p);
    const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    const data = bytes.subarray(p + 8, p + 8 + len);
    if (data.length !== len) throw new Error('png: truncated chunk');
    if (type === 'IHDR') {
      width = u32(p + 8);
      height = u32(p + 12);
      depth = data[8]!;
      colorType = data[9]!;
      const subByteOk =
        (colorType === 0 || colorType === 3) && (depth === 1 || depth === 2 || depth === 4);
      if (depth !== 8 && !subByteOk) {
        throw new Error('png: only 8-bit depth (1/2/4 for grey or palette)');
      }
      if (data[12] !== 0) throw new Error('png: interlaced unsupported');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
      idatLen += len;
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  const channels =
    colorType === 0 || colorType === 3
      ? 1
      : colorType === 2
        ? 3
        : colorType === 4
          ? 2
          : colorType === 6
            ? 4
            : 0;
  if (channels === 0 || width === 0 || height === 0) throw new Error('png: bad header');
  if (colorType === 3 && palette === null) throw new Error('png: palette missing');
  const z = new Uint8Array(idatLen);
  let zo = 0;
  for (const c of idat) {
    z.set(c, zo);
    zo += c.length;
  }
  const stride = Math.ceil((width * channels * depth) / 8);
  // Filters predict from the byte one PIXEL back (one byte below 8 bits).
  const bpp = Math.max(1, (channels * depth) >> 3);
  const raw = inflateZlib(z, (stride + 1) * height);
  if (raw.length < (stride + 1) * height) throw new Error('png: short image data');
  // Unfilter row by row, one tight loop per filter type (hot path: 4M bytes
  // per DEM mosaic).
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const ri = y * (stride + 1) + 1;
    const o = y * stride;
    const up = o - stride;
    if (f === 0 || (f === 2 && y === 0)) {
      px.set(raw.subarray(ri, ri + stride), o);
    } else if (f === 1 || (f === 3 && y === 0) || (f === 4 && y === 0)) {
      // Sub; Avg and Paeth reduce to (half) Sub on the first row.
      const half = f === 3;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? px[o + x - bpp]! : 0;
        px[o + x] = (raw[ri + x]! + (half ? a >> 1 : a)) & 0xff;
      }
    } else if (f === 2) {
      for (let x = 0; x < stride; x++) px[o + x] = (raw[ri + x]! + px[up + x]!) & 0xff;
    } else if (f === 3) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? px[o + x - bpp]! : 0;
        px[o + x] = (raw[ri + x]! + ((a + px[up + x]!) >> 1)) & 0xff;
      }
    } else if (f === 4) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? px[o + x - bpp]! : 0;
        const b = px[up + x]!;
        const c = x >= bpp ? px[up + x - bpp]! : 0;
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - c - c);
        px[o + x] = (raw[ri + x]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    } else {
      throw new Error('png: bad filter');
    }
  }
  return { width, height, colorType, depth, channels, stride, px, palette, trns };
}

/** Expand {@link decodePngPixels} output to RGBA. */
export function pngPixelsToRgba(img: PngPixels): Uint8Array {
  'worklet';
  const { width, height, colorType, depth, stride, px, palette, trns } = img;
  if (colorType === 6) return px;
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  // Grey/palette sample of pixel i, unpacked from 1/2/4/8 bits.
  const mask = (1 << depth) - 1;
  const one = (i: number) => {
    if (depth === 8) return px[i]!;
    const x = i % width;
    const bit = x * depth;
    const byte = px[((i - x) / width) * stride + (bit >> 3)]!;
    return (byte >> (8 - depth - (bit & 7))) & mask;
  };
  for (let i = 0; i < n; i++) {
    const q = i * 4;
    if (colorType === 2) {
      const r = px[i * 3]!;
      const g = px[i * 3 + 1]!;
      const b = px[i * 3 + 2]!;
      rgba[q] = r;
      rgba[q + 1] = g;
      rgba[q + 2] = b;
      rgba[q + 3] =
        trns !== null && trns.length >= 6 && r === trns[1] && g === trns[3] && b === trns[5]
          ? 0
          : 255;
    } else if (colorType === 3) {
      const k = one(i);
      rgba[q] = palette![k * 3] ?? 0;
      rgba[q + 1] = palette![k * 3 + 1] ?? 0;
      rgba[q + 2] = palette![k * 3 + 2] ?? 0;
      rgba[q + 3] = trns !== null && k < trns.length ? trns[k]! : 255;
    } else if (colorType === 0) {
      const v = one(i);
      const g = Math.round((v * 255) / mask);
      rgba[q] = g;
      rgba[q + 1] = g;
      rgba[q + 2] = g;
      rgba[q + 3] =
        trns !== null && trns.length >= 2 && v === ((trns[0]! << 8) | trns[1]!) ? 0 : 255;
    } else {
      const g = px[i * 2]!;
      rgba[q] = g;
      rgba[q + 1] = g;
      rgba[q + 2] = g;
      rgba[q + 3] = px[i * 2 + 1]!;
    }
  }
  return rgba;
}

/** Decode a PNG (see {@link decodePngPixels} for what it accepts) to RGBA. */
export function decodePng(bytes: Uint8Array): DecodedImage {
  'worklet';
  const img = decodePngPixels(bytes);
  return { width: img.width, height: img.height, rgba: pngPixelsToRgba(img) };
}

/**
 * zlib-wrap `raw` with ONE fixed-Huffman deflate block whose only matches are
 * runs of the previous byte (distance 1) or, when `rowDist` is given, copies
 * of the bytes one image row back (distance `rowDist`), lengths 3..258 — the
 * two redundancies of a banded overlay image, found in one linear pass.
 */
export function deflateRuns(raw: Uint8Array, rowDist = 0): Uint8Array {
  'worklet';
  const out = new Uint8Array(Math.ceil((raw.length * 9) / 8) + 64);
  let o = 2;
  out[0] = 0x78;
  out[1] = 0x01;
  let buf = 0;
  let cnt = 0;
  const put = (v: number, n: number) => {
    buf |= v << cnt;
    cnt += n;
    while (cnt >= 8) {
      out[o++] = buf & 0xff;
      buf >>>= 8;
      cnt -= 8;
    }
  };
  // Fixed-Huffman codes are MSB-first: write them bit-reversed.
  const putCode = (code: number, n: number) => {
    let rev = 0;
    for (let k = 0; k < n; k++) rev |= ((code >> k) & 1) << (n - 1 - k);
    put(rev, n);
  };
  const putLit = (s: number) => {
    if (s < 144) putCode(0x30 + s, 8);
    else if (s < 256) putCode(0x190 + s - 144, 9);
    else if (s < 280) putCode(s - 256, 7);
    else putCode(0xc0 + s - 280, 8);
  };
  put(1, 1); // BFINAL
  put(1, 2); // BTYPE = 01 (fixed Huffman)
  const n = raw.length;
  let i = 0;
  while (i < n) {
    let run = 0;
    if (i > 0) {
      const prev = raw[i - 1]!;
      while (run < 258 && i + run < n && raw[i + run] === prev) run++;
    }
    let up = 0;
    if (rowDist > 1 && rowDist <= 32768 && i >= rowDist && run < 258) {
      while (up < 258 && i + up < n && raw[i + up] === raw[i + up - rowDist]) up++;
    }
    if (up > run && up >= 3) {
      let li = 28;
      while ((LBASE[li] as number) > up) li--;
      putLit(257 + li);
      const e = LEXT[li] as number;
      if (e > 0) put(up - (LBASE[li] as number), e);
      let di = 29;
      while ((DBASE[di] as number) > rowDist) di--;
      putCode(di, 5);
      const de = DEXT[di] as number;
      if (de > 0) put(rowDist - (DBASE[di] as number), de);
      i += up;
    } else if (run >= 3) {
      let li = 28;
      while ((LBASE[li] as number) > run) li--;
      putLit(257 + li);
      const e = LEXT[li] as number;
      if (e > 0) put(run - (LBASE[li] as number), e);
      putCode(0, 5); // distance code 0 = distance 1
      i += run;
    } else {
      putLit(raw[i]!);
      i++;
    }
  }
  putLit(256);
  if (cnt > 0) put(0, 8 - cnt);
  const adler = adler32(raw);
  out[o++] = (adler >>> 24) & 0xff;
  out[o++] = (adler >>> 16) & 0xff;
  out[o++] = (adler >>> 8) & 0xff;
  out[o++] = adler & 0xff;
  return out.slice(0, o);
}

/**
 * Encode an 8-bit indexed PNG: `indices` (width × height, row 0 = top), a
 * palette of `count = rgb.length / 3` entries and their alphas (tRNS).
 */
export function encodeIndexedPng(
  width: number,
  height: number,
  indices: Uint8Array,
  rgb: Uint8Array,
  alpha: Uint8Array,
): Uint8Array {
  'worklet';
  if (width < 1 || height < 1) throw new Error('png: empty image');
  if (indices.length !== width * height) throw new Error('png: size mismatch');
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const idat = deflateRuns(raw, width + 1);
  const ihdr = new Uint8Array(13);
  const be32 = (a: Uint8Array, p: number, v: number) => {
    a[p] = (v >>> 24) & 0xff;
    a[p + 1] = (v >>> 16) & 0xff;
    a[p + 2] = (v >>> 8) & 0xff;
    a[p + 3] = v & 0xff;
  };
  be32(ihdr, 0, width);
  be32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // indexed colour
  const chunks: [string, Uint8Array][] = [
    ['IHDR', ihdr],
    ['PLTE', rgb],
    ['tRNS', alpha],
    ['IDAT', idat],
    ['IEND', new Uint8Array(0)],
  ];
  let total = 8;
  for (const [, d] of chunks) total += 12 + d.length;
  const out = new Uint8Array(total);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let p = 8;
  for (const [type, d] of chunks) {
    be32(out, p, d.length);
    for (let k = 0; k < 4; k++) out[p + 4 + k] = type.charCodeAt(k);
    out.set(d, p + 8);
    be32(out, p + 8 + d.length, crc32(out, p + 4, p + 8 + d.length));
    p += 12 + d.length;
  }
  return out;
}

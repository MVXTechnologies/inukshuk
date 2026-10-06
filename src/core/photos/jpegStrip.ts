/**
 * Remove location and other personal metadata from a JPEG (#587), byte-level.
 *
 * The optimized copies the app makes are re-encoded by a canvas and carry no
 * metadata at all; this is for the bytes that are NOT re-encoded — the "Full
 * size" copies (Android's picker copies the original EXIF, GPS included, into
 * its output) — and as a belt-and-braces pass on everything written.
 *
 * Dropped: APP1 (EXIF with GPS, device serials, and XMP, which can repeat the
 * GPS), APP13 (IPTC / Photoshop: captions, locations), COM comments, and any
 * other APPn except the ones needed to SHOW the image right: APP0 (JFIF), APP2
 * (ICC colour profile, MPF) and APP14 (Adobe colour transform). The EXIF
 * orientation lives in APP1, so when it is not "upright" a minimal APP1 holding
 * ONLY the orientation tag is written back — otherwise a portrait photo would
 * turn sideways.
 */

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;

export interface StripResult {
  bytes: Uint8Array;
  /** False when the input was not a parseable JPEG (returned unchanged). */
  jpeg: boolean;
  /** Metadata segments removed. */
  removed: number;
  /** The EXIF orientation found (1–8), if any. */
  orientation?: number;
}

const isJpeg = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0xff && b[1] === SOI;

/** Markers that stand alone, with no length field. */
const standalone = (m: number): boolean => m === 0x01 || (m >= 0xd0 && m <= 0xd7);

export function stripJpegMetadata(input: Uint8Array): StripResult {
  if (!isJpeg(input)) return { bytes: input, jpeg: false, removed: 0 };
  const kept: Uint8Array[] = [input.subarray(0, 2)];
  let removed = 0;
  let orientation: number | undefined;
  let i = 2;
  while (i < input.length) {
    if (input[i] !== 0xff) return { bytes: input, jpeg: false, removed: 0 }; // corrupt
    // Fill bytes: any number of 0xFF before a marker.
    let j = i;
    while (j < input.length && input[j] === 0xff) j++;
    if (j >= input.length) break;
    const marker = input[j]!;
    const markerStart = j - 1;
    if (marker === EOI) {
      kept.push(input.subarray(markerStart, j + 1));
      i = j + 1;
      break;
    }
    if (standalone(marker)) {
      kept.push(input.subarray(markerStart, j + 1));
      i = j + 1;
      continue;
    }
    if (j + 2 >= input.length) return { bytes: input, jpeg: false, removed: 0 };
    const len = (input[j + 1]! << 8) | input[j + 2]!;
    const end = j + 1 + len;
    if (len < 2 || end > input.length) return { bytes: input, jpeg: false, removed: 0 };
    if (marker === SOS) {
      // Entropy-coded data follows; everything from here on is image.
      kept.push(input.subarray(markerStart));
      i = input.length;
      break;
    }
    const isApp = marker >= APP0 && marker <= 0xef;
    const isComment = marker === 0xfe;
    const keep = !isComment && (!isApp || marker === APP0 || marker === APP2 || marker === APP14);
    if (keep) {
      kept.push(input.subarray(markerStart, end));
    } else {
      removed++;
      if (marker === APP1 && orientation === undefined) {
        orientation = readExifOrientation(input.subarray(j + 3, end));
      }
    }
    i = end;
  }
  if (i < input.length) kept.push(input.subarray(i));

  if (orientation !== undefined && orientation !== 1) {
    // Re-insert just the orientation, right after SOI and any APP0 (JFIF must lead).
    const app = orientationApp1(orientation);
    const afterSoi = kept[1] && kept[1][1] === APP0 ? 2 : 1;
    kept.splice(afterSoi, 0, app);
  }
  const out = new Uint8Array(kept.reduce((n, part) => n + part.length, 0));
  let o = 0;
  for (const part of kept) {
    out.set(part, o);
    o += part.length;
  }
  const result: StripResult = { bytes: out, jpeg: true, removed };
  if (orientation !== undefined) result.orientation = orientation;
  return result;
}

/** The Orientation tag (0x0112) of an APP1 payload that starts with "Exif\0\0". */
export function readExifOrientation(payload: Uint8Array): number | undefined {
  // "Exif\0\0"
  if (
    payload.length < 14 ||
    payload[0] !== 0x45 ||
    payload[1] !== 0x78 ||
    payload[2] !== 0x69 ||
    payload[3] !== 0x66 ||
    payload[4] !== 0 ||
    payload[5] !== 0
  ) {
    return undefined;
  }
  const tiff = payload.subarray(6);
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return undefined;
  const u16 = (at: number) =>
    at + 1 < tiff.length
      ? little
        ? tiff[at]! | (tiff[at + 1]! << 8)
        : (tiff[at]! << 8) | tiff[at + 1]!
      : -1;
  const u32 = (at: number) =>
    at + 3 < tiff.length
      ? little
        ? (tiff[at]! | (tiff[at + 1]! << 8) | (tiff[at + 2]! << 16) | (tiff[at + 3]! << 24)) >>> 0
        : ((tiff[at]! << 24) | (tiff[at + 1]! << 16) | (tiff[at + 2]! << 8) | tiff[at + 3]!) >>> 0
      : -1;
  if (u16(2) !== 42) return undefined;
  const ifd = u32(4);
  const count = u16(ifd);
  if (ifd < 0 || count < 0) return undefined;
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}

/** A minimal big-endian EXIF APP1 segment holding one tag: Orientation. */
export function orientationApp1(orientation: number): Uint8Array {
  const tiff = [
    0x4d,
    0x4d,
    0x00,
    0x2a, // "MM", 42
    0x00,
    0x00,
    0x00,
    0x08, // IFD0 at offset 8
    0x00,
    0x01, // one entry
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01, // Orientation, SHORT, count 1
    0x00,
    orientation & 0xff,
    0x00,
    0x00, // value, padded
    0x00,
    0x00,
    0x00,
    0x00, // no next IFD
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const len = payload.length + 2;
  return new Uint8Array([0xff, APP1, (len >> 8) & 0xff, len & 0xff, ...payload]);
}

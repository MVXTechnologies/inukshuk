/**
 * Decode an XML activity file (GPX, TCX) from bytes, whatever its encoding.
 *
 * GPX in the wild is not always UTF-8. Older tools write ISO-8859-1 or
 * Windows-1252 (accented trail and place names), and some Windows tools write
 * UTF-16 with or without a byte-order mark. Reading those as UTF-8 either
 * fails outright (iOS `File.text()`: "the text encoding of its contents can't
 * be determined", #360 / #361) or turns the document into something
 * `parseGpx` cannot find a `<gpx>` root in. Rules, the way an XML parser
 * decides:
 *
 * 1. A byte-order mark wins (UTF-8, UTF-16LE, UTF-16BE).
 * 2. A BOM-less `<?` in UTF-16 is recognized from its zero bytes.
 * 3. Otherwise the `<?xml … encoding="…"?>` declaration names it. Latin-1
 *    names decode as Windows-1252, its superset, as browsers do.
 * 4. With no usable declaration it is UTF-8, unless the bytes are not valid
 *    UTF-8. Then it is Windows-1252, the usual mislabeled legacy file.
 *
 * The app stores and shares the result as UTF-8. So when the source was
 * anything else, the declaration's `encoding` is rewritten to say so;
 * otherwise a shared GPX would claim Latin-1 over UTF-8 bytes. Pure.
 */

export type XmlEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

/** Windows-1252 code points for bytes 0x80–0x9F (undefined bytes map to themselves). */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc,
  0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

const LATIN1_NAMES = new Set([
  'iso-8859-1',
  'iso8859-1',
  'iso_8859-1',
  'latin1',
  'latin-1',
  'l1',
  'iso-8859-15',
  'iso8859-15',
  'latin9',
  'windows-1252',
  'cp1252',
  'x-cp1252',
  'us-ascii',
  'ascii',
]);

/** Chunked so a multi-MB document never hits the argument-count limit. */
function fromCodes(codes: Uint16Array | number[], length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 8192) {
    out += String.fromCharCode(...Array.prototype.slice.call(codes, i, Math.min(length, i + 8192)));
  }
  return out;
}

/** Strict UTF-8 decode: null when the bytes are not well-formed UTF-8. */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  const units = new Uint16Array(bytes.length);
  let n = 0;
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0;
    if (b0 < 0x80) {
      units[n++] = b0;
      i += 1;
      continue;
    }
    let need: number;
    let cp: number;
    let min: number;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
      cp = b0 & 0x1f;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      cp = b0 & 0x0f;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      cp = b0 & 0x07;
      min = 0x10000;
    } else {
      return null;
    }
    for (let k = 1; k <= need; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (b & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    if (cp >= 0x10000) {
      const v = cp - 0x10000;
      units[n++] = 0xd800 + (v >> 10);
      units[n++] = 0xdc00 + (v & 0x3ff);
    } else {
      units[n++] = cp;
    }
    i += need + 1;
  }
  return fromCodes(units, n);
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  const count = bytes.length >> 1;
  const units = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const a = bytes[2 * i] ?? 0;
    const b = bytes[2 * i + 1] ?? 0;
    units[i] = littleEndian ? a | (b << 8) : (a << 8) | b;
  }
  return fromCodes(units, count);
}

function decodeWindows1252(bytes: Uint8Array): string {
  const units = new Uint16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    units[i] = b >= 0x80 && b <= 0x9f ? (CP1252_HIGH[b - 0x80] ?? b) : b;
  }
  return fromCodes(units, bytes.length);
}

/** The encoding named by an ASCII-compatible `<?xml … encoding="…"?>`, lowercased. */
function declaredEncoding(bytes: Uint8Array): string | null {
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, 256); i++) head += String.fromCharCode(bytes[i] ?? 0);
  const m = /^\s*<\?xml[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/.exec(head);
  return m?.[1]?.toLowerCase() ?? null;
}

/** Which encoding `bytes` is in, and how many leading bytes are its BOM. */
export function sniffXmlEncoding(bytes: Uint8Array): { encoding: XmlEncoding; bom: number } {
  const [b0, b1, b2, b3] = [bytes[0], bytes[1], bytes[2], bytes[3]];
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) return { encoding: 'utf-8', bom: 3 };
  if (b0 === 0xff && b1 === 0xfe) return { encoding: 'utf-16le', bom: 2 };
  if (b0 === 0xfe && b1 === 0xff) return { encoding: 'utf-16be', bom: 2 };
  if (b0 === 0x3c && b1 === 0x00 && b2 === 0x3f && b3 === 0x00) {
    return { encoding: 'utf-16le', bom: 0 };
  }
  if (b0 === 0x00 && b1 === 0x3c && b2 === 0x00 && b3 === 0x3f) {
    return { encoding: 'utf-16be', bom: 0 };
  }
  const declared = declaredEncoding(bytes);
  if (declared !== null && LATIN1_NAMES.has(declared)) return { encoding: 'windows-1252', bom: 0 };
  return { encoding: 'utf-8', bom: 0 };
}

/** Make the XML declaration agree with the UTF-8 the app writes. */
function declareUtf8(text: string): string {
  return text.replace(
    /^(\s*<\?xml[^>]*?\bencoding\s*=\s*)(["'])[A-Za-z0-9._:-]+\2/,
    (_m, lead: string, quote: string) => `${lead}${quote}UTF-8${quote}`,
  );
}

/** Decode an XML document's bytes to a string; never throws. */
export function decodeXmlText(bytes: Uint8Array): string {
  const { encoding, bom } = sniffXmlEncoding(bytes);
  const body = bom > 0 ? bytes.subarray(bom) : bytes;
  switch (encoding) {
    case 'utf-16le':
      return declareUtf8(decodeUtf16(body, true));
    case 'utf-16be':
      return declareUtf8(decodeUtf16(body, false));
    case 'windows-1252':
      return declareUtf8(decodeWindows1252(body));
    case 'utf-8': {
      const text = decodeUtf8Strict(body);
      // Not valid UTF-8 after all: the classic Latin-1 file with no (or a
      // wrong) declaration.
      return text ?? declareUtf8(decodeWindows1252(body));
    }
  }
}

import { Inflate, Unzlib } from 'fflate';
import {
  type PdfArray,
  type PdfDict,
  type PdfStream,
  type PdfValue,
  isArray,
  isDict,
  isRef,
  isStream,
} from './types';

/**
 * A focused, dependency-light PDF reader. It is NOT a full parser — it extracts
 * the object graph well enough to walk the page tree and read georeferencing
 * dictionaries. It supports:
 *   - classic `xref` tables + `trailer`
 *   - cross-reference streams (/Type /XRef) via FlateDecode (fflate)
 *   - object streams (/Type /ObjStm) for compressed objects
 *   - linear scanning as a fallback when xref is missing/broken
 *
 * Everything is best-effort: callers should catch errors and degrade to warnings.
 */

const SPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]); // ( ) < > [ ] { } / %

function isSpace(b: number): boolean {
  return SPACE.has(b);
}
function isDelim(b: number): boolean {
  return DELIM.has(b);
}
function isRegular(b: number): boolean {
  return !isSpace(b) && !isDelim(b);
}

/** Decode latin1 bytes to a JS string (1 byte = 1 code unit). */
function latin1(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/**
 * A recursive-descent value parser over a byte buffer with a movable cursor.
 * Used both for the top-level object body and for object-stream contents.
 */
class Lexer {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly limit: number = buf.length,
  ) {
    this.pos = start;
  }

  skipWs(): void {
    const { buf, limit } = this;
    while (this.pos < limit) {
      const b = buf[this.pos]!;
      if (b === 0x25) {
        // comment to end of line
        while (this.pos < limit && buf[this.pos] !== 0x0a && buf[this.pos] !== 0x0d) {
          this.pos++;
        }
      } else if (isSpace(b)) {
        this.pos++;
      } else {
        break;
      }
    }
  }

  /** Parse the next value. Returns undefined at EOF / unrecognized token. */
  parseValue(): PdfValue | undefined {
    this.skipWs();
    if (this.pos >= this.limit) return undefined;
    const b = this.buf[this.pos]!;

    if (b === 0x2f) return this.parseName();
    if (b === 0x28) return this.parseLiteralString();
    if (b === 0x5b) return this.parseArray();
    if (b === 0x3c) {
      if (this.buf[this.pos + 1] === 0x3c) return this.parseDict();
      return this.parseHexString();
    }
    if (b === 0x5d || b === 0x3e) return undefined; // close tokens handled by callers

    // keyword or number
    const word = this.readRegular();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    if (word === '') {
      this.pos++; // avoid infinite loop on stray delimiter
      return undefined;
    }

    // Could be a plain number or the start of an indirect ref "12 0 R".
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      // Look ahead for "<int> R" or "<int> obj".
      if (/^\d+$/.test(word)) {
        const save = this.pos;
        this.skipWs();
        const w2 = this.readRegular();
        if (/^\d+$/.test(w2)) {
          this.skipWs();
          const w3 = this.readRegular();
          if (w3 === 'R') {
            return { kind: 'ref', num: Number(word), gen: Number(w2) };
          }
          if (w3 === 'obj') {
            // object header inside a body — return the value that follows
            return this.parseValue();
          }
        }
        this.pos = save; // not a ref/obj — treat as number
      }
      return Number(word);
    }
    return Number(word); // last-resort numeric coercion (may be NaN)
  }

  readRegular(): string {
    const start = this.pos;
    while (this.pos < this.limit && isRegular(this.buf[this.pos]!)) this.pos++;
    return latin1(this.buf, start, this.pos);
  }

  parseName(): PdfValue {
    this.pos++; // slash
    let name = '';
    while (this.pos < this.limit) {
      const b = this.buf[this.pos]!;
      if (isSpace(b) || isDelim(b)) break;
      if (b === 0x23 && this.pos + 2 < this.limit) {
        // #XX hex escape
        const hex = latin1(this.buf, this.pos + 1, this.pos + 3);
        const code = parseInt(hex, 16);
        if (!Number.isNaN(code)) {
          name += String.fromCharCode(code);
          this.pos += 3;
          continue;
        }
      }
      name += String.fromCharCode(b);
      this.pos++;
    }
    return { kind: 'name', name };
  }

  parseLiteralString(): string {
    this.pos++; // (
    let depth = 1;
    let s = '';
    while (this.pos < this.limit && depth > 0) {
      const b = this.buf[this.pos++]!;
      if (b === 0x5c) {
        const n = this.buf[this.pos++]!;
        switch (n) {
          case 0x6e:
            s += '\n';
            break;
          case 0x72:
            s += '\r';
            break;
          case 0x74:
            s += '\t';
            break;
          case 0x28:
            s += '(';
            break;
          case 0x29:
            s += ')';
            break;
          case 0x5c:
            s += '\\';
            break;
          default:
            s += String.fromCharCode(n);
        }
      } else if (b === 0x28) {
        depth++;
        s += '(';
      } else if (b === 0x29) {
        depth--;
        if (depth > 0) s += ')';
      } else {
        s += String.fromCharCode(b);
      }
    }
    return s;
  }

  parseHexString(): string {
    this.pos++; // <
    let hex = '';
    while (this.pos < this.limit && this.buf[this.pos] !== 0x3e) {
      const b = this.buf[this.pos++]!;
      if (!isSpace(b)) hex += String.fromCharCode(b);
    }
    this.pos++; // >
    if (hex.length % 2 === 1) hex += '0';
    let s = '';
    for (let i = 0; i < hex.length; i += 2) {
      s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return s;
  }

  parseArray(): PdfArray {
    this.pos++; // [
    const arr: PdfArray = [];
    while (this.pos < this.limit) {
      this.skipWs();
      if (this.buf[this.pos] === 0x5d) {
        this.pos++;
        break;
      }
      const before = this.pos;
      const v = this.parseValue();
      if (v === undefined) {
        if (this.pos <= before) this.pos++;
        if (this.buf[before] === 0x5d) break;
        continue;
      }
      arr.push(v);
    }
    return arr;
  }

  parseDict(): PdfDict | PdfStream {
    this.pos += 2; // <<
    const entries = new Map<string, PdfValue>();
    while (this.pos < this.limit) {
      this.skipWs();
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      if (this.buf[this.pos] !== 0x2f) {
        // not a name where a key is expected — bail out of dict
        this.pos++;
        continue;
      }
      const keyVal = this.parseName();
      const key = (keyVal as { name: string }).name;
      const val = this.parseValue();
      if (val !== undefined) entries.set(key, val);
    }
    const dict: PdfDict = { kind: 'dict', entries };

    // Is a stream attached?
    const save = this.pos;
    this.skipWs();
    if (latin1(this.buf, this.pos, Math.min(this.pos + 6, this.limit)) === 'stream') {
      this.pos += 6;
      // skip CRLF or LF after the stream keyword
      if (this.buf[this.pos] === 0x0d) this.pos++;
      if (this.buf[this.pos] === 0x0a) this.pos++;
      const dataStart = this.pos;
      const lenVal = entries.get('Length');
      let dataEnd = -1;
      if (typeof lenVal === 'number' && lenVal >= 0) {
        const candidate = dataStart + lenVal;
        // Validate the declared length actually points at endstream.
        const probe = latin1(this.buf, candidate, Math.min(candidate + 12, this.limit));
        if (/^\s*endstream/.test(probe) || candidate <= this.limit) {
          dataEnd = candidate;
        }
      }
      if (dataEnd < 0) {
        // Search for the endstream marker.
        dataEnd = this.indexOf('endstream', dataStart);
        if (dataEnd < 0) dataEnd = this.limit;
      }
      this.pos = dataEnd;
      // advance past endstream
      const es = this.indexOf('endstream', dataStart);
      if (es >= 0) this.pos = es + 'endstream'.length;
      return { kind: 'stream', dict, raw: this.buf.slice(dataStart, dataEnd) };
    }
    this.pos = save;
    return dict;
  }

  indexOf(needle: string, from: number): number {
    const { buf, limit } = this;
    const first = needle.charCodeAt(0);
    for (let i = from; i <= limit - needle.length; i++) {
      if (buf[i] !== first) continue;
      let ok = true;
      for (let j = 1; j < needle.length; j++) {
        if (buf[i + j] !== needle.charCodeAt(j)) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
    return -1;
  }
}

/**
 * Decompressed-output cap. These streams hold xref tables, object streams and
 * metadata — legitimately a few MB at most. Without a cap, a few-KB crafted
 * "decompression bomb" stream in an imported PDF inflates to gigabytes and
 * OOM-kills the app during parse.
 */
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

/** Streaming inflate with a hard output cap; throws once the cap is exceeded. */
function inflateBounded(raw: Uint8Array, zlibWrapped: boolean): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onData = (chunk: Uint8Array) => {
    total += chunk.length;
    if (total > MAX_DECODED_BYTES) throw new Error('decoded stream exceeds size cap');
    chunks.push(chunk);
  };
  const inflater = zlibWrapped ? new Unzlib(onData) : new Inflate(onData);
  inflater.push(raw, true);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Apply FlateDecode to a stream's raw bytes; throws on failure or oversize output. */
function flateDecode(raw: Uint8Array): Uint8Array {
  try {
    return inflateBounded(raw, true);
  } catch (e) {
    // The cap is a security bound, not a format mismatch — never retry past it.
    if ((e as Error).message?.includes('size cap')) throw e;
    return inflateBounded(raw, false);
  }
}

interface XrefEntry {
  /** 1 = in-file at byte offset; 2 = compressed in an object stream. */
  type: 1 | 2;
  /** For type 1: byte offset. For type 2: the ObjStm object number. */
  field2: number;
  /** For type 2: index within the object stream. */
  field3: number;
}

/**
 * The parsed PDF: a lazy object store keyed by object number. We resolve
 * objects on demand and memoize them.
 */
export class PdfDocument {
  private xref = new Map<number, XrefEntry>();
  private cache = new Map<number, PdfValue>();
  private objStmCache = new Map<number, Map<number, PdfValue>>();
  readonly warnings: string[] = [];
  trailer: PdfDict | undefined;

  private constructor(readonly bytes: Uint8Array) {}

  static parse(bytes: Uint8Array): PdfDocument {
    const doc = new PdfDocument(bytes);
    try {
      doc.buildXref();
    } catch (e) {
      doc.warnings.push(`xref parse failed: ${(e as Error).message}; scanning objects`);
    }
    // If xref produced no usable trailer/Root, fall back to a linear scan.
    if (!doc.trailer || !doc.getTrailerRoot()) {
      doc.linearScan();
    }
    return doc;
  }

  /** Resolve an indirect reference (or pass a direct value through). */
  resolve(v: PdfValue | undefined): PdfValue | undefined {
    let cur = v;
    let guard = 0;
    while (cur !== undefined && isRef(cur) && guard++ < 50) {
      cur = this.getObject(cur.num);
    }
    return cur;
  }

  getObject(num: number): PdfValue | undefined {
    if (this.cache.has(num)) return this.cache.get(num);
    const entry = this.xref.get(num);
    if (!entry) return undefined;
    let value: PdfValue | undefined;
    if (entry.type === 1) {
      value = this.parseObjectAt(entry.field2, num);
    } else {
      value = this.parseFromObjStm(entry.field2, entry.field3, num);
    }
    if (value !== undefined) this.cache.set(num, value);
    return value;
  }

  /** Parse `N G obj ... endobj` at a byte offset. */
  private parseObjectAt(offset: number, expectNum: number): PdfValue | undefined {
    if (offset < 0 || offset >= this.bytes.length) return undefined;
    const lex = new Lexer(this.bytes, offset);
    lex.skipWs();
    const n = lex.readRegular();
    lex.skipWs();
    lex.readRegular(); // gen
    lex.skipWs();
    const kw = lex.readRegular();
    if (kw !== 'obj') {
      // offset may be off; try a small forward search for "obj".
      const at = lex.indexOf(`${expectNum} `, offset);
      if (at >= 0 && at < offset + 64) return this.parseObjectAt(at, expectNum);
      return undefined;
    }
    void n;
    return lex.parseValue();
  }

  /** Build the xref map from either an xref stream or a classic table. */
  private buildXref(): void {
    const startxref = this.findLastStartxref();
    const visited = new Set<number>();
    let offset = startxref;
    while (offset >= 0 && offset < this.bytes.length && !visited.has(offset)) {
      visited.add(offset);
      const next = this.readXrefSection(offset);
      offset = next;
    }
  }

  /** Returns the /Prev offset to follow, or -1 when done. */
  private readXrefSection(offset: number): number {
    const lex = new Lexer(this.bytes, offset);
    lex.skipWs();
    const kw = latin1(this.bytes, lex.pos, Math.min(lex.pos + 4, this.bytes.length));
    if (kw === 'xref') {
      return this.readClassicXref(lex);
    }
    // Otherwise an xref stream: "N G obj << ... >> stream".
    const obj = this.parseObjectAt(offset, -1);
    if (obj && isStream(obj)) {
      return this.readXrefStream(obj);
    }
    return -1;
  }

  private readClassicXref(lex: Lexer): number {
    lex.pos += 4; // "xref"
    // Subsections: "<start> <count>\n" then count lines of 20 bytes.
    for (;;) {
      lex.skipWs();
      const peek = latin1(this.bytes, lex.pos, Math.min(lex.pos + 7, this.bytes.length));
      if (peek.startsWith('trailer')) {
        lex.pos += 7;
        break;
      }
      const startStr = lex.readRegular();
      lex.skipWs();
      const countStr = lex.readRegular();
      if (!/^\d+$/.test(startStr) || !/^\d+$/.test(countStr)) break;
      const start = Number(startStr);
      // Clamp the declared entry count to what the file can actually hold
      // (20 bytes per entry): a crafted "0 9999999999" subsection would
      // otherwise spin this loop ~1e10 times and freeze the JS thread.
      const maxEntries = Math.max(0, Math.floor((this.bytes.length - lex.pos) / 20));
      const count = Math.min(Number(countStr), maxEntries);
      lex.skipWs();
      for (let i = 0; i < count; i++) {
        const line = latin1(this.bytes, lex.pos, lex.pos + 20);
        const off = parseInt(line.slice(0, 10), 10);
        const typeChar = line[17];
        lex.pos += 20;
        const objNum = start + i;
        if (typeChar === 'n' && !this.xref.has(objNum)) {
          this.xref.set(objNum, { type: 1, field2: off, field3: 0 });
        }
      }
    }
    // trailer dict follows
    lex.skipWs();
    const tdict = lex.parseValue();
    let prev = -1;
    if (tdict && isDict(tdict)) {
      if (!this.trailer) this.trailer = tdict;
      const xrefStm = tdict.entries.get('XRefStm');
      if (typeof xrefStm === 'number') this.readXrefSection(xrefStm);
      const p = tdict.entries.get('Prev');
      if (typeof p === 'number') prev = p;
    }
    return prev;
  }

  private readXrefStream(stream: PdfStream): number {
    const dict = stream.dict;
    if (!this.trailer) this.trailer = dict; // xref-stream dict IS the trailer
    const wVal = dict.entries.get('W');
    const sizeVal = dict.entries.get('Size');
    if (!isArray(wVal)) return -1;
    const w = (wVal as PdfArray).map((x) => Number(x)) as number[];
    const [w0, w1, w2] = [w[0] ?? 0, w[1] ?? 0, w[2] ?? 0];
    const rowLen = w0 + w1 + w2;
    // /W [0 0 0] (rowLen 0) would make the row loop below advance by 0 bytes
    // forever — a malformed/crafted file must not freeze the JS thread.
    if (rowLen <= 0 || w0 < 0 || w1 < 0 || w2 < 0) {
      this.warnings.push(`xref stream has invalid /W [${w.join(' ')}]`);
      return -1;
    }

    let data: Uint8Array;
    try {
      data = this.decodeStream(stream);
    } catch (e) {
      this.warnings.push(`xref stream decode failed: ${(e as Error).message}`);
      return -1;
    }

    // Index pairs default to [0, Size].
    let index: number[];
    const indexVal = dict.entries.get('Index');
    if (isArray(indexVal)) {
      index = (indexVal as PdfArray).map((x) => Number(x));
    } else {
      index = [0, typeof sizeVal === 'number' ? sizeVal : data.length / rowLen];
    }

    const readField = (buf: Uint8Array, p: number, len: number): number => {
      let v = 0;
      for (let i = 0; i < len; i++) v = v * 256 + buf[p + i]!;
      return v;
    };

    let p = 0;
    for (let s = 0; s + 1 < index.length; s += 2) {
      const startObj = index[s]!;
      const count = index[s + 1]!;
      for (let i = 0; i < count && p + rowLen <= data.length; i++) {
        const f1 = w0 === 0 ? 1 : readField(data, p, w0);
        const f2 = readField(data, p + w0, w1);
        const f3 = readField(data, p + w0 + w1, w2);
        p += rowLen;
        const objNum = startObj + i;
        if (this.xref.has(objNum)) continue;
        if (f1 === 1) this.xref.set(objNum, { type: 1, field2: f2, field3: 0 });
        else if (f1 === 2) this.xref.set(objNum, { type: 2, field2: f2, field3: f3 });
      }
    }
    const prev = dict.entries.get('Prev');
    return typeof prev === 'number' ? prev : -1;
  }

  /** Decode a stream's bytes honoring its /Filter chain (FlateDecode only). */
  decodeStream(stream: PdfStream): Uint8Array {
    const filterVal = this.resolve(stream.dict.entries.get('Filter'));
    const filters: string[] = [];
    if (filterVal && (filterVal as { kind?: string }).kind === 'name') {
      filters.push((filterVal as { name: string }).name);
    } else if (isArray(filterVal)) {
      for (const f of filterVal as PdfArray) {
        const rf = this.resolve(f);
        if (rf && (rf as { kind?: string }).kind === 'name') {
          filters.push((rf as { name: string }).name);
        }
      }
    }
    // A real PDF needs at most 1-2 filters; a long chain of stacked /Fl entries
    // is a decompression-bomb multiplier.
    if (filters.length > 4) throw new Error(`implausible filter chain (${filters.length})`);
    let data = stream.raw;
    for (const f of filters) {
      if (f === 'FlateDecode' || f === 'Fl') {
        data = flateDecode(data);
        data = this.applyPredictor(stream.dict, data);
      } else {
        throw new Error(`unsupported filter ${f}`);
      }
    }
    return data;
  }

  /** Apply a PNG/TIFF predictor if /DecodeParms requests one (Predictor>=10 → PNG). */
  private applyPredictor(dict: PdfDict, data: Uint8Array): Uint8Array {
    const parmsVal =
      this.resolve(dict.entries.get('DecodeParms')) ?? this.resolve(dict.entries.get('DP'));
    if (!parmsVal || !isDict(parmsVal)) return data;
    const parms = parmsVal as PdfDict;
    const predictor = Number(this.resolve(parms.entries.get('Predictor')) ?? 1);
    if (predictor < 2) return data;
    const colors = Number(this.resolve(parms.entries.get('Colors')) ?? 1);
    const bpc = Number(this.resolve(parms.entries.get('BitsPerComponent')) ?? 8);
    const columns = Number(this.resolve(parms.entries.get('Columns')) ?? 1);
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const rowLen = Math.ceil((colors * bpc * columns) / 8);
    if (predictor === 2) {
      // TIFF predictor 2 — rare; leave as-is for our purposes.
      return data;
    }
    // PNG predictors: each row prefixed by a filter-type byte.
    const out = new Uint8Array(Math.floor(data.length / (rowLen + 1)) * rowLen);
    let prev = new Uint8Array(rowLen);
    let inPos = 0;
    let outPos = 0;
    while (inPos + rowLen + 1 <= data.length) {
      const ft = data[inPos++]!;
      const row = data.slice(inPos, inPos + rowLen);
      inPos += rowLen;
      for (let i = 0; i < rowLen; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        let val = row[i]!;
        switch (ft) {
          case 1:
            val = (val + a) & 0xff;
            break;
          case 2:
            val = (val + b) & 0xff;
            break;
          case 3:
            val = (val + ((a + b) >> 1)) & 0xff;
            break;
          case 4:
            val = (val + paeth(a, b, c)) & 0xff;
            break;
          default:
            break;
        }
        row[i] = val;
      }
      out.set(row, outPos);
      outPos += rowLen;
      prev = row;
    }
    return out;
  }

  /** Resolve a compressed object living inside an ObjStm. */
  private parseFromObjStm(stmNum: number, idx: number, _objNum: number): PdfValue | undefined {
    let table = this.objStmCache.get(stmNum);
    if (!table) {
      table = this.loadObjStm(stmNum);
      this.objStmCache.set(stmNum, table);
    }
    return table.get(idx);
  }

  private loadObjStm(stmNum: number): Map<number, PdfValue> {
    const result = new Map<number, PdfValue>();
    const stmObj = this.getObject(stmNum);
    if (!stmObj || !isStream(stmObj)) return result;
    let data: Uint8Array;
    try {
      data = this.decodeStream(stmObj);
    } catch (e) {
      this.warnings.push(`object stream ${stmNum} decode failed: ${(e as Error).message}`);
      return result;
    }
    const n = Number(this.resolve(stmObj.dict.entries.get('N')) ?? 0);
    const first = Number(this.resolve(stmObj.dict.entries.get('First')) ?? 0);
    // Header: N pairs of "<objNum> <offset>".
    const headLex = new Lexer(data, 0, first);
    const offsets: number[] = [];
    for (let i = 0; i < n; i++) {
      headLex.skipWs();
      headLex.readRegular(); // obj num (positional via index)
      headLex.skipWs();
      const off = Number(headLex.readRegular());
      offsets.push(off);
    }
    for (let i = 0; i < n; i++) {
      const start = first + offsets[i]!;
      const end = i + 1 < n ? first + offsets[i + 1]! : data.length;
      const objLex = new Lexer(data, start, end);
      const val = objLex.parseValue();
      if (val !== undefined) result.set(i, val);
    }
    return result;
  }

  private findLastStartxref(): number {
    const needle = 'startxref';
    const tailStart = Math.max(0, this.bytes.length - 2048);
    let idx = -1;
    for (let i = this.bytes.length - needle.length; i >= tailStart; i--) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (this.bytes[i + j] !== needle.charCodeAt(j)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return -1;
    const lex = new Lexer(this.bytes, idx + needle.length);
    lex.skipWs();
    return Number(lex.readRegular());
  }

  /**
   * Fallback: scan the whole file for "N G obj" headers and index them. Lets us
   * read PDFs with broken/absent xref. Also recovers the trailer Root.
   */
  private linearScan(): void {
    const bytes = this.bytes;
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    const text = latin1(bytes, 0, bytes.length);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const num = Number(m[1]);
      const offset = m.index;
      this.xref.set(num, { type: 1, field2: offset, field3: 0 });
    }
    // Find a trailer with /Root, else synthesize one by locating /Type /Catalog.
    if (!this.trailer || !this.getTrailerRoot()) {
      const tIdx = text.lastIndexOf('trailer');
      if (tIdx >= 0) {
        const lex = new Lexer(bytes, tIdx + 7);
        const td = lex.parseValue();
        if (td && isDict(td)) this.trailer = td;
      }
    }
    if (!this.trailer || !this.getTrailerRoot()) {
      // Locate the catalog object directly.
      for (const [num] of this.xref) {
        const obj = this.getObject(num);
        if (obj && isDict(obj)) {
          const type = obj.entries.get('Type');
          if (type && (type as { name?: string }).name === 'Catalog') {
            const synth: PdfDict = {
              kind: 'dict',
              entries: new Map<string, PdfValue>([['Root', { kind: 'ref', num, gen: 0 }]]),
            };
            this.trailer = synth;
            break;
          }
        }
      }
    }
  }

  getTrailerRoot(): PdfDict | undefined {
    if (!this.trailer) return undefined;
    const root = this.resolve(this.trailer.entries.get('Root'));
    return root && isDict(root) ? root : undefined;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

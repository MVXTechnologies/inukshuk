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
 * The reader never needs the whole file: it reads the tail (startxref/trailer),
 * the xref sections, and the handful of objects it dereferences. Callers hand
 * it either an in-memory `Uint8Array` (tests, small files) or a {@link
 * ByteSource} that serves slices on demand — a 200 MB GeoPDF is then parsed
 * with a few hundred KB resident instead of the whole file (#328).
 *
 * Everything is best-effort: callers should catch errors and degrade to warnings.
 */

// ---- byte sources -----------------------------------------------------------

/**
 * Random access to a PDF's bytes. `read` returns the bytes at `[offset,
 * offset + length)`; it may return fewer than `length` bytes at end of file.
 * Implementations are synchronous (the SDK 56 `FileHandle` is) and are asked
 * for at most a few hundred KB per call by the reader itself; a stream payload
 * is the only larger read and it is capped at {@link MAX_RAW_STREAM_BYTES}.
 */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Uint8Array;
}

/** A {@link ByteSource} over bytes already in memory. */
export function memoryByteSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: (offset, length) => bytes.subarray(offset, offset + length),
  };
}

function isByteSource(v: Uint8Array | ByteSource): v is ByteSource {
  return typeof (v as ByteSource).read === 'function';
}

/** Decode latin1 bytes to a JS string (1 byte = 1 code unit). */
function latin1FromArray(bytes: Uint8Array): string {
  // `fromCharCode` over blocks is far faster than per-byte concatenation and
  // stays well under any engine's argument-count limit.
  const BLOCK = 8192;
  if (bytes.length <= BLOCK) return String.fromCharCode(...bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i += BLOCK) {
    s += String.fromCharCode(...bytes.subarray(i, i + BLOCK));
  }
  return s;
}

/**
 * What the lexer and the xref/scan code read through: byte-at-a-time access
 * plus small latin1 peeks and bounded slices. Two implementations: a plain
 * array (in-memory files, decoded object streams) and an LRU of chunks over a
 * {@link ByteSource}.
 */
interface Bytes {
  readonly length: number;
  /** The byte at `i`, or undefined outside `[0, length)`. */
  byteAt(i: number): number | undefined;
  /** Bytes `[start, end)` as a latin1 string; `end` is clamped to `length`. */
  latin1(start: number, end: number): string;
  /** A copy or view of bytes `[start, end)`; `end` is clamped to `length`. */
  slice(start: number, end: number): Uint8Array;
}

class MemoryBytes implements Bytes {
  readonly length: number;
  constructor(private readonly bytes: Uint8Array) {
    this.length = bytes.length;
  }
  byteAt(i: number): number | undefined {
    return this.bytes[i];
  }
  latin1(start: number, end: number): string {
    return latin1FromArray(this.bytes.subarray(start, Math.min(end, this.length)));
  }
  slice(start: number, end: number): Uint8Array {
    return this.bytes.subarray(start, Math.min(end, this.length));
  }
}

/** Size of one cached chunk of a {@link ByteSource}. */
export const CHUNK_SIZE = 64 * 1024;
/** Chunks kept resident (LRU): 64 × 64 KB = 4 MB. */
export const MAX_RESIDENT_CHUNKS = 64;

/**
 * Chunked, LRU-cached view over a {@link ByteSource}. Sequential access inside
 * one chunk is a bounds check and an index; crossing into another chunk is a
 * map lookup or one `source.read`. Exported for its own unit tests only.
 */
export class ChunkedBytes implements Bytes {
  readonly length: number;
  private readonly chunks = new Map<number, Uint8Array>();
  private cur: Uint8Array = new Uint8Array(0);
  private curIndex = -1;

  constructor(private readonly source: ByteSource) {
    const size = Number(source.size);
    this.length = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
  }

  /** Chunks currently held (diagnostics/tests). */
  get residentChunks(): number {
    return this.chunks.size;
  }

  byteAt(i: number): number | undefined {
    if (i < 0 || i >= this.length) return undefined;
    const index = Math.floor(i / CHUNK_SIZE);
    if (index !== this.curIndex) this.load(index);
    return this.cur[i - index * CHUNK_SIZE];
  }

  private load(index: number): void {
    let chunk = this.chunks.get(index);
    if (chunk) {
      // Refresh recency: Map iterates in insertion order, oldest first.
      this.chunks.delete(index);
    } else {
      const start = index * CHUNK_SIZE;
      chunk = this.source.read(start, Math.min(CHUNK_SIZE, this.length - start));
    }
    this.chunks.set(index, chunk);
    if (this.chunks.size > MAX_RESIDENT_CHUNKS) {
      const oldest = this.chunks.keys().next().value;
      if (oldest !== undefined) this.chunks.delete(oldest);
    }
    this.cur = chunk;
    this.curIndex = index;
  }

  latin1(start: number, end: number): string {
    const stop = Math.min(end, this.length);
    let s = '';
    for (let i = Math.max(0, start); i < stop; i++) {
      const b = this.byteAt(i);
      if (b === undefined) break;
      s += String.fromCharCode(b);
    }
    return s;
  }

  slice(start: number, end: number): Uint8Array {
    const stop = Math.min(end, this.length);
    const from = Math.max(0, start);
    if (stop <= from) return new Uint8Array(0);
    // Bypass the chunk cache: slices are stream payloads and scan windows,
    // which would only churn the LRU.
    return this.source.read(from, stop - from);
  }
}

// ---- lexer --------------------------------------------------------------------

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
function isDigit(b: number | undefined): boolean {
  return b !== undefined && b >= 0x30 && b <= 0x39;
}

/**
 * Largest stream payload the reader will pull into memory. Only xref streams
 * and object streams are ever decoded — legitimately a few MB at most — while
 * a page's image stream can be 100+ MB; dereferencing one must not allocate
 * it (#328). Payloads are read lazily, so a stream object can be parsed and
 * inspected without touching its bytes.
 */
export const MAX_RAW_STREAM_BYTES = 8 * 1024 * 1024;

/** A stream whose payload is read from `buf` on first access to `raw`. */
function lazyStream(dict: PdfDict, buf: Bytes, start: number, end: number): PdfStream {
  let raw: Uint8Array | undefined;
  return {
    kind: 'stream',
    dict,
    get raw(): Uint8Array {
      if (raw === undefined) {
        if (end - start > MAX_RAW_STREAM_BYTES) {
          throw new Error(`stream payload exceeds size cap (${end - start} bytes)`);
        }
        raw = buf.slice(start, end);
      }
      return raw;
    },
  };
}

/**
 * A recursive-descent value parser over a byte buffer with a movable cursor.
 * Used both for the top-level object body and for object-stream contents.
 */
class Lexer {
  pos: number;
  constructor(
    readonly buf: Bytes,
    start = 0,
    readonly limit: number = buf.length,
  ) {
    this.pos = start;
  }

  skipWs(): void {
    const { buf, limit } = this;
    while (this.pos < limit) {
      const b = buf.byteAt(this.pos)!;
      if (b === 0x25) {
        // comment to end of line
        while (this.pos < limit && buf.byteAt(this.pos) !== 0x0a && buf.byteAt(this.pos) !== 0x0d) {
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
    const b = this.buf.byteAt(this.pos)!;

    if (b === 0x2f) return this.parseName();
    if (b === 0x28) return this.parseLiteralString();
    if (b === 0x5b) return this.parseArray();
    if (b === 0x3c) {
      if (this.buf.byteAt(this.pos + 1) === 0x3c) return this.parseDict();
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
    while (this.pos < this.limit && isRegular(this.buf.byteAt(this.pos)!)) this.pos++;
    return this.buf.latin1(start, this.pos);
  }

  parseName(): PdfValue {
    this.pos++; // slash
    let name = '';
    while (this.pos < this.limit) {
      const b = this.buf.byteAt(this.pos)!;
      if (isSpace(b) || isDelim(b)) break;
      if (b === 0x23 && this.pos + 2 < this.limit) {
        // #XX hex escape
        const hex = this.buf.latin1(this.pos + 1, this.pos + 3);
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
      const b = this.buf.byteAt(this.pos++)!;
      if (b === 0x5c) {
        const n = this.buf.byteAt(this.pos++)!;
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
    while (this.pos < this.limit && this.buf.byteAt(this.pos) !== 0x3e) {
      const b = this.buf.byteAt(this.pos++)!;
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
      if (this.buf.byteAt(this.pos) === 0x5d) {
        this.pos++;
        break;
      }
      const before = this.pos;
      const v = this.parseValue();
      if (v === undefined) {
        if (this.pos <= before) this.pos++;
        if (this.buf.byteAt(before) === 0x5d) break;
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
      if (this.buf.byteAt(this.pos) === 0x3e && this.buf.byteAt(this.pos + 1) === 0x3e) {
        this.pos += 2;
        break;
      }
      if (this.buf.byteAt(this.pos) !== 0x2f) {
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
    if (this.buf.latin1(this.pos, Math.min(this.pos + 6, this.limit)) === 'stream') {
      this.pos += 6;
      // skip CRLF or LF after the stream keyword
      if (this.buf.byteAt(this.pos) === 0x0d) this.pos++;
      if (this.buf.byteAt(this.pos) === 0x0a) this.pos++;
      const dataStart = this.pos;
      const lenVal = entries.get('Length');
      let dataEnd = -1;
      let afterEndstream = -1;
      if (typeof lenVal === 'number' && lenVal >= 0 && dataStart + lenVal <= this.limit) {
        dataEnd = dataStart + lenVal;
        // A declared length that lands on `endstream` is trusted outright, so
        // the payload (possibly a 100 MB image) is never scanned.
        const probe = this.buf.latin1(dataEnd, Math.min(dataEnd + 12, this.limit));
        const m = /^\s*endstream/.exec(probe);
        if (m) afterEndstream = dataEnd + m[0].length;
      }
      if (afterEndstream < 0) {
        // No usable /Length (absent, indirect, or wrong): search for the
        // marker. Bounded — a payload past the cap can't be read anyway.
        const es = this.indexOf(
          'endstream',
          dataStart,
          Math.min(this.limit, dataStart + MAX_RAW_STREAM_BYTES + 'endstream'.length),
        );
        if (dataEnd < 0) dataEnd = es >= 0 ? es : this.limit;
        afterEndstream = es >= 0 ? es + 'endstream'.length : dataEnd;
      }
      this.pos = afterEndstream;
      return lazyStream(dict, this.buf, dataStart, dataEnd);
    }
    this.pos = save;
    return dict;
  }

  /** Index of `needle` in `[from, to)`, or -1. */
  indexOf(needle: string, from: number, to: number = this.limit): number {
    const { buf } = this;
    const first = needle.charCodeAt(0);
    for (let i = from; i <= to - needle.length; i++) {
      if (buf.byteAt(i) !== first) continue;
      let ok = true;
      for (let j = 1; j < needle.length; j++) {
        if (buf.byteAt(i + j) !== needle.charCodeAt(j)) {
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

/**
 * Widest xref-stream field (/W entry) accepted, in bytes. Real files use 1–8
 * (offsets fit in 8); anything wider is malformed and would read past rows.
 */
const MAX_XREF_FIELD_BYTES = 8;

/** A usable xref-stream field width: an integer in [0, MAX_XREF_FIELD_BYTES]. */
function isXrefFieldWidth(v: number): boolean {
  return Number.isSafeInteger(v) && v >= 0 && v <= MAX_XREF_FIELD_BYTES;
}

/** A usable object number / entry count: a nonnegative safe integer. */
function isXrefCount(v: number): boolean {
  return Number.isSafeInteger(v) && v >= 0;
}

/** Streaming inflate with a hard output cap; throws once the cap is exceeded. */
function inflateBounded(raw: Uint8Array, zlibWrapped: boolean): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onData = (chunk: Uint8Array) => {
    total += chunk.length;
    if (total > MAX_DECODED_BYTES) throw new Error('decoded stream exceeds size cap');
    if (chunk.length > 0) chunks.push(chunk);
  };
  const inflater = zlibWrapped ? new Unzlib(onData) : new Inflate(onData);
  // fflate emits only after each push, so a single whole-stream push can
  // allocate far beyond the cap before onData runs. A 1 KiB compressed slice
  // bounds each DEFLATE expansion to roughly 1 MiB plus decoder state.
  const inputChunkSize = 1024;
  for (let start = 0; start < raw.length || start === 0; start += inputChunkSize) {
    const end = Math.min(start + inputChunkSize, raw.length);
    inflater.push(raw.subarray(start, end), end === raw.length);
  }
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

/** Window the linear-scan fallback reads at a time. */
export const SCAN_WINDOW = 256 * 1024;
/**
 * Extra bytes read past each window so an `N G obj` header (or `trailer`)
 * that begins inside the window is always seen whole. Far longer than any
 * plausible header.
 */
export const SCAN_OVERLAP = 64;

/**
 * The parsed PDF: a lazy object store keyed by object number. We resolve
 * objects on demand and memoize them.
 */
export class PdfDocument {
  private xref = new Map<number, XrefEntry>();

  /** Number of cross-reference entries collected (diagnostics/tests). */
  get xrefEntryCount(): number {
    return this.xref.size;
  }
  private cache = new Map<number, PdfValue>();
  private objStmCache = new Map<number, Map<number, PdfValue>>();
  readonly warnings: string[] = [];
  trailer: PdfDict | undefined;

  private constructor(private readonly buf: Bytes) {}

  /**
   * Parse a PDF from bytes in memory or from a random-access {@link
   * ByteSource}. With a source, only the tail, the xref sections and the
   * objects actually dereferenced are ever read.
   */
  static parse(input: Uint8Array | ByteSource): PdfDocument {
    const doc = new PdfDocument(
      isByteSource(input) ? new ChunkedBytes(input) : new MemoryBytes(input),
    );
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
    if (offset < 0 || offset >= this.buf.length) return undefined;
    const lex = new Lexer(this.buf, offset);
    lex.skipWs();
    const n = lex.readRegular();
    lex.skipWs();
    lex.readRegular(); // gen
    lex.skipWs();
    const kw = lex.readRegular();
    if (kw !== 'obj') {
      // offset may be off; try a small forward search for "obj".
      const needle = `${expectNum} `;
      const at = lex.indexOf(
        needle,
        offset,
        Math.min(this.buf.length, offset + 64 + needle.length),
      );
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
    while (offset >= 0 && offset < this.buf.length && !visited.has(offset)) {
      visited.add(offset);
      const next = this.readXrefSection(offset);
      offset = next;
    }
  }

  /** Returns the /Prev offset to follow, or -1 when done. */
  private readXrefSection(offset: number): number {
    const lex = new Lexer(this.buf, offset);
    lex.skipWs();
    const kw = this.buf.latin1(lex.pos, lex.pos + 4);
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
      const peek = this.buf.latin1(lex.pos, lex.pos + 7);
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
      const maxEntries = Math.max(0, Math.floor((this.buf.length - lex.pos) / 20));
      const count = Math.min(Number(countStr), maxEntries);
      lex.skipWs();
      for (let i = 0; i < count; i++) {
        const line = this.buf.latin1(lex.pos, lex.pos + 20);
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
    if (!isArray(wVal)) return -1;
    const w = (wVal as PdfArray).map((x) => Number(x));
    const w0 = w[0];
    const w1 = w[1];
    const w2 = w[2];
    // Exactly three nonnegative integer byte widths with a positive row length.
    // /W [0 0 0] would advance the row cursor by 0 bytes forever; a fractional
    // width (/W [0 0.0001 0]) advanced it by a fraction and minted thousands of
    // entries from a single decoded byte; NaN/negative/oversized widths index
    // outside the buffer. None of these may drive the row loop.
    if (
      w.length !== 3 ||
      w0 === undefined ||
      w1 === undefined ||
      w2 === undefined ||
      !isXrefFieldWidth(w0) ||
      !isXrefFieldWidth(w1) ||
      !isXrefFieldWidth(w2) ||
      w0 + w1 + w2 <= 0
    ) {
      this.warnings.push(`xref stream has invalid /W [${w.join(' ')}]`);
      return -1;
    }
    const rowLen = w0 + w1 + w2;

    // /Size and /Index (object-number ranges) must be nonnegative integers;
    // /Index must hold [start count] pairs.
    const sizeVal = dict.entries.get('Size');
    if (sizeVal !== undefined && !isXrefCount(Number(sizeVal))) {
      this.warnings.push(`xref stream has invalid /Size ${String(sizeVal)}`);
      return -1;
    }
    const indexVal = dict.entries.get('Index');
    let index: number[] | undefined;
    if (indexVal !== undefined) {
      const raw = isArray(indexVal) ? (indexVal as PdfArray).map((x) => Number(x)) : [];
      if (raw.length === 0 || raw.length % 2 !== 0 || !raw.every(isXrefCount)) {
        this.warnings.push(`xref stream has invalid /Index [${raw.join(' ')}]`);
        return -1;
      }
      index = raw;
    }

    let data: Uint8Array;
    try {
      data = this.decodeStream(stream);
    } catch (e) {
      this.warnings.push(`xref stream decode failed: ${(e as Error).message}`);
      return -1;
    }

    // Index pairs default to [0, Size] (or to what the data can hold).
    if (index === undefined) {
      index = [0, sizeVal === undefined ? Math.floor(data.length / rowLen) : Number(sizeVal)];
    }

    const readField = (buf: Uint8Array, p: number, len: number): number => {
      let v = 0;
      for (let i = 0; i < len; i++) v = v * 256 + buf[p + i]!;
      return v;
    };

    // The total work is bounded by the decoded bytes, whatever /Index and
    // /Size claim: each entry consumes one complete row.
    let budget = Math.floor(data.length / rowLen);
    let p = 0;
    for (let s = 0; s + 1 < index.length && budget > 0; s += 2) {
      const startObj = index[s]!;
      const count = index[s + 1]!;
      for (let i = 0; i < count && budget > 0; i++, budget--) {
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
    // Validate metadata before allocating the previous-row buffer. The
    // encoded data must contain complete rows, including their filter bytes.
    if (
      !Number.isInteger(predictor) ||
      predictor < 10 ||
      predictor > 15 ||
      !Number.isSafeInteger(colors) ||
      colors < 1 ||
      ![1, 2, 4, 8, 16].includes(bpc) ||
      !Number.isSafeInteger(columns) ||
      columns < 1 ||
      !Number.isSafeInteger(rowLen) ||
      rowLen < 1 ||
      rowLen > MAX_DECODED_BYTES ||
      (data.length > 0 && rowLen + 1 > data.length) ||
      data.length % (rowLen + 1) !== 0
    ) {
      throw new Error('invalid predictor row dimensions');
    }
    if (data.length === 0) return data;
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
    // Each header pair requires at least "1 0" plus a separator between
    // pairs, and each object body needs at least one byte. Never trust /N or
    // /First as a loop/allocation bound independent of the decoded bytes.
    if (
      !Number.isSafeInteger(n) ||
      n < 0 ||
      !Number.isSafeInteger(first) ||
      first < 0 ||
      first > data.length ||
      n > Math.floor((first + 1) / 4) ||
      n > data.length - first
    ) {
      this.warnings.push(`object stream ${stmNum} has invalid header bounds`);
      return result;
    }
    const bytes = new MemoryBytes(data);
    // Header: N pairs of "<objNum> <offset>".
    const headLex = new Lexer(bytes, 0, first);
    const offsets: number[] = [];
    for (let i = 0; i < n; i++) {
      headLex.skipWs();
      const objNum = headLex.readRegular(); // positional via index
      headLex.skipWs();
      const offset = headLex.readRegular();
      const off = Number(offset);
      const previous = offsets[i - 1];
      if (
        !/^\d+$/.test(objNum) ||
        !Number.isSafeInteger(Number(objNum)) ||
        Number(objNum) < 1 ||
        !/^\d+$/.test(offset) ||
        !Number.isSafeInteger(off) ||
        off < 0 ||
        off >= data.length - first ||
        (previous !== undefined && off <= previous)
      ) {
        this.warnings.push(`object stream ${stmNum} has invalid header offsets`);
        return result;
      }
      offsets.push(off);
    }
    for (let i = 0; i < n; i++) {
      const start = first + offsets[i]!;
      const end = i + 1 < n ? first + offsets[i + 1]! : data.length;
      const objLex = new Lexer(bytes, start, end);
      const val = objLex.parseValue();
      if (val !== undefined) result.set(i, val);
    }
    return result;
  }

  private findLastStartxref(): number {
    const needle = 'startxref';
    const tailStart = Math.max(0, this.buf.length - 2048);
    let idx = -1;
    for (let i = this.buf.length - needle.length; i >= tailStart; i--) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (this.buf.byteAt(i + j) !== needle.charCodeAt(j)) {
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
    const lex = new Lexer(this.buf, idx + needle.length);
    lex.skipWs();
    return Number(lex.readRegular());
  }

  /**
   * Fallback: scan the whole file for "N G obj" headers and index them. Lets us
   * read PDFs with broken/absent xref. Also recovers the trailer Root.
   *
   * The scan walks the file in {@link SCAN_WINDOW} slices (each read once,
   * with a {@link SCAN_OVERLAP} tail so a header straddling two windows is
   * seen whole by the first), so even a 200 MB file costs one window of
   * memory at a time.
   */
  private linearScan(): void {
    const total = this.buf.length;
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let lastTrailer = -1;
    for (let start = 0; start < total; start += SCAN_WINDOW) {
      const text = latin1FromArray(this.buf.slice(start, start + SCAN_WINDOW + SCAN_OVERLAP));
      // A match must BEGIN inside the window proper; the overlap only completes it.
      const accept = Math.min(SCAN_WINDOW, text.length);
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m.index >= accept) break;
        // Digits at the very start that continue a digit run from the previous
        // window are the tail of a header that window already recorded.
        if (m.index === 0 && start > 0 && isDigit(this.buf.byteAt(start - 1))) continue;
        this.xref.set(Number(m[1]), { type: 1, field2: start + m.index, field3: 0 });
      }
      let t = text.indexOf('trailer');
      while (t >= 0 && t < accept) {
        lastTrailer = start + t;
        t = text.indexOf('trailer', t + 1);
      }
    }
    // Find a trailer with /Root, else synthesize one by locating /Type /Catalog.
    if ((!this.trailer || !this.getTrailerRoot()) && lastTrailer >= 0) {
      const lex = new Lexer(this.buf, lastTrailer + 7);
      const td = lex.parseValue();
      if (td && isDict(td)) this.trailer = td;
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

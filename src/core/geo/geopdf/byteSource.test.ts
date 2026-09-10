import { parseGeoPdf } from './parseGeoPdf';
import {
  type ByteSource,
  CHUNK_SIZE,
  ChunkedBytes,
  MAX_RAW_STREAM_BYTES,
  MAX_RESIDENT_CHUNKS,
  PdfDocument,
  SCAN_OVERLAP,
  SCAN_WINDOW,
  memoryByteSource,
} from './pdfReader';
import { buildClassicPdf, latin1Bytes } from './testUtils';
import { type PdfDict, type PdfStream, isStream } from './types';

/**
 * The reader over a random-access {@link ByteSource} (#328): it must touch only
 * the tail, the xref and the objects it dereferences — never the page's image
 * stream — and the linear-scan fallback must walk the file in bounded windows.
 */

interface Recorded {
  source: ByteSource;
  reads: { offset: number; length: number }[];
  bytesRead(): number;
  maxRead(): number;
}

/** A source over in-memory bytes that records every read. */
function recordingSource(bytes: Uint8Array): Recorded {
  const reads: { offset: number; length: number }[] = [];
  const inner = memoryByteSource(bytes);
  return {
    reads,
    source: {
      size: inner.size,
      read(offset, length) {
        const out = inner.read(offset, length);
        reads.push({ offset, length: out.length });
        return out;
      },
    },
    bytesRead: () => reads.reduce((n, r) => n + r.length, 0),
    maxRead: () => reads.reduce((n, r) => Math.max(n, r.length), 0),
  };
}

const CATALOG = '<< /Type /Catalog /Pages 2 0 R >>';
const PAGES = (kid: number) => `<< /Type /Pages /Kids [${kid} 0 R] /Count 1 >>`;
const PAGE = (contents: number) =>
  `<< /Type /Page /MediaBox [0 0 50 50] /Contents ${contents} 0 R /LGIDict ` +
  '<< /Projection << /ProjectionType /GEOGRAPHIC >> ' +
  '/Registration [ [ (0) (0) (5) (50) ] [ (50) (0) (6) (50) ] ' +
  '[ (50) (50) (6) (51) ] [ (0) (50) (5) (51) ] ] >> >>';
const EMPTY_STREAM = '<< /Length 0 >>\nstream\n\nendstream';

/** A classic-xref PDF whose page content stream is `payloadBytes` of NULs. */
function bigImagePdf(payloadBytes: number): Uint8Array {
  const payload = String.fromCharCode(0).repeat(payloadBytes);
  return buildClassicPdf(
    [CATALOG, PAGES(3), PAGE(4), `<< /Length ${payloadBytes} >>\nstream\n${payload}\nendstream`],
    1,
  );
}

const typeName = (v: unknown): string | undefined =>
  ((v as PdfDict | undefined)?.entries.get('Type') as { name?: string } | undefined)?.name;

describe('parseGeoPdf over a ByteSource', () => {
  it('reads only the tail, xref and referenced objects of a file with a big image stream', () => {
    const bytes = bigImagePdf(8 * 1024 * 1024);
    const rec = recordingSource(bytes);
    const streamed = parseGeoPdf(rec.source);
    const inMemory = parseGeoPdf(bytes);

    expect(streamed).toEqual(inMemory);
    expect(streamed.pageCount).toBe(1);
    expect(streamed.georeferences).toHaveLength(1);
    expect(streamed.georeferences[0]!.viewport.corners.topLeft).toEqual([5, 51]);
    expect(streamed.warnings).toEqual([]);

    // The 8 MB payload is never read: the objects live in the first chunk, the
    // xref/trailer in the last.
    expect(rec.bytesRead()).toBeLessThan(bytes.length * 0.05);
    expect(rec.bytesRead()).toBeLessThanOrEqual(3 * CHUNK_SIZE);
    expect(rec.maxRead()).toBeLessThanOrEqual(CHUNK_SIZE);
  });

  it('gives the same result as the in-memory path for a memoryByteSource', () => {
    const bytes = buildClassicPdf([CATALOG, PAGES(3), PAGE(4), EMPTY_STREAM], 1);
    expect(parseGeoPdf(memoryByteSource(bytes))).toEqual(parseGeoPdf(bytes));
  });

  it('parses a stream object without reading its payload until `raw` is touched', () => {
    const bytes = bigImagePdf(2 * CHUNK_SIZE);
    const rec = recordingSource(bytes);
    const doc = PdfDocument.parse(rec.source);
    const before = rec.bytesRead();
    const stream = doc.getObject(4);
    expect(isStream(stream)).toBe(true);
    const dictOnly = rec.bytesRead();
    // Parsing the dict (first chunk) and probing `endstream` after /Length
    // (one chunk near the end) — not the payload in between.
    expect(dictOnly - before).toBeLessThanOrEqual(2 * CHUNK_SIZE);
    expect((stream as PdfStream).raw).toHaveLength(2 * CHUNK_SIZE);
    expect(rec.bytesRead() - dictOnly).toBe(2 * CHUNK_SIZE);
    // Cached: a second access reads nothing more.
    expect((stream as PdfStream).raw).toHaveLength(2 * CHUNK_SIZE);
    expect(rec.bytesRead() - dictOnly).toBe(2 * CHUNK_SIZE);
  });

  it('refuses to materialise a stream payload above the cap', () => {
    const size = MAX_RAW_STREAM_BYTES + 1024;
    const bytes = bigImagePdf(size);
    const doc = PdfDocument.parse(memoryByteSource(bytes));
    const stream = doc.getObject(4);
    expect(isStream(stream)).toBe(true);
    expect(() => (stream as PdfStream).raw).toThrow(/size cap/);
    expect(() => doc.decodeStream(stream as PdfStream)).toThrow(/size cap/);
    // Georeferencing never needed that stream, so the parse is still clean.
    expect(parseGeoPdf(memoryByteSource(bytes)).georeferences).toHaveLength(1);
  });

  it('finds `endstream` by search when /Length is indirect, without over-reading', () => {
    const payload = 'ABCDEFGHIJ';
    const bytes = buildClassicPdf(
      [CATALOG, PAGES(3), PAGE(4), `<< /Length 5 0 R >>\nstream\n${payload}\nendstream`, '10'],
      1,
    );
    const doc = PdfDocument.parse(memoryByteSource(bytes));
    const stream = doc.getObject(4);
    expect(isStream(stream)).toBe(true);
    expect(String.fromCharCode(...(stream as PdfStream).raw)).toBe(`${payload}\n`);
  });

  it('tolerates a source that shrinks (short reads) without throwing', () => {
    const bytes = buildClassicPdf([CATALOG, PAGES(3), PAGE(4), EMPTY_STREAM], 1);
    const lying: ByteSource = {
      size: bytes.length + 5000,
      read: (offset, length) => bytes.subarray(offset, offset + length),
    };
    const res = parseGeoPdf(lying);
    expect(res.pageCount).toBe(1);
  });
});

describe('linear-scan fallback over a ByteSource', () => {
  /**
   * Build a PDF with NO xref where object headers straddle window boundaries:
   *   - "3 0 obj" split as "3 |0 obj" at the first boundary,
   *   - "12 0 obj" split as "1|2 0 obj" at the second — a naive scanner would
   *     record a bogus object 2 there and clobber the real /Pages node.
   * Padding is PDF comments (never match the header regex).
   */
  function straddlingPdf(withTrailer: boolean): Uint8Array {
    let s = '%PDF-1.7\n';
    const padTo = (target: number) => {
      const need = target - s.length;
      if (need < 2) throw new Error('layout: padding too small');
      s += `%${'x'.repeat(need - 2)}\n`;
    };
    s += `1 0 obj\n${CATALOG}\nendobj\n`;
    s += `2 0 obj\n${PAGES(12)}\nendobj\n`;
    padTo(SCAN_WINDOW - 2); // "3 " before the boundary, "0 obj" after
    s += `3 0 obj\n${EMPTY_STREAM}\nendobj\n`;
    padTo(2 * SCAN_WINDOW - 1); // "1" before the boundary, "2 0 obj" after
    s += `12 0 obj\n${PAGE(3)}\nendobj\n`;
    if (withTrailer) s += 'trailer\n<< /Root 1 0 R >>\nstartxref\n999999999\n%%EOF\n';
    return latin1Bytes(s);
  }

  it.each([true, false])('finds headers split across windows (trailer: %s)', (withTrailer) => {
    const bytes = straddlingPdf(withTrailer);
    const rec = recordingSource(bytes);
    const res = parseGeoPdf(rec.source);
    expect(res.pageCount).toBe(1);
    expect(res.georeferences).toHaveLength(1);
    expect(res.georeferences[0]!.viewport.corners.topLeft).toEqual([5, 51]);
    // Windowed: no single read may approach the file size.
    expect(rec.maxRead()).toBeLessThanOrEqual(SCAN_WINDOW + SCAN_OVERLAP);
    expect(parseGeoPdf(bytes)).toEqual(res);
  });

  it('indexes every straddling header at its true offset', () => {
    const bytes = straddlingPdf(false);
    const doc = PdfDocument.parse(recordingSource(bytes).source);
    expect(doc.xrefEntryCount).toBe(4);
    expect(typeName(doc.getObject(1))).toBe('Catalog');
    expect(typeName(doc.getObject(2))).toBe('Pages');
    expect(isStream(doc.getObject(3))).toBe(true);
    expect(typeName(doc.getObject(12))).toBe('Page');
  });
});

describe('ChunkedBytes', () => {
  /** A synthetic source: byte i has value (i / CHUNK_SIZE) & 0xff; records reads. */
  function syntheticSource(chunks: number) {
    const reads: number[] = [];
    const size = chunks * CHUNK_SIZE;
    const source: ByteSource = {
      size,
      read(offset, length) {
        reads.push(offset);
        const out = new Uint8Array(Math.min(length, size - offset));
        out.fill(Math.floor(offset / CHUNK_SIZE) & 0xff);
        return out;
      },
    };
    return { source, reads };
  }

  it('keeps at most MAX_RESIDENT_CHUNKS chunks and evicts least-recently used', () => {
    const total = MAX_RESIDENT_CHUNKS + 40;
    const { source, reads } = syntheticSource(total);
    const bytes = new ChunkedBytes(source);
    expect(bytes.length).toBe(total * CHUNK_SIZE);
    for (let c = 0; c < total; c++) {
      expect(bytes.byteAt(c * CHUNK_SIZE + 7)).toBe(c & 0xff);
    }
    expect(reads).toHaveLength(total);
    expect(bytes.residentChunks).toBe(MAX_RESIDENT_CHUNKS);

    // The most recent chunks are still resident: no new read.
    bytes.byteAt((total - 1) * CHUNK_SIZE);
    bytes.byteAt((total - MAX_RESIDENT_CHUNKS) * CHUNK_SIZE);
    expect(reads).toHaveLength(total);
    // Chunk 0 was evicted long ago: one more read.
    expect(bytes.byteAt(3)).toBe(0);
    expect(reads).toHaveLength(total + 1);
    // ...and touching it refreshed it, so the next evictions take the oldest
    // untouched chunks, not chunk 0.
    bytes.byteAt(1 * CHUNK_SIZE);
    bytes.byteAt(2 * CHUNK_SIZE);
    expect(reads).toHaveLength(total + 3);
    expect(bytes.byteAt(5)).toBe(0);
    expect(reads).toHaveLength(total + 3);
    expect(bytes.residentChunks).toBe(MAX_RESIDENT_CHUNKS);
  });

  it('answers out-of-range and clamped requests without reading', () => {
    const { source, reads } = syntheticSource(2);
    const bytes = new ChunkedBytes(source);
    expect(bytes.byteAt(-1)).toBeUndefined();
    expect(bytes.byteAt(bytes.length)).toBeUndefined();
    expect(bytes.slice(bytes.length, bytes.length + 10)).toHaveLength(0);
    expect(bytes.slice(5, 3)).toHaveLength(0);
    expect(bytes.latin1(bytes.length + 1, bytes.length + 50)).toBe('');
    expect(reads).toHaveLength(0);
    // Slices bypass the chunk cache and clamp to the file size.
    expect(bytes.slice(bytes.length - 3, bytes.length + 99)).toHaveLength(3);
    expect(reads).toHaveLength(1);
    expect(bytes.residentChunks).toBe(0);
    // latin1 clamps to the file and stops at a short chunk.
    expect(bytes.latin1(bytes.length - 2, bytes.length + 50)).toHaveLength(2);
    expect(bytes.residentChunks).toBe(1);
  });

  it('stops a latin1 peek where a shrunken source runs out of bytes', () => {
    const source: ByteSource = { size: 100, read: () => new Uint8Array(0) };
    const bytes = new ChunkedBytes(source);
    expect(bytes.latin1(0, 10)).toBe('');
    expect(bytes.byteAt(50)).toBeUndefined();
  });

  it('treats a nonsensical size as empty', () => {
    const bytes = new ChunkedBytes({ size: Number.NaN, read: () => new Uint8Array(0) });
    expect(bytes.length).toBe(0);
    expect(bytes.byteAt(0)).toBeUndefined();
    const doc = PdfDocument.parse({ size: -5, read: () => new Uint8Array(0) });
    expect(doc.getTrailerRoot()).toBeUndefined();
  });
});

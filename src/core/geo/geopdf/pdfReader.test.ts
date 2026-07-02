import { zlibSync } from 'fflate';
import { parseGeoPdf } from './parseGeoPdf';
import { PdfDocument } from './pdfReader';
import { type PdfStream, isStream } from './types';
import { buildClassicPdf, latin1Bytes } from './testUtils';

/**
 * Directly exercise the low-level reader paths that the higher-level tests do
 * not reach: linear-scan recovery (broken/absent xref), the PNG predictor in an
 * xref stream, and hex-string registration values.
 */

describe('pdfReader — linear scan fallback', () => {
  it('recovers objects when the xref table is absent', () => {
    // Build a PDF with valid objects but NO xref/trailer/startxref — forces the
    // linear scan and catalog auto-discovery.
    const header = '%PDF-1.7\n';
    const objs = [
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
      '3 0 obj\n<< /Type /Page /MediaBox [0 0 50 50] /LGIDict ' +
        '<< /Projection << /ProjectionType /GEOGRAPHIC >> ' +
        '/Registration [ [ (0) (0) (5) (50) ] [ (50) (0) (6) (50) ] ' +
        '[ (50) (50) (6) (51) ] [ (0) (50) (5) (51) ] ] >> >>\nendobj\n',
    ];
    const bytes = latin1Bytes(header + objs.join(''));
    const res = parseGeoPdf(bytes);
    expect(res.pageCount).toBe(1);
    expect(res.georeferences).toHaveLength(1);
    expect(res.georeferences[0]!.viewport.corners.topLeft).toEqual([5, 51]);
  });

  it('recovers from a trailer that points at a missing xref offset', () => {
    // startxref points to a bogus offset; buildXref fails -> linear scan kicks in.
    const header = '%PDF-1.7\n';
    const body =
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /MediaBox [0 0 10 10] >>\nendobj\n';
    const tail = 'trailer\n<< /Root 1 0 R >>\nstartxref\n999999\n%%EOF';
    const res = parseGeoPdf(latin1Bytes(header + body + tail));
    expect(res.pageCount).toBe(1);
    expect(res.georeferences).toHaveLength(0);
  });
});

describe('pdfReader — hex string registration', () => {
  it('parses <...> hex string control point values', () => {
    // "0" = <30>, "50" = <3530>, "5" = <35>, "51" = <3531>, "6" = <36>
    const header = '%PDF-1.7\n';
    const body =
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /MediaBox [0 0 50 50] /LGIDict ' +
      '<< /Projection << /ProjectionType /GEOGRAPHIC >> ' +
      '/Registration [ [ <30> <30> <35> <3530> ] [ <3530> <30> <36> <3530> ] ' +
      '[ <30> <3530> <35> <3531> ] ] >> >>\nendobj\n';
    const res = parseGeoPdf(latin1Bytes(header + body));
    expect(res.georeferences).toHaveLength(1);
    const c = res.georeferences[0]!.viewport.corners;
    // top-left page (0,50) -> (5,51)
    expect(c.topLeft[0]).toBeCloseTo(5, 6);
    expect(c.topLeft[1]).toBeCloseTo(51, 6);
  });
});

describe('pdfReader — PNG-predicted xref stream', () => {
  it('decodes a /Predictor 12 (PNG up) xref stream', () => {
    // Objects 1..3 in an ObjStm (obj 4); xref stream (obj 5) uses PNG predictor.
    const objs: Record<number, string> = {
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      3:
        '<< /Type /Page /MediaBox [0 0 100 100] /LGIDict ' +
        '<< /Projection << /ProjectionType /GEOGRAPHIC >> ' +
        '/Registration [ [ (0) (0) (0) (0) ] [ (100) (0) (1) (0) ] [ (0) (100) (0) (1) ] ] >> >>',
    };
    const order = [1, 2, 3];
    let bodies = '';
    const offsets: number[] = [];
    for (const n of order) {
      offsets.push(bodies.length);
      bodies += objs[n] + ' ';
    }
    let head = '';
    for (let i = 0; i < order.length; i++) head += `${order[i]} ${offsets[i]} `;
    const first = head.length;
    const objStmData = head + bodies;
    const objStmComp = zlibSync(latin1Bytes(objStmData));

    const prefix = '%PDF-1.7\n';
    const objStmOffset = prefix.length;
    const objStmDict =
      `4 0 obj\n<< /Type /ObjStm /N ${order.length} /First ${first} ` +
      `/Filter /FlateDecode /Length ${objStmComp.length} >>\nstream\n`;
    const beforeStream = latin1Bytes(prefix + objStmDict);
    const afterStream = latin1Bytes('\nendstream\nendobj\n');
    const xrefOffset = beforeStream.length + objStmComp.length + afterStream.length;

    // Build raw xref rows (W = [1 2 1]) then PNG-encode with filter type 2 (up).
    const W = [1, 2, 1];
    const rowLen = W[0]! + W[1]! + W[2]!;
    const entries: [number, number, number][] = [
      [0, 0, 0],
      [2, 4, 0],
      [2, 4, 1],
      [2, 4, 2],
      [1, objStmOffset, 0],
      [1, xrefOffset, 0],
    ];
    const raw = new Uint8Array(entries.length * rowLen);
    let p = 0;
    for (const [t, f2, f3] of entries) {
      raw[p++] = t;
      raw[p++] = (f2 >> 8) & 0xff;
      raw[p++] = f2 & 0xff;
      raw[p++] = f3;
    }
    // PNG-encode: prepend filter-type byte (2 = up) per row, with up-prediction.
    const predicted = new Uint8Array(entries.length * (rowLen + 1));
    let prevRow = new Uint8Array(rowLen);
    for (let r = 0; r < entries.length; r++) {
      const base = r * (rowLen + 1);
      predicted[base] = 2; // up
      for (let i = 0; i < rowLen; i++) {
        const cur = raw[r * rowLen + i]!;
        predicted[base + 1 + i] = (cur - prevRow[i]!) & 0xff;
      }
      prevRow = raw.slice(r * rowLen, r * rowLen + rowLen);
    }
    const xrefComp = zlibSync(predicted);
    const xrefDict =
      `5 0 obj\n<< /Type /XRef /Size ${entries.length} /Root 1 0 R ` +
      `/W [1 2 1] /Filter /FlateDecode /Length ${xrefComp.length} ` +
      `/DecodeParms << /Predictor 12 /Columns ${rowLen} /Colors 1 /BitsPerComponent 8 >> >>\nstream\n`;
    const xrefBefore = latin1Bytes(xrefDict);
    const xrefAfter = latin1Bytes('\nendstream\nendobj\n');
    const startxref = latin1Bytes(`startxref\n${xrefOffset}\n%%EOF`);

    const chunks = [
      beforeStream,
      objStmComp,
      afterStream,
      xrefBefore,
      xrefComp,
      xrefAfter,
      startxref,
    ];
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }

    const res = parseGeoPdf(out);
    expect(res.pageCount).toBe(1);
    expect(res.georeferences).toHaveLength(1);
    expect(res.georeferences[0]!.source).toBe('lgidict');
  });
});

describe('pdfReader — hostile input hardening', () => {
  it('does not freeze on a classic xref with an absurd subsection count', () => {
    // A crafted "0 9999999999" subsection used to spin the entry loop ~1e10
    // times on the JS thread. The clamp bounds it by the actual file size.
    const head = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n';
    const pdf =
      head +
      `xref\n0 9999999999\ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${head.length}\n%%EOF`;
    const res = parseGeoPdf(latin1Bytes(pdf));
    expect(res.pageCount).toBeGreaterThanOrEqual(0);
  });

  it('does not freeze on an xref stream with /W [0 0 0]', () => {
    // rowLen 0 used to advance the row cursor by 0 bytes forever.
    const head = '%PDF-1.7\n';
    const obj =
      '1 0 obj\n<< /Type /XRef /W [0 0 0] /Size 4 /Length 4 >>\nstream\nAAAA\nendstream\nendobj\n';
    const pdf = head + obj + `startxref\n${head.length}\n%%EOF`;
    const doc = PdfDocument.parse(latin1Bytes(pdf));
    expect(doc.warnings.join('\n')).toContain('invalid /W');
  });

  it('rejects a FlateDecode decompression bomb instead of inflating it', () => {
    // A few-KB zlib stream that inflates to 80 MB must throw at the 64 MB cap,
    // not OOM the app.
    const bomb = zlibSync(new Uint8Array(80 * 1024 * 1024));
    let body = '';
    for (let i = 0; i < bomb.length; i++) body += String.fromCharCode(bomb[i]!);
    const doc = PdfDocument.parse(
      buildClassicPdf(
        [`<< /Length ${bomb.length} /Filter /FlateDecode >>\nstream\n${body}\nendstream`],
        1,
      ),
    );
    const stream = doc.getObject(1);
    expect(isStream(stream)).toBe(true);
    expect(() => doc.decodeStream(stream as PdfStream)).toThrow(/size cap/);
  });

  it('rejects an implausibly long /Filter chain (stacked-bomb multiplier)', () => {
    const doc = PdfDocument.parse(
      buildClassicPdf(
        ['<< /Length 4 /Filter [/Fl /Fl /Fl /Fl /Fl] >>\nstream\nAAAA\nendstream'],
        1,
      ),
    );
    const stream = doc.getObject(1);
    expect(isStream(stream)).toBe(true);
    expect(() => doc.decodeStream(stream as PdfStream)).toThrow(/filter chain/);
  });
});

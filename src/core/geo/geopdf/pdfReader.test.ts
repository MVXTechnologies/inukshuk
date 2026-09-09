import { Inflate, Unzlib, deflateSync, zlibSync } from 'fflate';
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

describe('pdfReader — bounded stream work', () => {
  it.each([true, false])(
    'limits each inflate callback before the total cap (zlib: %s)',
    (wrapped) => {
      const payload = new Uint8Array(8 * 1024 * 1024);
      const raw = wrapped ? zlibSync(payload) : deflateSync(payload);
      const prototype = wrapped ? Unzlib.prototype : Inflate.prototype;
      const push = prototype.push;
      let largestOutput = 0;
      const spy = jest.spyOn(prototype, 'push').mockImplementation(function (
        this: Inflate | Unzlib,
        chunk: Uint8Array,
        final?: boolean,
      ) {
        const ondata = this.ondata;
        this.ondata = (data, done) => {
          largestOutput = Math.max(largestOutput, data.length);
          ondata(data, done);
        };
        try {
          push.call(this, chunk, final);
        } finally {
          this.ondata = ondata;
        }
      });
      try {
        const doc = PdfDocument.parse(new Uint8Array());
        const decoded = doc.decodeStream({
          kind: 'stream',
          raw,
          dict: {
            kind: 'dict',
            entries: new Map([['Filter', { kind: 'name', name: 'FlateDecode' }]]),
          },
        });
        expect(decoded).toHaveLength(payload.length);
        expect(decoded.every((value) => value === 0)).toBe(true);
        expect(largestOutput).toBeLessThan(2 * 1024 * 1024);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each([1000000, -1, 0, NaN, Infinity, 0.5])(
    'rejects unsafe predictor columns %s',
    (columns) => {
      const doc = PdfDocument.parse(new Uint8Array());
      const stream: PdfStream = {
        kind: 'stream',
        raw: zlibSync(new Uint8Array([0, 1])),
        dict: {
          kind: 'dict',
          entries: new Map([
            ['Filter', { kind: 'name', name: 'FlateDecode' }],
            [
              'DecodeParms',
              {
                kind: 'dict',
                entries: new Map([
                  ['Predictor', 12],
                  ['Columns', columns],
                ]),
              },
            ],
          ]),
        },
      };
      expect(() => doc.decodeStream(stream)).toThrow(/predictor/);
    },
  );

  it.each([
    [10000, 4, '2 0 null '],
    [1, 1000, '2 0 null '],
    [2, 8, '2 0 4 0 null '],
    [1, 4, '2 x null '],
  ])('rejects malformed object-stream headers (%s, %s)', (count, first, data) => {
    const prefix = '%PDF-1.7\n';
    const object = `1 0 obj\n<< /Type /ObjStm /N ${count} /First ${first} /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`;
    const offset = prefix.length + object.length;
    const rows = String.fromCharCode(
      1,
      0,
      prefix.length,
      0,
      2,
      0,
      1,
      0,
      1,
      offset >> 8,
      offset & 255,
      0,
    );
    const pdf =
      prefix +
      object +
      '3 0 obj\n<< /Type /XRef /W [1 2 1] /Index [1 3] /Root 2 0 R /Length 12 >>\nstream\n' +
      rows +
      '\nendstream\nendobj\nstartxref\n' +
      offset +
      '\n%%EOF';
    const doc = PdfDocument.parse(latin1Bytes(pdf));
    expect(doc.warnings.join(' ')).toMatch(/object stream.*header/);
    expect(doc.getObject(2)).toBeUndefined();
  });
});

describe('pdfReader — xref stream metadata validation (audit A14)', () => {
  /**
   * A two-object file: a Catalog at byte 9 (so a one-byte offset field of
   * `\t` = 9 resolves it) and an xref stream carrying `dictExtras` over `data`.
   * With a resolvable /Root the linear-scan fallback stays out of the count;
   * when the stream is rejected the scan registers at most the 2 real objects.
   */
  function xrefStreamPdf(dictExtras: string, data = '\t'): Uint8Array {
    const head = '%PDF-1.7\n';
    const catalog = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
    const xrefOffset = head.length + catalog.length;
    const obj =
      `2 0 obj\n<< /Type /XRef /Root 1 0 R ${dictExtras} /Length ${data.length} >>\n` +
      `stream\n${data}\nendstream\nendobj\n`;
    return latin1Bytes(head + catalog + obj + `startxref\n${xrefOffset}\n%%EOF`);
  }
  const REAL_OBJECTS = 2;

  it('integer-width control: one stream byte yields exactly one entry', () => {
    const doc = PdfDocument.parse(xrefStreamPdf('/W [0 1 0] /Index [1 10000] /Size 10000'));
    expect(doc.xrefEntryCount).toBe(1);
    expect(doc.warnings).toEqual([]);
  });

  it('rejects fractional /W widths instead of minting thousands of entries from one byte', () => {
    // rowLen 0.0001 advanced the row cursor by a fraction: 10,000 entries from
    // a single decoded byte, with no warning.
    const doc = PdfDocument.parse(xrefStreamPdf('/W [0 0.0001 0] /Index [1 10000] /Size 10000'));
    expect(doc.xrefEntryCount).toBeLessThanOrEqual(REAL_OBJECTS);
    expect(doc.warnings.join('\n')).toContain('invalid /W');
  });

  it.each([
    ['nonfinite', '/W [1 /Nope 1]'],
    ['oversized', '/W [1 64 1]'],
    ['negative', '/W [1 -1 1]'],
    ['too few widths', '/W [1 2]'],
    ['too many widths', '/W [1 2 1 1]'],
  ])('rejects %s /W metadata', (_label, w) => {
    const doc = PdfDocument.parse(xrefStreamPdf(`${w} /Size 4`, 'AAAAAAAA'));
    expect(doc.xrefEntryCount).toBeLessThanOrEqual(REAL_OBJECTS);
    expect(doc.warnings.join('\n')).toContain('invalid /W');
  });

  it.each([
    ['fractional /Index', '/Index [0.5 3]'],
    ['negative /Index', '/Index [0 -3]'],
    ['odd-length /Index', '/Index [0 1 2]'],
    ['nonfinite /Index', '/Index [0 /Nope]'],
    ['non-array /Index', '/Index 3'],
    ['fractional /Size', '/Size 1.5'],
    ['negative /Size', '/Size -1'],
  ])('rejects %s', (_label, extra) => {
    const doc = PdfDocument.parse(xrefStreamPdf(`/W [0 1 0] ${extra}`, '\t\t\t\t'));
    expect(doc.xrefEntryCount).toBeLessThanOrEqual(REAL_OBJECTS);
    expect(doc.warnings.join('\n')).toMatch(/invalid \/(Index|Size)/);
  });

  it('bounds the entry count by the decoded bytes, whatever /Index and /Size claim', () => {
    // Two 2-byte rows exist; the metadata asks for 2e9 entries across two ranges.
    const doc = PdfDocument.parse(
      xrefStreamPdf(
        '/W [0 1 1] /Index [1 1000000000 5000 1000000000] /Size 2000000000',
        '\t\x00AB',
      ),
    );
    expect(doc.xrefEntryCount).toBe(2);
    expect(doc.warnings).toEqual([]);
  });
});

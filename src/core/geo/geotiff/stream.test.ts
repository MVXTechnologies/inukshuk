import { readTiffHeader } from '@core/geo/tiff/container';
import { rasterRowByteRange } from './rasterTiff';
import {
  createStreamRangeExtractor,
  createTiffHeaderCollector,
  TIFF_HEADER_WINDOW_BYTES,
} from './stream';
import { buildPaletteGeoTiff } from './testUtils';

/** Feed `bytes` through `push` in fixed-size chunks, as a download would. */
function feed(bytes: Uint8Array, chunk: number, push: (c: Uint8Array) => void): void {
  for (let at = 0; at < bytes.length; at += chunk) {
    push(bytes.subarray(at, Math.min(at + chunk, bytes.length)));
  }
}

describe('createTiffHeaderCollector', () => {
  const bytes = buildPaletteGeoTiff({ width: 40, height: 30 });

  it.each([1, 3, 7, 64, 100_000])('parses the header from %i-byte chunks', (chunk) => {
    const collector = createTiffHeaderCollector();
    feed(bytes, chunk, (c) => collector.push(c));
    const { raster, totalBytes } = collector.finish();
    expect(totalBytes).toBe(bytes.length);
    expect(raster).toMatchObject({ width: 40, height: 30, epsg: 26919 });
  });

  it('keeps only the tail — the whole point of streaming a 92 MB sheet', () => {
    const header = readTiffHeader(bytes)!;
    // Everything before the directory is the image data, and it is dropped.
    expect(header.ifdOffset).toBeGreaterThan(40 * 30);
    const collector = createTiffHeaderCollector();
    feed(bytes, 16, (c) => collector.push(c));
    const { window } = collector.finish();
    expect(window?.base).toBe(header.ifdOffset);
    expect(window?.view.byteLength).toBe(bytes.length - header.ifdOffset);
  });

  it('bounds the window even when the directory sits at the front of a huge file', () => {
    // A synthetic file whose IFD is early: the collector must stop buffering.
    const collector = createTiffHeaderCollector(64);
    const early = new Uint8Array(4096);
    early.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
    feed(early, 1000, (c) => collector.push(c));
    const { window } = collector.finish();
    expect(window?.view.byteLength).toBe(64);
  });

  it('reports a non-TIFF stream rather than throwing', () => {
    const collector = createTiffHeaderCollector();
    collector.push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4, 5]));
    const { raster, warnings, window } = collector.finish();
    expect(raster).toBeNull();
    expect(window).toBeNull();
    expect(warnings[0]).toContain('not a TIFF');
  });

  it('defaults to a bounded window', () => {
    expect(TIFF_HEADER_WINDOW_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe('createStreamRangeExtractor', () => {
  it('lifts every requested range out, whatever the chunking', () => {
    const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
    for (const chunk of [1, 3, 10, 250]) {
      const got: number[][] = [];
      const extractor = createStreamRangeExtractor(
        [
          { offset: 5, length: 3 },
          { offset: 40, length: 4 },
          { offset: 96, length: 4 },
        ],
        (index, out) => {
          got[index] = [...out];
        },
      );
      feed(bytes, chunk, (c) => extractor.push(c));
      expect(got).toEqual([
        [5, 6, 7],
        [40, 41, 42, 43],
        [96, 97, 98, 99],
      ]);
      expect(extractor.done).toBe(true);
    }
  });

  it('spans a range that straddles several chunks', () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);
    let got: number[] = [];
    const extractor = createStreamRangeExtractor([{ offset: 2, length: 40 }], (_i, out) => {
      got = [...out];
    });
    feed(bytes, 7, (c) => extractor.push(c));
    expect(got).toHaveLength(40);
    expect(got[0]).toBe(2);
    expect(got[39]).toBe(41);
  });

  it('skips a range the stream has already passed instead of stalling', () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, i) => i);
    const seen: number[] = [];
    const extractor = createStreamRangeExtractor(
      [
        { offset: 12, length: 2 },
        { offset: 3, length: 2 }, // out of order: unreachable
        { offset: 16, length: 2 },
      ],
      (index) => seen.push(index),
    );
    feed(bytes, 8, (c) => extractor.push(c));
    expect(seen).toEqual([0, 2]);
    expect(extractor.done).toBe(true);
  });

  it('leaves `done` false when the stream ends short of a range', () => {
    const extractor = createStreamRangeExtractor([{ offset: 0, length: 50 }], () => undefined);
    extractor.push(new Uint8Array(10));
    expect(extractor.done).toBe(false);
  });

  it('delivers an empty range without allocating', () => {
    const seen: number[] = [];
    const extractor = createStreamRangeExtractor([{ offset: 0, length: 0 }], (_i, out) =>
      seen.push(out.length),
    );
    extractor.push(new Uint8Array(4));
    expect(seen).toEqual([0]);
  });
});

describe('the two passes together', () => {
  it('reads a sheet’s rows from the stream alone, never holding the file', () => {
    const width = 8;
    const height = 6;
    const pixels = Array.from({ length: width * height }, (_, i) => i);
    const bytes = buildPaletteGeoTiff({ width, height, pixels });

    const collector = createTiffHeaderCollector();
    feed(bytes, 5, (c) => collector.push(c));
    const raster = collector.finish().raster!;

    const rows: Record<number, number[]> = {};
    const wanted = [0, 3, 5];
    const extractor = createStreamRangeExtractor(
      wanted.map((r) => rasterRowByteRange(raster, r)!),
      (index, out) => {
        rows[wanted[index]!] = [...out];
      },
    );
    feed(bytes, 5, (c) => extractor.push(c));

    expect(rows[0]).toEqual(pixels.slice(0, 8));
    expect(rows[3]).toEqual(pixels.slice(24, 32));
    expect(rows[5]).toEqual(pixels.slice(40, 48));
  });
});

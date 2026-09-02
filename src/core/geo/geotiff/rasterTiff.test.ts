import { readTiffHeader, tiffWindow } from '@core/geo/tiff/container';
import {
  decodeRasterRowToRgba,
  fullRasterCrop,
  parseRasterGeoTiff,
  planRasterDownscale,
  rasterRowByteRange,
  rasterRowBytes,
  type RasterGeoTiff,
} from './rasterTiff';
import { buildPaletteGeoTiff, type PaletteTiffOptions } from './testUtils';

/** Parse a synthetic sheet the way the app does: header window, then tags. */
function parse(options: PaletteTiffOptions = {}): {
  bytes: Uint8Array;
  raster: RasterGeoTiff | null;
  warnings: string[];
} {
  const bytes = buildPaletteGeoTiff(options);
  const header = readTiffHeader(bytes)!;
  const win = tiffWindow(bytes.slice(header.ifdOffset), header.ifdOffset, header.le);
  return { bytes, ...parseRasterGeoTiff(win, header.ifdOffset) };
}

describe('parseRasterGeoTiff', () => {
  it('reads the CanMatrix shape: 8-bit palette, uncompressed, one row per strip', () => {
    const { raster, warnings } = parse({ width: 4, height: 3 });
    expect(warnings).toEqual([]);
    expect(raster).toMatchObject({
      width: 4,
      height: 3,
      bitsPerSample: 8,
      samplesPerPixel: 1,
      photometric: 3,
      rowsPerStrip: 1,
      epsg: 26919,
    });
    expect(raster?.stripOffsets).toHaveLength(3);
    expect(raster?.palette?.r).toHaveLength(256);
  });

  it('anchors the model at the top-left pixel corner', () => {
    const { raster } = parse({ pixelScale: 4.2334, tiePoint: [307633, 5209773] });
    expect(raster?.model).toEqual({ x0: 307633, y0: 5209773, dx: 4.2334, dy: 4.2334 });
  });

  it('reports the CRS from the GeoTIFF key directory', () => {
    expect(parse({ projectedEpsg: 26909 }).raster?.epsg).toBe(26909);
    expect(parse({ projectedEpsg: 26919 }).raster?.geoKeys.citation).toBe('unnamed');
  });

  it('warns, but still parses, when the file names no CRS', () => {
    const { raster, warnings } = parse({ projectedEpsg: null });
    expect(raster?.epsg).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining('no EPSG')]);
  });

  it('refuses a compressed TIFF by name rather than drawing noise', () => {
    const { raster, warnings } = parse({ compression: 5 });
    expect(raster).toBeNull();
    expect(warnings[0]).toContain('compression 5');
  });

  it('refuses sample widths other than 8 bit', () => {
    expect(parse({ bitsPerSample: 16 }).warnings[0]).toContain('16-bit');
  });

  it('refuses an unsupported photometric interpretation', () => {
    // 6 = YCbCr.
    expect(parse({ photometric: 6 }).warnings[0]).toContain('photometric interpretation 6');
  });

  it('accepts greyscale and RGB, which carry no colour map', () => {
    expect(parse({ photometric: 1 }).raster?.palette).toBeUndefined();
    expect(parse({ photometric: 2, samplesPerPixel: 3 }).raster?.samplesPerPixel).toBe(3);
  });

  it('refuses bytes that are not a TIFF at all', () => {
    const junk = new Uint8Array(64);
    const win = tiffWindow(junk, 0, true);
    expect(parseRasterGeoTiff(win, 0).raster).toBeNull();
  });
});

describe('rasterRowByteRange', () => {
  const { raster } = parse({ width: 5, height: 4 });

  it('gives each row a contiguous byte range one row apart', () => {
    const r0 = rasterRowByteRange(raster!, 0)!;
    const r1 = rasterRowByteRange(raster!, 1)!;
    expect(r0.length).toBe(rasterRowBytes(raster!));
    expect(r1.offset - r0.offset).toBe(r0.length);
  });

  it('handles several rows per strip', () => {
    const multi = parse({ width: 5, height: 4, rowsPerStrip: 2 }).raster!;
    const r0 = rasterRowByteRange(multi, 0)!;
    const r1 = rasterRowByteRange(multi, 1)!;
    const r2 = rasterRowByteRange(multi, 2)!;
    expect(r1.offset - r0.offset).toBe(5); // same strip
    expect(r2.offset).toBe(multi.stripOffsets[1]); // next strip
  });

  it('returns null outside the image', () => {
    expect(rasterRowByteRange(raster!, -1)).toBeNull();
    expect(rasterRowByteRange(raster!, 4)).toBeNull();
  });
});

describe('planRasterDownscale', () => {
  it('never upscales, and keeps the aspect ratio', () => {
    const plan = planRasterDownscale({ x: 0, y: 0, width: 11289, height: 8183 }, 2048)!;
    expect(plan.outWidth).toBe(2048);
    expect(plan.outHeight).toBe(Math.round((2048 * 8183) / 11289));
    const small = planRasterDownscale({ x: 0, y: 0, width: 100, height: 50 }, 2048)!;
    expect(small.outWidth).toBe(100);
  });

  it('samples pixel centres, so the last column is not clipped off', () => {
    const plan = planRasterDownscale({ x: 0, y: 0, width: 100, height: 100 }, 10)!;
    expect(plan.srcCols[0]).toBe(5);
    expect(plan.srcCols[9]).toBe(95);
  });

  it('reports source coordinates in ABSOLUTE pixels, crop offset included', () => {
    const plan = planRasterDownscale({ x: 40, y: 20, width: 20, height: 10 }, 20)!;
    expect(plan.srcCols[0]).toBe(40);
    expect(plan.srcRows[0]).toBe(20);
    expect(plan.srcCols[19]).toBe(59);
  });

  it('rejects a degenerate crop', () => {
    expect(planRasterDownscale({ x: 0, y: 0, width: 0, height: 4 }, 16)).toBeNull();
    expect(planRasterDownscale({ x: 0, y: 0, width: 4, height: 4 }, 0)).toBeNull();
  });
});

describe('decodeRasterRowToRgba', () => {
  it('maps palette indexes through the colour map, opaque', () => {
    const { bytes, raster } = parse({
      width: 2,
      height: 1,
      pixels: [0, 1],
      palette: [
        [10, 20, 30],
        [40, 50, 60],
      ],
    });
    const plan = planRasterDownscale(fullRasterCrop(raster!), 2)!;
    const out = new Uint8Array(plan.outWidth * plan.outHeight * 4);
    const range = rasterRowByteRange(raster!, 0)!;
    decodeRasterRowToRgba(
      raster!,
      plan,
      bytes.subarray(range.offset, range.offset + range.length),
      0,
      out,
    );
    expect([...out]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it('reads RGB samples straight through', () => {
    const { bytes, raster } = parse({
      width: 2,
      height: 1,
      photometric: 2,
      samplesPerPixel: 3,
      pixels: [1, 2, 3, 4, 5, 6],
    });
    const plan = planRasterDownscale(fullRasterCrop(raster!), 2)!;
    const out = new Uint8Array(8);
    const range = rasterRowByteRange(raster!, 0)!;
    decodeRasterRowToRgba(
      raster!,
      plan,
      bytes.subarray(range.offset, range.offset + range.length),
      0,
      out,
    );
    expect([...out]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it('inverts a white-is-zero greyscale', () => {
    const { bytes, raster } = parse({ width: 2, height: 1, photometric: 0, pixels: [0, 255] });
    const plan = planRasterDownscale(fullRasterCrop(raster!), 2)!;
    const out = new Uint8Array(8);
    const range = rasterRowByteRange(raster!, 0)!;
    decodeRasterRowToRgba(
      raster!,
      plan,
      bytes.subarray(range.offset, range.offset + range.length),
      0,
      out,
    );
    expect([out[0], out[4]]).toEqual([255, 0]);
  });

  it('ignores an output row outside the plan', () => {
    const { raster } = parse({ width: 2, height: 1 });
    const plan = planRasterDownscale(fullRasterCrop(raster!), 2)!;
    const out = new Uint8Array(8);
    decodeRasterRowToRgba(raster!, plan, new Uint8Array([1, 2]), 9, out);
    expect([...out]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

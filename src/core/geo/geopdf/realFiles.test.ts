import * as fs from 'fs';
import * as path from 'path';
import type { CornerCoordinates, PointRect } from '@core/models';
import { renderedPageCorners } from './pageBox';
import { type GeoPdfParseResult, parseGeoPdf } from './parseGeoPdf';
import type { ByteSource } from './pdfReader';
import { primaryGeoreferenceForPage } from './primary';

/**
 * Placement regression against three real GeoPDFs (#287) and, since #328, the
 * random-access read path. The files are not in git (3.6 MB / 52 MB / 216 MB);
 * point `INUKSHUK_GEOPDF_DIR` at a directory holding them and the suite runs,
 * otherwise it is skipped.
 *
 * Every value below was captured from the parser BEFORE the rendered-page-box
 * change. All three sheets have a zero-origin MediaBox and either no CropBox or
 * one equal to it, so the fix must leave their placement bit-for-bit
 * identical: the primary viewport's frame and corners, the page size, and the
 * full-page corners the overlay hands to MapLibre.
 *
 * #328: the same files parsed through a file-backed {@link ByteSource} must
 * produce the identical result while reading a small fraction of the file —
 * the import path no longer loads a 216 MB sheet into a 192 MB heap.
 */
const dir = process.env.INUKSHUK_GEOPDF_DIR;

/** Fraction of the file the streaming parse may read (the 216 MB sheet: < 11 MB). */
const MAX_READ_FRACTION = 0.05;

interface Expected {
  file: string;
  label: string;
  georeferences: number;
  pageWidthPt: number;
  pageHeightPt: number;
  rect: PointRect;
  corners: CornerCoordinates;
  /** Full-page corners as placed by `usePdfOverlays` before #287. */
  page: CornerCoordinates;
}

const EXPECTED: Expected[] = [
  {
    file: 'ANT_Cerf_Secteur_la-loutre-1.pdf',
    label: 'Anticosti (Sépaq, 3.6 MB, MediaBox only, four equal viewports)',
    georeferences: 4,
    pageWidthPt: 1368,
    pageHeightPt: 936,
    rect: { x0: 36, y0: 36, x1: 1062, y1: 900 },
    corners: {
      topLeft: [-63.805927499999996, 49.64912],
      topRight: [-63.5305925, 49.65071],
      bottomRight: [-63.5285375, 49.49993],
      bottomLeft: [-63.8038725, 49.498340000000006],
    },
    page: {
      topLeft: [-63.81567400219304, 49.65534671052632],
      topRight: [-63.448560668859656, 49.657466710526315],
      bottomRight: [-63.446334418859635, 49.49412171052631],
      bottomLeft: [-63.81344775219302, 49.49200171052631],
    },
  },
  {
    file: 'EcoLL1.pdf',
    label: 'EcoLL1 (52 MB, MediaBox only)',
    georeferences: 1,
    pageWidthPt: 3456,
    pageHeightPt: 3024,
    rect: { x0: 0, y0: 0, x1: 3456, y1: 3024 },
    corners: {
      topLeft: [-63.80551499883427, 49.665938252884004],
      topRight: [-63.475779930834975, 49.65138168291479],
      bottomRight: [-63.495360933724356, 49.46373648897131],
      bottomLeft: [-63.82509600172365, 49.47829305894052],
    },
    page: {
      topLeft: [-63.80551499883422, 49.66593825288401],
      topRight: [-63.47577993083495, 49.6513816829148],
      bottomRight: [-63.49536093372437, 49.46373648897133],
      bottomLeft: [-63.82509600172364, 49.47829305894054],
    },
  },
  {
    file: 'NORD_UTM50000_2024-02-02.pdf',
    label: 'NORD UTM 50k (216 MB, CropBox == MediaBox)',
    georeferences: 1,
    pageWidthPt: 3370.39,
    pageHeightPt: 2383.94,
    rect: { x0: 38.06491587363, y0: 0, x1: 3332.328784914, y1: 2383.937007874 },
    corners: {
      topLeft: [-63.6490009045825, 50.80578515344002],
      topRight: [-62.34576286190128, 50.80575603114],
      bottomRight: [-62.34579590248253, 50.20434381059001],
      bottomLeft: [-63.64903394516375, 50.20437293289003],
    },
    page: {
      topLeft: [-63.66405970020219, 50.80578624478972],
      topRight: [-62.33070553026078, 50.80575644951144],
      bottomRight: [-62.33073857088353, 50.20434347411722],
      bottomLeft: [-63.66409274082494, 50.204373269395504],
    },
  },
];

interface ReadStats {
  reads: number;
  bytesRead: number;
  maxRead: number;
}

/**
 * The Node counterpart of `storage.withFileByteSource`: one descriptor, one
 * positioned `readSync` per request, every read tallied.
 */
function withFileSource<T>(file: string, fn: (source: ByteSource, stats: ReadStats) => T): T {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const stats: ReadStats = { reads: 0, bytesRead: 0, maxRead: 0 };
  try {
    return fn(
      {
        size,
        read(offset, length) {
          const want = Math.max(0, Math.min(length, size - offset));
          const out = new Uint8Array(want);
          const got = want > 0 ? fs.readSync(fd, out, 0, want, offset) : 0;
          stats.reads += 1;
          stats.bytesRead += got;
          stats.maxRead = Math.max(stats.maxRead, got);
          return got === want ? out : out.subarray(0, got);
        },
      },
      stats,
    );
  } finally {
    fs.closeSync(fd);
  }
}

const available = dir !== undefined && EXPECTED.every((e) => fs.existsSync(path.join(dir, e.file)));

const assertPlacement = (res: GeoPdfParseResult, expected: Expected): void => {
  expect(res.warnings).toEqual([]);
  expect(res.georeferences).toHaveLength(expected.georeferences);
  const geo = primaryGeoreferenceForPage(res.georeferences, 0)!;
  expect(geo.pageWidthPt).toBe(expected.pageWidthPt);
  expect(geo.pageHeightPt).toBe(expected.pageHeightPt);
  expect(geo.pageBox).toEqual({
    x0: 0,
    y0: 0,
    x1: expected.pageWidthPt,
    y1: expected.pageHeightPt,
  });
  expect(geo.viewport.rect).toEqual(expected.rect);
  expect(geo.viewport.corners).toEqual(expected.corners);
  expect(renderedPageCorners(geo)).toEqual(expected.page);
};

(available ? describe : describe.skip)('real GeoPDF placement is unchanged by #287', () => {
  for (const expected of EXPECTED) {
    it(expected.label, () => {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir!, expected.file)));
      assertPlacement(parseGeoPdf(bytes), expected);
    });
  }
});

(available ? describe : describe.skip)(
  'real GeoPDFs parse identically through a ByteSource (#328)',
  () => {
    for (const expected of EXPECTED) {
      it(`${expected.label} — reads under ${MAX_READ_FRACTION * 100}% of the file`, () => {
        const file = path.join(dir!, expected.file);
        const inMemory = parseGeoPdf(new Uint8Array(fs.readFileSync(file)));
        const { streamed, stats, size } = withFileSource(file, (source, s) => ({
          streamed: parseGeoPdf(source),
          stats: s,
          size: source.size,
        }));
        process.stdout.write(
          `[#328] ${expected.file}: ${size} bytes, read ${stats.bytesRead} ` +
            `(${((100 * stats.bytesRead) / size).toFixed(2)}%) in ${stats.reads} reads, ` +
            `largest ${stats.maxRead}\n`,
        );
        expect(streamed).toEqual(inMemory);
        assertPlacement(streamed, expected);
        expect(stats.bytesRead).toBeLessThan(size * MAX_READ_FRACTION);
      });
    }
  },
);

/**
 * Orientation, stated as a property rather than as captured numbers (#336).
 *
 * Before #270 the parser paired `/GPTS` with the ISO default corner order
 * instead of the file's own `/LPTS`, so EcoLL1 — whose producer lists the
 * upper-left corner first — parsed with its top edge SOUTH of its bottom
 * edge and drew upside down. Captured expectations would have caught it too,
 * but only by mismatching; this says what actually has to be true, for every
 * sheet, in the direction a human can check on the map.
 */
(dir ? describe : describe.skip)('real GeoPDFs are the right way up', () => {
  for (const expected of EXPECTED) {
    it(`${expected.label} — north at the top, west on the left`, () => {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir as string, expected.file)));
      const geo = primaryGeoreferenceForPage(parseGeoPdf(bytes).georeferences, 0);
      expect(geo).toBeDefined();
      const c = geo!.viewport!.corners;
      // Latitude increases northward, so the top edge must sit north of the
      // bottom edge on BOTH sides of the sheet.
      expect(c.topLeft[1]).toBeGreaterThan(c.bottomLeft[1]);
      expect(c.topRight[1]).toBeGreaterThan(c.bottomRight[1]);
      // These sheets are all in the western hemisphere, none spans the
      // antimeridian: the left edge is west of the right edge.
      expect(c.topLeft[0]).toBeLessThan(c.topRight[0]);
      expect(c.bottomLeft[0]).toBeLessThan(c.bottomRight[0]);
    });
  }
});

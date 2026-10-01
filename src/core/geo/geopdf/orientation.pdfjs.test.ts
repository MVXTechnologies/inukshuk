/**
 * The raster-orientation contract against real pdf.js 3.11.174 (#487).
 *
 * The overlay corners the parser computes are the geographic positions of the
 * page box's user-space corners; they only land right if the rasterizer puts
 * the user-space top-left at pixel (0, 0) — whatever the page's `/Rotate`,
 * MediaBox origin or CropBox. `rasterPixelOfPagePoint` states that contract;
 * this test pins it to what pdf.js's `getViewport({ rotation:
 * PDF_RASTER_ROTATION })` actually does, and shows that leaving the rotation
 * to pdf.js would NOT (it applies `/Rotate` by default).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDF_RASTER_ROTATION, normalizePageRotation, rasterPixelOfPagePoint } from './orientation';
import { buildClassicPdf } from './testUtils';

interface Viewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): [number, number];
}
interface Page {
  rotate: number;
  view: number[];
  getViewport(params: { scale: number; rotation?: number }): Viewport;
}
interface Pdfjs {
  getDocument(params: object): {
    promise: Promise<{ getPage(n: number): Promise<Page>; destroy(): Promise<void> }>;
  };
}

const WORKER_ASSET = readFileSync(
  join(__dirname, '../../../../assets/pdfjs/pdf.worker.legacy.min.js.pdfjs'),
  'utf8',
);

function loadPdfjs(): Pdfjs {
  const module = { exports: {} as { WorkerMessageHandler?: unknown } };
  new Function('module', 'exports', WORKER_ASSET)(module, module.exports);
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = module.exports;
  let pdfjs: Pdfjs | undefined;
  jest.isolateModules(() => {
    pdfjs = jest.requireActual<Pdfjs>('pdfjs-dist/legacy/build/pdf.js');
  });
  return pdfjs!;
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  delete (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker;
});

async function openPage(pageDict: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const pdfjs = loadPdfjs();
  const bytes = buildClassicPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R ${pageDict} >>`,
    ],
    1,
  );
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 })
    .promise;
  return { page: await doc.getPage(1), close: () => doc.destroy() };
}

describe.each([0, 90, 180, 270, -90])('/Rotate %p', (rotate) => {
  it.each([
    ['a zero-origin MediaBox', '/MediaBox [0 0 300 200]', { x0: 0, y0: 0, x1: 300, y1: 200 }],
    [
      'a shifted MediaBox with a CropBox',
      '/MediaBox [10 20 310 220] /CropBox [40 30 290 210]',
      { x0: 40, y0: 30, x1: 290, y1: 210 },
    ],
  ])('rasterizes %s with its user-space top-left at pixel (0, 0)', async (_label, boxes, box) => {
    const { page, close } = await openPage(`${boxes} /Rotate ${rotate}`);
    try {
      expect(page.rotate).toBe(normalizePageRotation(rotate));
      const scale = 2;
      const vp = page.getViewport({ scale, rotation: PDF_RASTER_ROTATION });
      expect(vp.width).toBeCloseTo(scale * (box.x1 - box.x0), 9);
      expect(vp.height).toBeCloseTo(scale * (box.y1 - box.y0), 9);
      for (const [x, y] of [
        [box.x0, box.y1],
        [box.x1, box.y1],
        [box.x1, box.y0],
        [box.x0, box.y0],
        [(box.x0 + box.x1) / 2, box.y0 + 7],
      ] as const) {
        const [px, py] = vp.convertToViewportPoint(x, y);
        const [ex, ey] = rasterPixelOfPagePoint(box, scale, x, y);
        expect(px).toBeCloseTo(ex, 9);
        expect(py).toBeCloseTo(ey, 9);
      }

      // pdf.js's default applies /Rotate: on a turned page the top-left of
      // user space is then NOT pixel (0, 0) — which is why the rasterizer
      // must pass the rotation explicitly.
      const [dx, dy] = page.getViewport({ scale }).convertToViewportPoint(box.x0, box.y1);
      const atOrigin = Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9;
      expect(atOrigin).toBe(normalizePageRotation(rotate) === 0);
    } finally {
      await close();
    }
  });
});

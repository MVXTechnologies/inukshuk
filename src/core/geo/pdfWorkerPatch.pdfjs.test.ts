/**
 * The layer filter end to end in real pdf.js 3.11.174: the bundled worker,
 * stock and patched, builds the operator list of a small PDF laid out like a
 * USGS US Topo sheet — a visible vector layer, an orthoimage nested under an
 * "Images" parent that is off by default (AllOn membership), a shaded-relief
 * group that is off, and images/forms that carry their own /OC. The patched
 * worker must drop exactly what pdf.js would never paint, and nothing else.
 *
 * pdf.js runs its "fake" (same-thread) worker here, which shares the global
 * the runtime installs itself on — the same arrangement as the WebView's
 * main-thread fallback.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPdfLayerRuntime, type PdfOptionalContentFilter } from './pdfLayers';
import { patchPdfWorkerSource } from './pdfWorkerPatch';

// Minimal pdf.js typings for what this test touches.
interface OpList {
  fnArray: number[];
  argsArray: unknown[][];
}
interface PdfjsConfig {
  getGroups(): Record<string, { name: string; visible: boolean }> | null;
  setVisibility(id: string, visible: boolean): void;
  isVisible(group: unknown): boolean;
}
interface Pdfjs {
  OPS: Record<string, number>;
  getDocument(params: object): {
    promise: Promise<{
      getPage(n: number): Promise<{ getOperatorList(): Promise<OpList> }>;
      getOptionalContentConfig(): Promise<PdfjsConfig>;
      destroy(): Promise<void>;
    }>;
  };
}

/** Assemble a PDF from numbered object bodies, with a correct xref table. */
function buildPdf(objects: Record<number, string>): Uint8Array {
  const ids = Object.keys(objects)
    .map(Number)
    .sort((a, b) => a - b);
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const id of ids) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const size = (ids.at(-1) ?? 0) + 1;
  const xref = out.length;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) {
    out += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 ${offsets[id] ? 'n' : 'f'} \n`;
  }
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

function stream(dict: string, body: string): string {
  return `<< ${dict} /Length ${body.length} >>\nstream\n${body}\nendstream`;
}

/** 2×2 uncompressed RGB image, optionally carrying its own /OC. */
const image = (oc = '') =>
  stream(
    `/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 ${oc}`,
    'ABCDEFGHIJKL',
  );

const US_TOPO_LIKE = buildPdf({
  1: '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R 7 0 R 8 0 R] /D << /OFF [6 0 R 8 0 R] /Order [5 0 R 7 0 R 6 0 R 8 0 R] >> >> >>',
  2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  3:
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << ' +
    '/Properties << /Contours 5 0 R /Ortho 9 0 R >> ' +
    '/XObject << /ImVisible 10 0 R /ImOrtho 11 0 R /ImRelief 12 0 R /FmOrtho 13 0 R /FmRelief 14 0 R >> >> >>',
  4: stream(
    '',
    [
      // Visible vector layer + an image in it: both stay.
      '/OC /Contours BDC 0 0 1 rg 10 10 30 30 re f q 20 0 0 20 10 10 cm /ImVisible Do Q EMC',
      // Orthoimage section (hidden via its "Images" parent): image and form dropped.
      '/OC /Ortho BDC q 50 0 0 50 0 0 cm /ImOrtho Do Q /FmOrtho Do EMC',
      // Relief image and form, hidden by their own /OC entries.
      'q 50 0 0 50 100 100 cm /ImRelief Do Q /FmRelief Do',
    ].join('\n'),
  ),
  5: '<< /Type /OCG /Name (Contours) >>',
  6: '<< /Type /OCG /Name (Shaded Relief) >>',
  7: '<< /Type /OCG /Name (Orthoimage) >>',
  8: '<< /Type /OCG /Name (Images) >>',
  9: '<< /Type /OCMD /OCGs [7 0 R 8 0 R] /P /AllOn >>',
  10: image(),
  11: image(),
  12: image('/OC 6 0 R'),
  13: stream(
    '/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /Im 11 0 R >> >>',
    'q 1 0 0 1 0 0 cm /Im Do Q',
  ),
  14: stream(
    '/Type /XObject /Subtype /Form /BBox [0 0 1 1] /OC 6 0 R /Resources << /XObject << /Im 12 0 R >> >>',
    'q 1 0 0 1 0 0 cm /Im Do Q',
  ),
});

const WORKER_ASSET = readFileSync(
  join(__dirname, '../../../assets/pdfjs/pdf.worker.legacy.min.js.pdfjs'),
  'utf8',
);

/** A fresh pdf.js whose fake worker runs `workerSource`. */
function loadPdfjs(workerSource: string): Pdfjs {
  const module = { exports: {} as { WorkerMessageHandler?: unknown } };
  new Function('module', 'exports', workerSource)(module, module.exports);
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = module.exports;
  let pdfjs: Pdfjs | undefined;
  jest.isolateModules(() => {
    pdfjs = jest.requireActual<Pdfjs>('pdfjs-dist/legacy/build/pdf.js');
  });
  return pdfjs!;
}

interface Opened {
  ops: OpList;
  config: PdfjsConfig;
  pdfjs: Pdfjs;
}

async function open(
  workerSource: string,
  plan: (config: PdfjsConfig) => Record<string, boolean> | null,
): Promise<Opened> {
  const pdfjs = loadPdfjs(workerSource);
  const doc = await pdfjs.getDocument({
    data: US_TOPO_LIKE.slice(),
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  const config = await doc.getOptionalContentConfig();
  const visibility = plan(config);
  if (visibility) for (const [id, v] of Object.entries(visibility)) config.setVisibility(id, v);
  // What the page does in fake-worker mode: set the shared global directly.
  const filter = (globalThis as { __inkOC?: PdfOptionalContentFilter }).__inkOC;
  filter?.set(visibility);
  const ops = await (await doc.getPage(1)).getOperatorList();
  await doc.destroy();
  filter?.set(null);
  return { ops, config, pdfjs };
}

function count(opened: Opened, ...names: string[]): number {
  const wanted = new Set(names.map((n) => opened.pdfjs.OPS[n]));
  return opened.ops.fnArray.filter((fn) => wanted.has(fn)).length;
}

const { planLayers } = loadPdfLayerRuntime();
function appPlan(showImagery: boolean) {
  return (config: PdfjsConfig) => {
    const groups = Object.entries(config.getGroups() ?? {}).map(([id, g]) => ({
      id,
      name: g.name,
      visible: g.visible,
    }));
    return planLayers(groups, { showImagery }).visibility;
  };
}

beforeEach(() => {
  // pdf.js logs a Path2D polyfill warning on load under Node; no rendering here.
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  delete (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker;
});

it('the stock worker decodes every image, hidden or not', async () => {
  const stock = await open(WORKER_ASSET, appPlan(false));
  // ImVisible, ImOrtho, ImOrtho (inside FmOrtho), ImRelief, ImRelief (inside FmRelief).
  expect(count(stock, 'paintImageXObject')).toBe(5);
  expect(count(stock, 'paintFormXObjectBegin')).toBe(2);
});

it('the patched worker keeps visible content and drops every hidden image and form', async () => {
  const patched = patchPdfWorkerSource(WORKER_ASSET);
  expect(patched.patched).toBe(true);
  const opened = await open(patched.source, appPlan(false));
  expect(count(opened, 'paintImageXObject')).toBe(1); // ImVisible
  expect(count(opened, 'paintFormXObjectBegin')).toBe(0);
  expect(count(opened, 'fill')).toBe(1); // the Contours rectangle
});

it('draws the orthoimage again when imagery is switched on', async () => {
  const opened = await open(patchPdfWorkerSource(WORKER_ASSET).source, appPlan(true));
  // ImVisible + ImOrtho + ImOrtho in its form; the relief stays hidden.
  expect(count(opened, 'paintImageXObject')).toBe(3);
  expect(count(opened, 'paintFormXObjectBegin')).toBe(1);
});

it('filters nothing when the page sends no visibility map', async () => {
  const opened = await open(patchPdfWorkerSource(WORKER_ASSET).source, () => null);
  expect(count(opened, 'paintImageXObject')).toBe(5);
});

it('agrees with pdf.js on the visibility of every section the document declares', async () => {
  const { ops, config, pdfjs } = await open(WORKER_ASSET, appPlan(false));
  const filter = loadPdfLayerRuntime().filter;
  const groups = config.getGroups() ?? {};
  filter.set(Object.fromEntries(Object.entries(groups).map(([id, g]) => [id, g.visible])));
  const sections = ops.fnArray
    .map((fn, i) => (fn === pdfjs.OPS.beginMarkedContentProps ? ops.argsArray[i] : null))
    .filter((args): args is unknown[] => args?.[0] === 'OC')
    .map((args) => args[1]);
  expect(sections.length).toBeGreaterThanOrEqual(3);
  for (const section of sections) {
    expect(filter.visible(section as never)).toBe(config.isVisible(section));
  }
});

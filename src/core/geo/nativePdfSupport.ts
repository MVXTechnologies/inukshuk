/**
 * Whether a native renderer's "unsupported" refusal (`E_PDF_UNSUPPORTED`) is
 * about the PAGE or about one CROP.
 *
 * The iOS renderer draws only pages that are a single opaque JPEG paint; it
 * refuses every vector page (US Topo, FSTopo, CanTopo...). The rasterizer used
 * to remember a refusal per request (crop + width) only, so every new detail
 * tile of a vector page went: pdf.js opens the page to check its geometry,
 * releases it for the native renderer, the native renderer opens the PDF and
 * refuses, and pdf.js opens and parses the page again to draw it. A refusal
 * whose reason is the page itself now marks the page, and its later crops go
 * straight to pdf.js (which keeps the page open between them).
 *
 * Crop-specific refusals (geometry, a decode budget) keep the per-request
 * rule: another crop of the same page may still be drawn natively.
 */
const CROP_SPECIFIC = [
  /invalid crop/i,
  /crop is too narrow/i,
  /source crop is empty/i,
  /reduced jpeg/i,
  /cropped jpeg/i,
  /crop output/i,
  /encode crop/i,
  /could not be keyed/i,
  /decod(er|e) budget/i,
];

/** True when `message` (an `E_PDF_UNSUPPORTED` reason) rules out the whole page. */
export function isPageLevelUnsupported(message: string): boolean {
  if (!message.trim()) return false;
  return !CROP_SPECIFIC.some((pattern) => pattern.test(message));
}

/**
 * A page's native-geometry verification, as remembered across launches.
 *
 * Before a native crop, pdf.js opens the page once to check that the native
 * renderer would draw what pdf.js draws (rotation 0, UserUnit 1, the page box
 * the georeference expects, default layers). That check is a property of the
 * file's bytes, so it is remembered by the file (its last two path segments,
 * which survive iOS container moves), its revision, the page and its size,
 * and by `planVersion`, the layer-plan code that decided "default layers",
 * so an update that changes the plan verifies again. With it, a cold launch
 * can draw native detail before the pdf.js page has even loaded.
 */
export function persistentNativeGeometryKey(
  page: { fileUri: string; revision: string; pageIndex: number; widthPt: number; heightPt: number },
  planVersion: string,
): string {
  const tail = page.fileUri.split('/').filter(Boolean).slice(-2).join('/');
  return JSON.stringify([
    tail,
    page.revision,
    page.pageIndex,
    page.widthPt,
    page.heightPt,
    planVersion,
  ]);
}

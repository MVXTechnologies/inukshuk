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

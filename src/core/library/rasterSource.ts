import { servedFileUrl } from '@core/storage/servedPaths';

/**
 * How a PDF page reaches the rasterizer (#269).
 *
 * The rasterizer is a WebView; for years the PDF crossed the bridge to it as
 * one base64 string. That scales with file size at every step — a 216 MB
 * GeoPDF became 289 MB of base64, ~1,100 bridge evaluations and an `atob`
 * loop — and it OOMed on Android (#218) and timed out on iOS (#264, #265).
 * The fix serves the file over loopback so pdf.js range-fetches only the
 * bytes the page needs. This chooser is the rule for when that path is
 * available, when the old one is still acceptable, and when neither is —
 * pure, so the size cut-off is a tested number and not a comment.
 */

/**
 * The largest PDF the base64 bridge path may still carry when the server is
 * unavailable. Above it the old path did not fail — it hung for the full
 * render timeout and then reported nothing useful. 16 MB is comfortably
 * under the Android allocation that failed (~150 MB) with room for the
 * 4/3 base64 expansion and the decoded copy inside the WebView.
 */
export const MAX_INLINE_PDF_BYTES = 16 * 1024 * 1024;

export type RasterSourceChoice =
  /** Served over loopback: pdf.js range-fetches `url` directly. */
  | { kind: 'url'; url: string }
  /** Small enough to read as base64 and push over the bridge. */
  | { kind: 'inline' }
  /** Neither path is safe; `reason` is the user-facing failure. */
  | { kind: 'unrenderable'; reason: string };

export interface RasterSourceArgs {
  /** The loopback server origin, or `null` when it could not be started. */
  origin: string | null;
  /** Document-relative path of the PDF (`maps/<id>.pdf`), or an absolute uri. */
  documentPath: string;
  /** File size in bytes; 0 when unknown (the inline path is then attempted). */
  sizeBytes: number;
}

export function chooseRasterSource({
  origin,
  documentPath,
  sizeBytes,
}: RasterSourceArgs): RasterSourceChoice {
  if (origin !== null) {
    const url = servedFileUrl(origin, documentPath);
    if (url !== null) return { kind: 'url', url };
  }
  if (sizeBytes <= MAX_INLINE_PDF_BYTES) return { kind: 'inline' };
  const mb = Math.round(sizeBytes / (1024 * 1024));
  return {
    kind: 'unrenderable',
    reason:
      `${mb} MB PDF is too large to load without the in-app file server ` +
      `(limit ${MAX_INLINE_PDF_BYTES / (1024 * 1024)} MB without it)`,
  };
}

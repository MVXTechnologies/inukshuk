/**
 * PDF rendering benchmark probe — compiled in only when the bundle is built
 * with `EXPO_PUBLIC_PDF_BENCH=1` (a local perf build), a no-op otherwise.
 *
 * The rasterizer and the detail-tile hook report what they do here; the
 * bench harness (`usePdfBench`) listens and turns it into time-to-sharp
 * numbers. Nothing here changes behaviour.
 */
export const PDF_BENCH = process.env.EXPO_PUBLIC_PDF_BENCH === '1';

export type PdfBenchEvent =
  | {
      kind: 'raster-start';
      id: number;
      at: number;
      priority: string;
      targetWidthPx: number;
      crop: boolean;
      native: boolean;
    }
  | {
      kind: 'raster-end';
      id: number;
      at: number;
      ok: boolean;
      ms: number;
      path: 'file' | 'data';
      loadMs?: number;
      renderMs?: number;
      widthPx?: number;
      heightPx?: number;
      error?: string;
    }
  | {
      /** The detail hook's view of the current camera: visible tiles and how many are shown. */
      kind: 'details';
      at: number;
      bounds: string;
      visible: number;
      covered: number;
      /** Image files the hook publishes for this camera. */
      shown: string[];
      /** Least raster px per device px among the visible cells (planner density). */
      resolution?: number;
    };

type Listener = (event: PdfBenchEvent) => void;
const listeners = new Set<Listener>();
let nextId = 0;
let lastDetails: Extract<PdfBenchEvent, { kind: 'details' }> | null = null;

/** When this bundle started running (bench builds: the cold-launch baseline). */
export const PDF_BENCH_JS_START = Date.now();

export function pdfBenchEmit(event: PdfBenchEvent): void {
  if (!PDF_BENCH) return;
  if (event.kind === 'details') lastDetails = event;
  for (const listener of listeners) listener(event);
}

/** The detail hook's latest report, even one sent before anyone listened. */
export function pdfBenchLastDetails(): Extract<PdfBenchEvent, { kind: 'details' }> | null {
  return lastDetails;
}

/** A fresh id for a raster request (bench builds only; 0 otherwise). */
export function pdfBenchId(): number {
  return PDF_BENCH ? ++nextId : 0;
}

export function pdfBenchSubscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

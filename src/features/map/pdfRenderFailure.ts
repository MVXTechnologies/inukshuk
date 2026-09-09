/** Cancellation says nothing about the page's ability to render. */
export function isPdfRenderCancellation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.message === 'PdfRasterizer: provider unmounted' ||
      /\bcancell?ed\b/i.test(error.message))
  );
}

/** Distinguish a dispatched overview rejection from source preparation or PNG persistence. */
export class PdfRenderFailure extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'PdfRenderFailure';
  }
}
/** Engine/checkpoint admission failed before any backend accepted this page. */
export class PdfRenderNotStartedError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'PdfRenderNotStartedError';
  }
}

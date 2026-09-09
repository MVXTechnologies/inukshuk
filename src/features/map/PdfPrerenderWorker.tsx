import { usePrerenderOnImport } from './usePrerenderOnImport';

/**
 * Renders nothing; hosts the import-time PDF pre-render worker (#272 step 2).
 * Mount once inside `PdfRasterizerProvider`, next to the other root-level
 * background services.
 */
export function PdfPrerenderWorker(): null {
  usePrerenderOnImport();
  return null;
}

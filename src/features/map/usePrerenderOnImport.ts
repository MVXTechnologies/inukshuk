import { nativePageGeometry } from '@core/geo/geopdf/pageBox';
import {
  OVERLAY_TARGET_WIDTH_PX,
  rasterCacheKey,
  rasterFileName,
} from '@core/library/overlayRaster';
import { overlayStatusKey } from '@core/library/overlayStatus';
import {
  detectNewDocuments,
  enqueuePrerender,
  prerenderJobsForDocument,
  requeuePrerender,
  takeNextPrerender,
  type PrerenderJob,
} from '@core/library/prerenderQueue';
import { chooseRasterSource } from '@core/library/rasterSource';
import type { MapDocument } from '@core/models';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';
import { useLibraryStore } from '@state/libraryStore';
import { useOverlayStatusStore } from '@state/overlayStatusStore';
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  isPdfRenderCancellation,
  PdfRenderFailure,
  PdfRenderNotStartedError,
} from './pdfRenderFailure';
import { usePdfRasterizer, usePdfRasterizerServer, type RasterizeSource } from './PdfRasterizer';
import { pendingRastersFor } from './usePdfOverlay';

/**
 * Pre-render PDF overlay pages right after import, in the background (#272
 * step 2), so the first time the map tab draws a map its raster is already on
 * disk. Today the 2–18 s of pdf.js painting (#269) is paid the moment the
 * user opens the map; this pays it while they are still in the Library.
 *
 * Mount once, inside `PdfRasterizerProvider` (`PdfPrerenderWorker`). Watches
 * the library store: every document that appears after hydration — picker
 * import, store download or update, map maker — has each active
 * georeferenced page queued (`@core/library/prerenderQueue`) and rendered one
 * at a time at `priority: 'background'`, into exactly the file the overlay
 * hook reads (`@core/library/overlayRaster`), so that hook finds it cached
 * and never renders it again.
 *
 * Rules: nothing runs while the app is backgrounded; a page already on disk,
 * already in flight for the map, deactivated, or whose document was deleted
 * or replaced is skipped; the Library card says "Preparing page N…" and the
 * map's rendering toasts stay quiet; failures are silent to the user (the
 * overlay path retries with its own status when the map needs the page) but
 * reported under `pdf-prerender`.
 *
 * Not paused when the map tab is hidden: #281 pauses *detail tiles* for a
 * hidden map because nothing is looking at them; the pre-render exists
 * precisely for the map nobody is looking at yet.
 */
export function usePrerenderOnImport(): void {
  const rasterize = usePdfRasterizer();
  const serverOrigin = usePdfRasterizerServer();

  useEffect(() => {
    let disposed = false;
    let queue: PrerenderJob[] = [];
    // `null` until the library has hydrated; the documents present then are
    // seeded as seen, never pre-rendered.
    let seen: ReadonlySet<string> | null = null;
    let running = false;
    let appActive = isForeground(AppState.currentState);

    const isCached = (job: PrerenderJob): boolean =>
      storage.existingOverlayPng(rasterFileName(job.docId, job.pageIndex, job.revision)) !== null;

    const run = async (job: PrerenderJob): Promise<void> => {
      const statusKey = overlayStatusKey(job.docId, job.pageIndex);
      const cacheKey = rasterCacheKey(job.docId, job.pageIndex, job.revision);
      const pending = pendingRastersFor(rasterize);
      // The map is rendering this very page right now; it will write the file.
      if (pending.has(cacheKey)) return;

      useOverlayStatusStore.getState().setStatus(statusKey, { phase: 'preparing' });
      const startedAt = Date.now();
      const render = (async (): Promise<string> => {
        const origin = await serverOrigin();
        const choice = chooseRasterSource({
          origin,
          documentPath: storage.toDocumentPath(job.fileUri),
          sizeBytes: storage.fileSizeAt(job.fileUri),
        });
        if (choice.kind === 'unrenderable') throw new Error(choice.reason);
        const source: RasterizeSource =
          choice.kind === 'url'
            ? { url: choice.url }
            : { base64: await storage.readFileBase64(job.fileUri) };
        // Same request the overlay hook would make, so the bytes on disk are
        // the same whichever of the two got there first.
        const nativeGeometry = nativePageGeometry(job.geo);
        const raster = await rasterize({
          source,
          pageIndex: job.pageIndex,
          targetWidthPx: OVERLAY_TARGET_WIDTH_PX,
          priority: 'background',
          nativePage: nativeGeometry && {
            fileUri: storage.resolveDocumentPath(job.fileUri),
            revision: job.revision,
            ...nativeGeometry,
          },
        }).catch((error: unknown) => {
          // Classified like the hook's own renders: if the map joins this
          // promise, a real render failure pauses the page the same way.
          if (isPdfRenderCancellation(error) || error instanceof PdfRenderNotStartedError)
            throw error;
          throw new PdfRenderFailure(error);
        });
        const name = rasterFileName(job.docId, job.pageIndex, job.revision);
        const uri =
          raster.fileUri !== undefined
            ? storage.adoptOverlayPng(name, raster.fileUri)
            : storage.writeOverlayPng(
                name,
                raster.pngDataUri.replace(/^data:image\/png;base64,/, ''),
              );
        console.log(
          `PdfPrerender: ${job.docId} page ${job.pageIndex + 1} pre-rendered via ${choice.kind} ` +
            `in ${Date.now() - startedAt} ms (open ${raster.loadMs} ms, render ${raster.renderMs} ms)`,
        );
        return uri;
      })().finally(() => {
        if (pending.get(cacheKey) === render) pending.delete(cacheKey);
      });
      pending.set(cacheKey, render);

      try {
        await render;
        // Only the transition this worker owns: if the map joined the render,
        // it has written its own outcome for the page.
        const status = useOverlayStatusStore.getState();
        if (status.statuses[statusKey]?.phase === 'preparing')
          status.setStatus(statusKey, { phase: 'rendered' });
      } catch (err) {
        useOverlayStatusStore.getState().clearStatus(statusKey, 'preparing');
        if (disposed || isPdfRenderCancellation(err)) return;
        if (err instanceof PdfRenderNotStartedError) {
          // Never reached the engine (queue expiry behind interactive work,
          // engine not ready): try again later, a bounded number of times.
          queue = requeuePrerender(queue, job);
          return;
        }
        reportError(err, 'pdf-prerender');
      }
    };

    const pump = (): void => {
      if (disposed || running || !appActive) return;
      const next = takeNextPrerender(queue, useLibraryStore.getState().maps, isCached);
      queue = next.queue;
      if (next.job === null) return;
      running = true;
      void run(next.job).finally(() => {
        running = false;
        pump();
      });
    };

    const onLibrary = (state: { hydrated: boolean; maps: readonly MapDocument[] }): void => {
      if (!state.hydrated) return;
      if (seen === null) {
        seen = detectNewDocuments(new Set(), state.maps).seen;
        return;
      }
      const { seen: next, added } = detectNewDocuments(seen, state.maps);
      seen = next;
      if (added.length === 0) return;
      queue = enqueuePrerender(queue, added.flatMap(prerenderJobsForDocument), isCached);
      pump();
    };
    onLibrary(useLibraryStore.getState());
    const unsubscribe = useLibraryStore.subscribe(onLibrary);

    const appState = AppState.addEventListener('change', (state) => {
      appActive = isForeground(state);
      if (appActive) pump();
    });

    return () => {
      disposed = true;
      unsubscribe();
      appState.remove();
    };
    // Both are stable for the life of the provider.
  }, [rasterize, serverOrigin]);
}

/** `inactive` (iOS app switcher, permission dialogs) counts as not in front. */
function isForeground(state: AppStateStatus | null | undefined): boolean {
  return state !== 'background' && state !== 'inactive';
}

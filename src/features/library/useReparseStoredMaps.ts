import { parseGeoPdf } from '@core/geo/geopdf';
import { applyReparse, planReparse, type ReparseJob } from '@core/library/reparse';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';
import { useLibraryStore } from '@state/libraryStore';
import { useEffect } from 'react';

/**
 * Re-parse stored maps whose georeferencing predates the current parser (#336).
 *
 * Parsing happens once, at import, and is persisted — so every parser fix
 * reached new imports only, and a map imported before it kept the wrong
 * corners forever. An Anticosti sheet was still drawing upside down on an
 * owner's phone weeks after the fix for it shipped.
 *
 * Runs once per launch, after the library hydrates: one map at a time, off the
 * back of the random-access reader (#328), so catching up a 216 MB sheet costs
 * a few hundred KB rather than reading it whole. Everything it touches is
 * metadata; the PDF on disk and the rendered rasters are untouched, and the
 * overlay hook picks up the new corners on its next pass.
 *
 * Deliberately quiet: no card status and no toast. This is a correction the
 * user did not ask for, it finishes in milliseconds per map, and the only
 * visible effect is a map that was wrong becoming right.
 */

/** Yield between maps so a long library cannot hold the first frame. */
const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function reparseOne(job: ReparseJob): void {
  // Gone, renamed or replaced since the queue was planned.
  const doc = useLibraryStore.getState().maps.find((m) => m.id === job.docId);
  if (!doc || doc.fileUri !== job.fileUri) return;

  const parsed = storage.withFileByteSource(job.fileUri, (source) => parseGeoPdf(source));
  const patch = applyReparse(doc, parsed);
  if (patch === null) {
    // A parse that lost every georeference the stored one had. Never replace
    // on that: far likelier a short read than a map that stopped being
    // georeferenced.
    reportError(
      new Error(`re-parse of "${job.name}" found no georeferencing; keeping the stored one`),
      'pdf-reparse',
    );
    return;
  }
  useLibraryStore.getState().updateMap(job.docId, patch);
}

/**
 * Work through every stale map, one at a time. Resolves when the queue is
 * drained or `isCancelled` says the caller has gone away — so a test can await
 * it instead of guessing at timers.
 */
export async function reparseStoredMaps(isCancelled: () => boolean = () => false): Promise<void> {
  const jobs = planReparse(useLibraryStore.getState().maps);
  for (const job of jobs) {
    if (isCancelled()) return;
    try {
      reparseOne(job);
    } catch (err) {
      // A map that cannot be re-parsed keeps exactly what it had. The report
      // is what turns a silent no-op into something we can chase.
      reportError(err, 'pdf-reparse');
    }
    await yieldToUi();
  }
}

/** Mounts {@link reparseStoredMaps} once, after the library has hydrated. */
export function useReparseStoredMaps(): void {
  const hydrated = useLibraryStore((s) => s.hydrated);

  useEffect(() => {
    if (!hydrated) return;
    let disposed = false;
    void reparseStoredMaps(() => disposed);
    return () => {
      disposed = true;
    };
  }, [hydrated]);
}

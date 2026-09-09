import { bboxFromCorners, cornersAreValid, isDegenerateBBox } from '@core/geo/geomath';
import { renderedPageCorners } from '@core/geo/geopdf/pageBox';
import { primaryGeoreferenceForPage } from '@core/geo/geopdf/primary';
import type { GeoReference, MapDocument } from '@core/models';
import { documentRevision } from './overlayRaster';

/**
 * Scheduling for the import-time overlay pre-render (#272 step 2).
 *
 * Rasterizing a georeferenced PDF page costs 2–18 s of pdf.js painting on a
 * mid-range phone (#269) and used to be paid the moment the user opened the
 * map tab. Instead, every active georeferenced page of a freshly imported
 * document is queued here and drawn in the background, at the lowest
 * priority, into the same cache file the overlay hook reads — so by the time
 * the map first draws the page, its raster is already on disk.
 *
 * Pure: the worker in `@features/map/usePrerenderOnImport` owns the timers,
 * the rasterizer and the filesystem; this module owns what to render, in what
 * order, and when to give up.
 */

export interface PrerenderJob {
  docId: string;
  pageIndex: number;
  /** `documentRevision` at enqueue time; a replaced PDF invalidates the job. */
  revision: string;
  fileUri: string;
  importedAt: number;
  geo: GeoReference;
  /** Times the rasterizer refused the job before it started (queue expiry, engine unready). */
  attempts: number;
}

/**
 * A job that could not be *started* (never a render that failed) is retried
 * this many times in total before it is dropped. The map's own overlay path
 * still renders the page when it is needed, so giving up here costs nothing
 * but the head start.
 */
export const PRERENDER_MAX_ATTEMPTS = 3;

/** One page of one document revision — the identity a job is deduplicated by. */
export function prerenderJobKey(
  job: Pick<PrerenderJob, 'docId' | 'pageIndex' | 'revision'>,
): string {
  return `${job.docId}:${job.revision}:${job.pageIndex}`;
}

/** `${id}:${revision}` — what makes a library entry "a document we have seen". */
export function documentRevisionKey(
  map: Pick<MapDocument, 'id' | 'importedAt' | 'fileUri'>,
): string {
  return `${map.id}:${documentRevision(map)}`;
}

/**
 * The pages of `map` worth pre-rendering: every distinct active page with a
 * primary georeference whose placement is valid, in page order. Unplaceable
 * pages are skipped silently — the overlay hook reports those (#243) when the
 * map is opened; pre-rendering them would only waste the render.
 */
export function prerenderJobsForDocument(map: MapDocument): PrerenderJob[] {
  if (!map.fileUri) return [];
  const revision = documentRevision(map);
  const jobs: PrerenderJob[] = [];
  for (const pageIndex of [...new Set(map.activePages)].sort((a, b) => a - b)) {
    const geo = primaryGeoreferenceForPage(map.georeferences, pageIndex);
    if (!geo || !isPlaceable(geo)) continue;
    jobs.push({
      docId: map.id,
      pageIndex,
      revision,
      fileUri: map.fileUri,
      importedAt: map.importedAt,
      geo,
      attempts: 0,
    });
  }
  return jobs;
}

function isPlaceable(geo: GeoReference): boolean {
  try {
    const corners = renderedPageCorners(geo);
    return cornersAreValid(corners) && !isDegenerateBBox(bboxFromCorners(corners));
  } catch {
    return false;
  }
}

/**
 * Which library entries are new since the last look: a document id/revision
 * pair not in `seen`. Covers every import path at once — picker, store
 * download, map maker — and a store *update* too, which keeps the id but
 * swaps the file (new revision). Documents present at hydration are seeded
 * into `seen` by the caller and never pre-rendered: this is an import-time
 * head start, not a library-wide re-render.
 */
export function detectNewDocuments(
  seen: ReadonlySet<string>,
  maps: readonly MapDocument[],
): { seen: ReadonlySet<string>; added: MapDocument[] } {
  const next = new Set<string>();
  const added: MapDocument[] = [];
  for (const map of maps) {
    const key = documentRevisionKey(map);
    next.add(key);
    if (!seen.has(key)) added.push(map);
  }
  return { seen: next, added };
}

/**
 * Append `jobs` to `queue`, skipping pages already queued and pages whose
 * raster is already on disk. Order is preserved: documents in import order,
 * pages in page order.
 */
export function enqueuePrerender(
  queue: readonly PrerenderJob[],
  jobs: readonly PrerenderJob[],
  isCached: (job: PrerenderJob) => boolean,
): PrerenderJob[] {
  const queued = new Set(queue.map(prerenderJobKey));
  const next = [...queue];
  for (const job of jobs) {
    const key = prerenderJobKey(job);
    if (queued.has(key) || isCached(job)) continue;
    queued.add(key);
    next.push(job);
  }
  return next;
}

/**
 * The next job to run, and the queue without it. Jobs that no longer matter
 * are dropped on the way: the document was deleted, its PDF was replaced
 * (revision changed), the page was deactivated, or the raster appeared on
 * disk meanwhile (the map rendered it first).
 */
export function takeNextPrerender(
  queue: readonly PrerenderJob[],
  maps: readonly MapDocument[],
  isCached: (job: PrerenderJob) => boolean,
): { job: PrerenderJob | null; queue: PrerenderJob[] } {
  const live = new Map(maps.map((m) => [m.id, m]));
  for (let i = 0; i < queue.length; i += 1) {
    const job = queue[i];
    if (job === undefined) continue;
    const map = live.get(job.docId);
    const stillWanted =
      map !== undefined &&
      documentRevision(map) === job.revision &&
      map.activePages.includes(job.pageIndex) &&
      !isCached(job);
    if (stillWanted) return { job, queue: queue.slice(i + 1) };
  }
  return { job: null, queue: [] };
}

/**
 * Put a job that never started back at the end of the line, or drop it once
 * it has used up its attempts. A job the rasterizer *did* run and failed is
 * never requeued: the same page would fail the same way.
 */
export function requeuePrerender(
  queue: readonly PrerenderJob[],
  job: PrerenderJob,
): PrerenderJob[] {
  const attempts = job.attempts + 1;
  if (attempts >= PRERENDER_MAX_ATTEMPTS) return [...queue];
  return [...queue, { ...job, attempts }];
}

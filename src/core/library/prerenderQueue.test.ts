import type { GeoReference, MapDocument } from '@core/models';
import { documentRevision } from './overlayRaster';
import {
  PRERENDER_MAX_ATTEMPTS,
  detectNewDocuments,
  documentRevisionKey,
  enqueuePrerender,
  prerenderJobKey,
  prerenderJobsForDocument,
  requeuePrerender,
  takeNextPrerender,
  type PrerenderJob,
} from './prerenderQueue';

const geo = (pageIndex: number, size = 100): GeoReference => ({
  pageIndex,
  source: 'adobe-geo',
  pageWidthPt: 100,
  pageHeightPt: 100,
  viewport: {
    rect: { x0: 0, y0: 0, x1: size, y1: size },
    corners: {
      topLeft: [-71, 47],
      topRight: [-70, 47],
      bottomRight: [-70, 46],
      bottomLeft: [-71, 46],
    },
  },
  bbox: { minLat: 46, maxLat: 47, minLng: -71, maxLng: -70 },
});

/** UTM metres that never became lon/lat (#243): unplaceable. */
const unprojected: GeoReference = {
  ...geo(1),
  viewport: {
    rect: { x0: 0, y0: 0, x1: 100, y1: 100 },
    corners: {
      topLeft: [500000, 5200000],
      topRight: [560000, 5200000],
      bottomRight: [560000, 5150000],
      bottomLeft: [500000, 5150000],
    },
  },
};

const sheet = (id: string, over: Partial<MapDocument> = {}): MapDocument => ({
  id,
  name: id,
  fileUri: `file://documents/maps/${id}.pdf`,
  importedAt: 1,
  pageCount: 2,
  georeferences: [geo(0), geo(1)],
  activePages: [0, 1],
  ...over,
});

const never = () => false;

describe('prerenderJobsForDocument', () => {
  it('lists every distinct active page in page order, with its primary georeference', () => {
    const map = sheet('m', {
      // Pre-primary-viewport builds persisted one entry per viewport ([1, 1, 0]).
      activePages: [1, 1, 0],
      georeferences: [geo(0, 40), geo(0, 90), geo(1)],
    });
    const jobs = prerenderJobsForDocument(map);
    expect(jobs.map((j) => j.pageIndex)).toEqual([0, 1]);
    expect(jobs[0]?.geo.viewport.rect.x1).toBe(90);
    expect(jobs.every((j) => j.revision === documentRevision(map) && j.attempts === 0)).toBe(true);
    expect(jobs[0]).toMatchObject({ docId: 'm', fileUri: map.fileUri, importedAt: 1 });
  });

  it('skips inactive pages, pages without georeference, and unplaceable ones', () => {
    expect(
      prerenderJobsForDocument(
        sheet('m', { activePages: [0, 1, 2], georeferences: [geo(0), unprojected] }),
      ).map((j) => j.pageIndex),
    ).toEqual([0]);
  });

  it('is empty for a map without a file or without active pages', () => {
    expect(prerenderJobsForDocument(sheet('m', { fileUri: '' }))).toEqual([]);
    expect(prerenderJobsForDocument(sheet('m', { activePages: [] }))).toEqual([]);
  });
});

describe('detectNewDocuments', () => {
  it('reports documents not seen before and the new seen set', () => {
    const a = sheet('a');
    const first = detectNewDocuments(new Set(), [a]);
    expect(first.added).toEqual([a]);
    const b = sheet('b');
    const second = detectNewDocuments(first.seen, [b, a]);
    expect(second.added).toEqual([b]);
    expect(detectNewDocuments(second.seen, [b, a]).added).toEqual([]);
  });

  // A store update keeps the library id but swaps the PDF underneath: that is
  // a new document as far as its rasters are concerned.
  it('treats a replaced file (new revision) as a new document', () => {
    const a = sheet('a');
    const { seen } = detectNewDocuments(new Set(), [a]);
    const updated = { ...a, importedAt: 2, fileUri: 'file://documents/maps/a2.pdf' };
    expect(detectNewDocuments(seen, [updated]).added).toEqual([updated]);
    expect(documentRevisionKey(updated)).not.toBe(documentRevisionKey(a));
  });

  it('forgets deleted documents so a re-import of the same id counts as new', () => {
    const a = sheet('a');
    const { seen } = detectNewDocuments(new Set(), [a]);
    const { seen: afterDelete } = detectNewDocuments(seen, []);
    expect(detectNewDocuments(afterDelete, [a]).added).toEqual([a]);
  });
});

describe('enqueuePrerender', () => {
  const jobs = prerenderJobsForDocument(sheet('m'));

  it('appends in order and never queues the same page twice', () => {
    const once = enqueuePrerender([], jobs, never);
    expect(once.map(prerenderJobKey)).toEqual(jobs.map(prerenderJobKey));
    expect(enqueuePrerender(once, jobs, never)).toHaveLength(2);
    const more = enqueuePrerender(once, prerenderJobsForDocument(sheet('n')), never);
    expect(more.map((j) => j.docId)).toEqual(['m', 'm', 'n', 'n']);
  });

  it('skips pages whose raster is already on disk', () => {
    const queued = enqueuePrerender([], jobs, (job) => job.pageIndex === 0);
    expect(queued.map((j) => j.pageIndex)).toEqual([1]);
  });

  it('does not mutate the input queue', () => {
    const input: PrerenderJob[] = [];
    enqueuePrerender(input, jobs, never);
    expect(input).toEqual([]);
  });
});

describe('takeNextPrerender', () => {
  const m = sheet('m');
  const n = sheet('n');
  const queue = enqueuePrerender(
    [],
    [...prerenderJobsForDocument(m), ...prerenderJobsForDocument(n)],
    never,
  );

  it('hands out jobs in queue order and shortens the queue', () => {
    const first = takeNextPrerender(queue, [m, n], never);
    expect(first.job).toMatchObject({ docId: 'm', pageIndex: 0 });
    expect(first.queue).toHaveLength(3);
    const second = takeNextPrerender(first.queue, [m, n], never);
    expect(second.job).toMatchObject({ docId: 'm', pageIndex: 1 });
  });

  it('drops jobs of a document deleted meanwhile', () => {
    const { job, queue: rest } = takeNextPrerender(queue, [n], never);
    expect(job).toMatchObject({ docId: 'n', pageIndex: 0 });
    expect(rest.map((j) => j.docId)).toEqual(['n']);
  });

  it('drops jobs whose PDF was replaced (revision changed)', () => {
    const replaced = { ...m, importedAt: 9 };
    const { job } = takeNextPrerender(queue, [replaced, n], never);
    expect(job).toMatchObject({ docId: 'n' });
  });

  it('drops jobs for pages deactivated meanwhile', () => {
    const { job } = takeNextPrerender(queue, [{ ...m, activePages: [1] }, n], never);
    expect(job).toMatchObject({ docId: 'm', pageIndex: 1 });
  });

  it('drops jobs the map rendered first (raster now cached)', () => {
    const { job } = takeNextPrerender(queue, [m, n], (j) => j.docId === 'm');
    expect(job).toMatchObject({ docId: 'n', pageIndex: 0 });
  });

  it('returns null and an empty queue when nothing is wanted any more', () => {
    expect(takeNextPrerender(queue, [], never)).toEqual({ job: null, queue: [] });
    expect(takeNextPrerender([], [m], never)).toEqual({ job: null, queue: [] });
  });
});

describe('requeuePrerender', () => {
  const [job] = prerenderJobsForDocument(sheet('m'));
  if (job === undefined) throw new Error('fixture has no job');

  it('moves a job that never started to the back, counting the attempt', () => {
    const other = { ...job, pageIndex: 1 };
    const next = requeuePrerender([other], job);
    expect(next.map((j) => j.pageIndex)).toEqual([1, 0]);
    expect(next[1]?.attempts).toBe(1);
  });

  it('drops the job once its attempts are used up', () => {
    let queue: PrerenderJob[] = [job];
    for (let i = 0; i < PRERENDER_MAX_ATTEMPTS; i += 1) {
      const [current, ...rest] = queue;
      if (current === undefined) break;
      queue = requeuePrerender(rest, current);
      expect(queue.length).toBe(i + 1 < PRERENDER_MAX_ATTEMPTS ? 1 : 0);
    }
    expect(queue).toEqual([]);
  });
});

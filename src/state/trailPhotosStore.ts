import type { SidecarStatus, TrackPhoto } from '@core/photos/model';
import { photoSummaryChanged, trailPhotoSummary } from '@core/photos/summary';
import type { TrailPosition } from '@core/photos/trackIndex';
import { editTrailPhoto, readTrailPhotos, removeTrailPhoto } from '@data/photos/trailPhotos';
import { reportError } from '@lib/errorReporting';
import { useEffect } from 'react';
import { create } from 'zustand';

import { useLibraryStore } from './libraryStore';

/**
 * Trail photos in memory (#587), loaded per trail on demand from its sidecar
 * (`photos/<trackId>/photos.json`) — never all at launch.
 *
 * Every screen that shows a trail's photos (trail view, viewer, main map)
 * reads them here, so an edit in the viewer or a finished import shows up
 * everywhere at once. The library index keeps only the count and cover
 * (`TrackSummary.photoCount` / `coverPhotoId`), refreshed here whenever the
 * photo set changes.
 *
 * `status` is what the sidecar read found. Only `ok` and `missing` may be
 * written over: an `unreadable` file, or one a newer app version wrote
 * (`future`), shows what it can and blocks every edit — the data layer
 * refuses those writes too (`SidecarUnavailableError`).
 */

export type TrailPhotosStatus = 'loading' | SidecarStatus | 'error';

export interface TrailPhotosEntry {
  status: TrailPhotosStatus;
  /** Live photos in time order (the viewer's order). Hidden ones included. */
  photos: TrackPhoto[];
}

/** Whether a trail's photos can be added to or edited. */
export function photosEditable(status: TrailPhotosStatus | undefined): boolean {
  return status === 'ok' || status === 'missing';
}

const EMPTY: TrailPhotosEntry = { status: 'loading', photos: [] };

interface TrailPhotosState {
  byTrack: Record<string, TrailPhotosEntry>;
  /** Read a trail's sidecar (again, with `force`). Never rejects. */
  load: (trackId: string, opts?: { force?: boolean }) => Promise<void>;
  /** The trail's photos changed on disk (an import, a capture, a trim): read them again. */
  refresh: (trackId: string) => Promise<void>;
  /** Caption / hide / move one photo. Rejects with `SidecarUnavailableError` when blocked. */
  editPhoto: (
    trackId: string,
    photoId: string,
    patch: { caption?: string; hidden?: boolean; position?: TrailPosition },
  ) => Promise<TrackPhoto | null>;
  /** "Remove from trail". Rejects with `SidecarUnavailableError` when blocked. */
  removePhoto: (trackId: string, photoId: string) => Promise<boolean>;
  /** Drop a trail from memory (it was deleted). */
  forget: (trackId: string) => void;
}

const inflight = new Map<string, Promise<void>>();

/** Keep the library's cached count and cover in step with the photos (one write, only on change). */
function syncLibrarySummary(trackId: string, photos: readonly TrackPhoto[]): void {
  const lib = useLibraryStore.getState();
  const track = lib.tracks.find((t) => t.id === trackId);
  if (!track || !lib.hydrated) return;
  const next = trailPhotoSummary(photos);
  if (!photoSummaryChanged(track, next)) return;
  try {
    lib.updateTrack(trackId, { photoCount: next.photoCount, coverPhotoId: next.coverPhotoId });
  } catch (err) {
    // A cache: the sidecar is the truth, and the next load tries again.
    reportError(err, 'trail-photo-summary');
  }
}

export const useTrailPhotosStore = create<TrailPhotosState>((set, get) => {
  const put = (trackId: string, entry: TrailPhotosEntry) =>
    set((s) => ({ byTrack: { ...s.byTrack, [trackId]: entry } }));

  const read = (trackId: string): Promise<void> => {
    const running = inflight.get(trackId);
    if (running) return running;
    const job = (async () => {
      try {
        const { status, photos } = await readTrailPhotos(trackId);
        put(trackId, { status, photos });
        if (status === 'ok' || status === 'missing') syncLibrarySummary(trackId, photos);
      } catch (err) {
        reportError(err, 'trail-photos-load');
        put(trackId, { status: 'error', photos: get().byTrack[trackId]?.photos ?? [] });
      } finally {
        inflight.delete(trackId);
      }
    })();
    inflight.set(trackId, job);
    return job;
  };

  return {
    byTrack: {},

    load: (trackId, opts) => {
      const current = get().byTrack[trackId];
      if (current && current.status !== 'error' && !opts?.force) return Promise.resolve();
      if (!current) put(trackId, EMPTY);
      return read(trackId);
    },

    refresh: (trackId) => read(trackId),

    editPhoto: async (trackId, photoId, patch) => {
      const updated = await editTrailPhoto(trackId, photoId, patch);
      await read(trackId);
      return updated;
    },

    removePhoto: async (trackId, photoId) => {
      const removed = await removeTrailPhoto(trackId, photoId);
      await read(trackId);
      return removed;
    },

    forget: (trackId) =>
      set((s) => {
        if (!(trackId in s.byTrack)) return s;
        const { [trackId]: _gone, ...rest } = s.byTrack;
        return { byTrack: rest };
      }),
  };
});

const NO_PHOTOS: TrailPhotosEntry = { status: 'missing', photos: [] };

/** A trail's photos, loading them on first use. `null` id → no photos. */
export function useTrailPhotos(trackId: string | null | undefined): TrailPhotosEntry {
  const entry = useTrailPhotosStore((s) => (trackId ? s.byTrack[trackId] : undefined));
  useEffect(() => {
    if (trackId) void useTrailPhotosStore.getState().load(trackId);
  }, [trackId]);
  if (!trackId) return NO_PHOTOS;
  return entry ?? EMPTY;
}

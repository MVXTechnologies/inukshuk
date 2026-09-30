import type { TrailDetail, TrailIndex } from '@core/trails/schema';
import { loadTrailDetail, loadTrailIndex } from '@data/longTrails';
import { create } from 'zustand';

/**
 * The long-distance trails (#467): the index Explore ranks and lists, the
 * details opened this session, and the one trail shown on the main map with
 * its selected stage. Transient — the index and details are cached on disk by
 * `@data/longTrails`; which trail is on the map is not remembered across
 * launches (it is a look, not a plan).
 */

export type LongTrailsStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface ShownTrail {
  detail: TrailDetail;
  /** Selected stage, null for a stage-less trail (or the whole trail). */
  stageIndex: number | null;
}

interface LongTrailsState {
  status: LongTrailsStatus;
  index: TrailIndex | null;
  fromCache: boolean;
  details: Record<string, TrailDetail>;
  /** Detail ids being fetched, or that failed (value false). */
  detailStatus: Record<string, 'loading' | 'failed'>;
  shown: ShownTrail | null;
  load: (force?: boolean) => Promise<void>;
  loadDetail: (id: string) => Promise<TrailDetail | null>;
  show: (detail: TrailDetail, stageIndex: number | null) => void;
  setStage: (stageIndex: number | null) => void;
  hide: () => void;
}

let indexRequest: Promise<void> | null = null;

export const useLongTrailsStore = create<LongTrailsState>((set, get) => ({
  status: 'idle',
  index: null,
  fromCache: false,
  details: {},
  detailStatus: {},
  shown: null,

  load: (force = false) => {
    if (indexRequest !== null) return indexRequest;
    if (!force && get().status === 'ready') return Promise.resolve();
    set({ status: get().index === null ? 'loading' : get().status });
    indexRequest = loadTrailIndex({ force })
      .then((result) => {
        if (result === null) {
          if (get().index === null) set({ status: 'unavailable' });
          return;
        }
        set({ status: 'ready', index: result.index, fromCache: result.fromCache });
      })
      .catch(() => {
        if (get().index === null) set({ status: 'unavailable' });
      })
      .finally(() => {
        indexRequest = null;
      });
    return indexRequest;
  },

  loadDetail: async (id) => {
    const have = get().details[id];
    if (have !== undefined) return have;
    const index = get().index;
    if (index === null) return null;
    set({ detailStatus: { ...get().detailStatus, [id]: 'loading' } });
    const detail = await loadTrailDetail(id, index.detailsVersion).catch(() => null);
    const { [id]: _done, ...rest } = get().detailStatus;
    if (detail === null) {
      set({ detailStatus: { ...rest, [id]: 'failed' } });
      return null;
    }
    set({ details: { ...get().details, [id]: detail }, detailStatus: rest });
    return detail;
  },

  show: (detail, stageIndex) => set({ shown: { detail, stageIndex } }),
  setStage: (stageIndex) => {
    const shown = get().shown;
    if (shown !== null) set({ shown: { ...shown, stageIndex } });
  },
  hide: () => set({ shown: null }),
}));

/** Test hook: forget the in-flight request. */
export function resetLongTrailsStore(): void {
  indexRequest = null;
  useLongTrailsStore.setState({
    status: 'idle',
    index: null,
    fromCache: false,
    details: {},
    detailStatus: {},
    shown: null,
  });
}

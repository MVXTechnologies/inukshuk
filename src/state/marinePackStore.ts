import { parseFloat32Grid } from '@core/geo/floatTiff';
import {
  MARINE_PACK_MAX_AGE_MS,
  estimatePackBytes,
  parsePackCellKey,
  stalePackKeys,
  type MarinePackCell,
  type MarinePackRecord,
} from '@core/geo/marinePacks';
import { marineGridUrls, marineSourceById, type MarineSource } from '@core/geo/marineSources';
import { assessFreeSpaceForWrite } from '@data/diskSpace';
import * as packs from '@data/marinePacks';
import { create } from 'zustand';

/**
 * Offline marine packs — lifecycle (marine wave D §D4). Mirrors
 * `offlineStore`: hydrate from disk, a single foreground download with a
 * coarse progress readout, per-item delete, and a silent staleness sweep.
 *
 * The download is deliberately sequential and abortable: one WCS/ImageServer
 * subset at a time, each validated by the float32 GeoTIFF parser BEFORE it
 * is written, so an XML error body or a truncated response can never land on
 * disk pretending to be depth data. A failed cell is skipped, not retried
 * forever — a partial pack is honest (its cells simply aren't in the index)
 * and the banner will offer the rest again later.
 */

/** Per-cell wall clock: a native survey subset answered in ~1 s live. */
const CELL_TIMEOUT_MS = 45_000;

export interface MarinePackProgress {
  done: number;
  total: number;
  /** Source label, for the snackbar copy. */
  label: string;
}

interface MarinePackState {
  packs: MarinePackRecord[];
  /** Installed cell keys — the shape the pure trigger logic wants. */
  installed: ReadonlySet<string>;
  progress: MarinePackProgress | null;
  hydrated: boolean;
  totalBytes: number;
  hydrate: () => Promise<void>;
  /**
   * Fetch and store a set of cells; resolves with the number stored. Cells
   * already on disk are skipped unless `force` (the staleness refresh).
   */
  download: (
    source: MarineSource,
    cells: readonly MarinePackCell[],
    options?: { force?: boolean },
  ) => Promise<number>;
  cancel: () => void;
  remove: (key: string) => Promise<void>;
  removeAll: () => Promise<void>;
  /** Silent refresh of packs older than 30 days (app foreground, online). */
  refreshStale: (now?: number) => Promise<void>;
}

function derive(
  records: MarinePackRecord[],
): Pick<MarinePackState, 'packs' | 'installed' | 'totalBytes'> {
  const sorted = [...records].sort((a, b) => a.key.localeCompare(b.key));
  return {
    packs: sorted,
    installed: new Set(sorted.map((r) => r.key)),
    totalBytes: sorted.reduce((sum, r) => sum + r.bytes, 0),
  };
}

/**
 * Fetch one cell's grid. NONNA answers two coverages — the dense 10 m grid
 * and the 100 m grid that fills its fringe; a cell where the dense survey is
 * blank falls back to the coarse one rather than storing an empty file.
 */
async function fetchCellBytes(
  source: MarineSource,
  cell: MarinePackCell,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const maxDim = source.grid?.maxPackDim ?? 512;
  for (const url of marineGridUrls(source, cell.bbox, maxDim)) {
    const res = await fetch(url, { signal });
    if (!res.ok) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const grid = parseFloat32Grid(bytes);
    if (grid === null) continue;
    for (let i = 0; i < grid.data.length; i++) {
      const v = grid.data[i];
      if (v !== undefined && Number.isFinite(v) && Math.abs(v) < 3e38) return bytes;
    }
  }
  return null;
}

let activeRun: AbortController | null = null;

export const useMarinePackStore = create<MarinePackState>((set, get) => ({
  packs: [],
  installed: new Set<string>(),
  progress: null,
  hydrated: false,
  totalBytes: 0,

  hydrate: async () => {
    const records = await packs.readPackIndex();
    set({ ...derive(records), hydrated: true });
  },

  cancel: () => {
    activeRun?.abort();
    activeRun = null;
    set({ progress: null });
  },

  download: async (source, cells, options) => {
    if (cells.length === 0 || source.grid === null) return 0;
    const wanted =
      options?.force === true ? [...cells] : cells.filter((c) => !get().installed.has(c.key));
    if (wanted.length === 0) return 0;
    // Disk-budget guard, exactly like the offline-region downloader.
    const assessment = assessFreeSpaceForWrite(estimatePackBytes(source, wanted));
    if (assessment?.verdict === 'block') {
      throw new Error(assessment.message ?? 'Not enough free space');
    }

    activeRun?.abort();
    const ctl = new AbortController();
    activeRun = ctl;
    set({ progress: { done: 0, total: wanted.length, label: source.label } });
    const stored: MarinePackRecord[] = [];
    try {
      for (let i = 0; i < wanted.length; i++) {
        const cell = wanted[i];
        if (cell === undefined) continue;
        if (ctl.signal.aborted) break;
        const kill = setTimeout(() => ctl.abort(), CELL_TIMEOUT_MS);
        try {
          const bytes = await fetchCellBytes(source, cell, ctl.signal);
          if (bytes !== null) {
            const written = packs.writePackCell(cell.key, bytes);
            stored.push({
              key: cell.key,
              sourceId: source.id,
              bbox: cell.bbox,
              bytes: written,
              updatedAt: Date.now(),
            });
          }
        } catch {
          // Offline, aborted, unreachable, disk full: skip this cell. The
          // ones already stored stay — a partial pack is still useful.
        } finally {
          clearTimeout(kill);
        }
        set({ progress: { done: i + 1, total: wanted.length, label: source.label } });
      }
    } finally {
      if (stored.length > 0) {
        const merged = [
          ...get().packs.filter((p) => !stored.some((s) => s.key === p.key)),
          ...stored,
        ];
        packs.writePackIndex(merged);
        set(derive(merged));
      }
      if (activeRun === ctl) activeRun = null;
      set({ progress: null });
    }
    return stored.length;
  },

  remove: async (key) => {
    packs.deletePackCell(key);
    const merged = get().packs.filter((p) => p.key !== key);
    packs.writePackIndex(merged);
    set(derive(merged));
    await Promise.resolve();
  },

  removeAll: async () => {
    packs.deleteAllPackCells();
    packs.writePackIndex([]);
    set(derive([]));
    await Promise.resolve();
  },

  refreshStale: async (now = Date.now()) => {
    const stale = stalePackKeys(get().packs, now, MARINE_PACK_MAX_AGE_MS);
    if (stale.length === 0) return;
    // Group by source so each run reuses one catalog entry. The index is
    // left ALONE until a replacement actually lands: a failed refresh must
    // leave the old (still perfectly usable) pack in place, never a hole.
    const cells = stale.map(parsePackCellKey).filter((c): c is MarinePackCell => c !== null);
    const bySource = new Map<MarineSource['id'], MarinePackCell[]>();
    for (const cell of cells) {
      const list = bySource.get(cell.sourceId) ?? [];
      list.push(cell);
      bySource.set(cell.sourceId, list);
    }
    for (const [sourceId, group] of bySource) {
      try {
        await get().download(marineSourceById(sourceId), group, { force: true });
      } catch {
        // A failed refresh just leaves yesterday's grid in place.
      }
    }
  },
}));

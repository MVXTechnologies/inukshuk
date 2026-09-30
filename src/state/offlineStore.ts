import {
  createRegionPack,
  deleteRegionPack,
  listRegionPacks,
  setTileLimit,
  type OfflineRegion,
} from '@data/offline';
import { deleteRegionName, readRegionNames, saveRegionNames } from '@data/regionNames';
import type { Basemap, PackFormat } from '@core/geo/tiles';
import type { BoundingBox } from '@core/models';
import { reportError } from '@lib/errorReporting';
import { create } from 'zustand';

/**
 * One basemap layer to download for a region: its serialized style and the zoom
 * range to store. The range is per-layer because each tile service tops out at a
 * different zoom (see `packZoomRange`) — relief cannot be downloaded past z15.
 */
export interface DownloadLayer {
  basemap: Basemap;
  /** Default raster; `vector` for our Stone & Paper base map. */
  format?: PackFormat;
  styleJSON: string;
  minZoom: number;
  maxZoom: number;
}

interface DownloadProgress {
  pct: number;
  sizeBytes: number;
  /** Human label for the layer currently downloading, e.g. "Satellite (2/3)". */
  label: string;
}

interface OfflineState {
  regions: OfflineRegion[];
  progress: DownloadProgress | null;
  hydrate: () => Promise<void>;
  /**
   * Download a region for one or more basemaps, sequentially (the loopback style
   * server allows one download at a time). Progress reflects the current layer.
   */
  downloadMany: (args: {
    baseId: string;
    label: string;
    bounds: BoundingBox;
    layers: DownloadLayer[];
  }) => Promise<void>;
  /**
   * Download a SERIES of packs of one layer, sequentially — the boxes of a
   * trail corridor (#467). Progress is the whole series'; a part that fails
   * is reported, the rest still run, but two failures in a row (offline)
   * stop the series.
   */
  downloadSeries: (args: {
    parts: { id: string; label: string; bounds: BoundingBox; minZoom: number }[];
    layer: Omit<DownloadLayer, 'minZoom'>;
    progressLabel: string;
    onProgress?: (fraction: number) => void;
  }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /**
   * Set the display name of one or more regions (several ids when the layers of
   * one download share a name). Persists to the name sidecar — MapLibre pack
   * metadata can't be updated after creation — and updates any already-listed
   * regions in place; regions still downloading pick the name up on refresh.
   */
  rename: (ids: string[], label: string) => Promise<void>;
}

const LAYER_LABEL: Record<Basemap, string> = {
  map: 'Map',
  satellite: 'Satellite',
  relief: 'Relief',
};

/** Native pack list with the persisted name overrides merged over pack labels. */
async function loadRegions(): Promise<OfflineRegion[]> {
  const [packs, names] = await Promise.all([listRegionPacks(), readRegionNames()]);
  return packs.map((region) => {
    const label = names[region.id];
    return label !== undefined ? { ...region, label } : region;
  });
}

export const useOfflineStore = create<OfflineState>((set, get) => ({
  regions: [],
  progress: null,

  hydrate: async () => {
    setTileLimit(50_000); // headroom above the 25k UI cap
    set({ regions: await loadRegions() });
  },

  downloadMany: async (args) => {
    const total = args.layers.length;
    // Each layer is independent: one failing must not abort the others. Collect
    // the failures — WITH their reason, so the user is told *why* the relief
    // layer failed, not merely that it did — and report them together once every
    // layer has been attempted.
    const failed: string[] = [];
    try {
      for (let i = 0; i < args.layers.length; i++) {
        const layer = args.layers[i];
        if (!layer) continue;
        const tag = total > 1 ? ` (${i + 1}/${total})` : '';
        const label = `${LAYER_LABEL[layer.basemap]}${tag}`;
        set({ progress: { pct: 0, sizeBytes: 0, label } });
        try {
          await createRegionPack(
            {
              id: `${args.baseId}-${layer.basemap}`,
              label: args.label,
              basemap: layer.basemap,
              ...(layer.format ? { format: layer.format } : {}),
              styleJSON: layer.styleJSON,
              bounds: args.bounds,
              minZoom: layer.minZoom,
              maxZoom: layer.maxZoom,
            },
            (pct, sizeBytes) => set({ progress: { pct, sizeBytes, label } }),
          );
        } catch (err) {
          reportError(err, 'offline-region-download');
          const reason = err instanceof Error ? err.message : String(err);
          failed.push(`${LAYER_LABEL[layer.basemap]}: ${reason}`);
        }
      }
    } finally {
      set({ progress: null, regions: await loadRegions() });
    }
    if (failed.length > 0) {
      throw new Error(`Download failed — ${failed.join(' · ')}`);
    }
  },

  downloadSeries: async ({ parts, layer, progressLabel, onProgress }) => {
    const failed: string[] = [];
    let streak = 0;
    let doneBytes = 0;
    const total = parts.length;
    try {
      for (let i = 0; i < total; i++) {
        const part = parts[i];
        if (!part) continue;
        const label = `${progressLabel} (${i + 1}/${total})`;
        const report = (pct: number, sizeBytes: number) => {
          const overall = ((i + Math.min(100, pct) / 100) / total) * 100;
          set({ progress: { pct: overall, sizeBytes: doneBytes + sizeBytes, label } });
          onProgress?.(overall / 100);
        };
        report(0, 0);
        try {
          let last = 0;
          await createRegionPack(
            {
              id: part.id,
              label: part.label,
              basemap: layer.basemap,
              ...(layer.format ? { format: layer.format } : {}),
              styleJSON: layer.styleJSON,
              bounds: part.bounds,
              minZoom: part.minZoom,
              maxZoom: layer.maxZoom,
            },
            (pct, sizeBytes) => {
              last = sizeBytes;
              report(pct, sizeBytes);
            },
          );
          doneBytes += last;
          streak = 0;
        } catch (err) {
          reportError(err, 'offline-series-download');
          failed.push(`${i + 1}/${total}: ${err instanceof Error ? err.message : String(err)}`);
          streak += 1;
          if (streak >= 2) break;
        }
      }
    } finally {
      set({ progress: null, regions: await loadRegions() });
    }
    if (failed.length > 0) {
      throw new Error(`Download failed — ${failed.slice(0, 2).join(' · ')}`);
    }
  },

  remove: async (id) => {
    await deleteRegionPack(id);
    await deleteRegionName(id);
    set({ regions: get().regions.filter((r) => r.id !== id) });
  },

  rename: async (ids, label) => {
    await saveRegionNames(Object.fromEntries(ids.map((id) => [id, label])));
    set({
      regions: get().regions.map((r) => (ids.includes(r.id) ? { ...r, label } : r)),
    });
  },
}));

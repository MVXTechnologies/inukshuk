import {
  createRegionPack,
  deleteRegionPack,
  listRegionPacks,
  setTileLimit,
  type OfflineRegion,
} from '@data/offline';
import type { Basemap } from '@core/geo/tiles';
import type { BoundingBox } from '@core/models';
import { reportError } from '@lib/errorReporting';
import { create } from 'zustand';

/** One basemap layer to download for a region, with its serialized style. */
export interface DownloadLayer {
  basemap: Basemap;
  styleJSON: string;
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
    minZoom: number;
    maxZoom: number;
    layers: DownloadLayer[];
  }) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const LAYER_LABEL: Record<Basemap, string> = {
  map: 'Map',
  satellite: 'Satellite',
  relief: 'Relief',
};

export const useOfflineStore = create<OfflineState>((set, get) => ({
  regions: [],
  progress: null,

  hydrate: async () => {
    setTileLimit(50_000); // headroom above the 25k UI cap
    set({ regions: await listRegionPacks() });
  },

  downloadMany: async (args) => {
    const total = args.layers.length;
    // Each layer is independent: one failing must not abort the others. Collect
    // the failures and report them together once every layer has been attempted.
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
              styleJSON: layer.styleJSON,
              bounds: args.bounds,
              minZoom: args.minZoom,
              maxZoom: args.maxZoom,
            },
            (pct, sizeBytes) => set({ progress: { pct, sizeBytes, label } }),
          );
        } catch (err) {
          // The summary error below tells the user which layers failed; the
          // underlying cause would otherwise be lost — report it.
          reportError(err, 'offline-region-download');
          failed.push(LAYER_LABEL[layer.basemap]);
        }
      }
    } finally {
      set({ progress: null, regions: await listRegionPacks() });
    }
    if (failed.length > 0) {
      throw new Error(`${failed.join(', ')} failed to download`);
    }
  },

  remove: async (id) => {
    await deleteRegionPack(id);
    set({ regions: get().regions.filter((r) => r.id !== id) });
  },
}));

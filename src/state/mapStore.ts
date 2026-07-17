import type { Basemap } from '@core/geo/tiles';
import type { BoundingBox } from '@core/models';
import { create } from 'zustand';

/** Base layer drawn under the overlays on the main map (same set as the
 * downloadable {@link Basemap}s — kept as one type so they can't diverge). */
export type MapBasemap = Basemap;

/**
 * Transient map view state that isn't persisted: whether the camera follows the
 * user, overlay visibility toggles, basemap and 3D flags. Which overlays are
 * *active* (PDF pages and trail ids) is persisted state and lives in the
 * library store.
 */
interface MapState {
  followUser: boolean;
  /** Whether PDF map overlays are drawn (visibility toggle, independent of which pages are active). */
  showPdfOverlay: boolean;
  /** Whether trail overlays are drawn. */
  showTrackOverlays: boolean;
  /** Whether the map shows a 3D relief (DEM hillshade + terrain + pitch). */
  terrain3d: boolean;
  /** Base layer: OSM streets, satellite imagery, or a topographic relief map. */
  basemap: MapBasemap;
  /** One-shot request for the map to fit these bounds (e.g. "view trail"). */
  focusBounds: BoundingBox | null;
  /**
   * One-shot request (e.g. from the Library's "Trim" menu item) for the map to
   * open a trail in the inspect panel; `trim: true` additionally enters trim
   * mode once the trail's points are loaded. Consumed and cleared by MapScreen,
   * where the inspection state lives.
   */
  inspectIntent: { trackId: string; trim: boolean } | null;
  setFollowUser: (follow: boolean) => void;
  togglePdfOverlay: () => void;
  toggleTrackOverlays: () => void;
  toggleTerrain3d: () => void;
  setBasemap: (b: MapBasemap) => void;
  setFocusBounds: (b: BoundingBox | null) => void;
  setInspectIntent: (intent: { trackId: string; trim: boolean } | null) => void;
}

export const useMapStore = create<MapState>((set) => ({
  followUser: true,
  showPdfOverlay: true,
  showTrackOverlays: true,
  terrain3d: false,
  basemap: 'map',
  focusBounds: null,
  inspectIntent: null,
  setFocusBounds: (b) => set({ focusBounds: b }),
  setInspectIntent: (intent) => set({ inspectIntent: intent }),
  setFollowUser: (follow) => set({ followUser: follow }),
  togglePdfOverlay: () => set((s) => ({ showPdfOverlay: !s.showPdfOverlay })),
  toggleTrackOverlays: () => set((s) => ({ showTrackOverlays: !s.showTrackOverlays })),
  toggleTerrain3d: () => set((s) => ({ terrain3d: !s.terrain3d })),
  setBasemap: (b) => set({ basemap: b }),
}));

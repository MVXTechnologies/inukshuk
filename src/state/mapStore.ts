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
  /**
   * Whether the active weather overlay plays across its scrubber timeline
   * (transient — playback always starts off on launch; which weather layer
   * is active is persisted in the settings store).
   */
  weatherAnimating: boolean;
  /**
   * The map camera's last settled centre (weather wave B). Written by the
   * map screen on every region settle; read to resolve which forecast model
   * actually covers the place being looked at (HRDPS/RDPS are
   * Canada-domain, GDPS is global — see `@core/weather/modelCoverage`) and
   * whether the Canada-only radar rows should carry their hint. Null until
   * the first settle; consumers treat null as "don't second-guess".
   */
  mapCenter: { latitude: number; longitude: number } | null;
  /** One-shot request for the map to fit these bounds (e.g. "view trail"). */
  focusBounds: BoundingBox | null;
  /**
   * One-shot request (from the Library's "Show on map") for the map to fly the
   * camera to a waypoint's position. Consumed and cleared by the map's camera
   * controls, like {@link focusBounds}.
   */
  focusWaypoint: { latitude: number; longitude: number } | null;
  setFollowUser: (follow: boolean) => void;
  togglePdfOverlay: () => void;
  toggleTrackOverlays: () => void;
  toggleTerrain3d: () => void;
  setBasemap: (b: MapBasemap) => void;
  toggleWeatherAnimation: () => void;
  setMapCenter: (c: { latitude: number; longitude: number } | null) => void;
  setFocusBounds: (b: BoundingBox | null) => void;
  setFocusWaypoint: (target: { latitude: number; longitude: number } | null) => void;
}

export const useMapStore = create<MapState>((set) => ({
  followUser: true,
  showPdfOverlay: true,
  showTrackOverlays: true,
  terrain3d: false,
  basemap: 'map',
  weatherAnimating: false,
  mapCenter: null,
  focusBounds: null,
  focusWaypoint: null,
  setFocusBounds: (b) => set({ focusBounds: b }),
  setFocusWaypoint: (target) => set({ focusWaypoint: target }),
  setFollowUser: (follow) => set({ followUser: follow }),
  togglePdfOverlay: () => set((s) => ({ showPdfOverlay: !s.showPdfOverlay })),
  toggleTrackOverlays: () => set((s) => ({ showTrackOverlays: !s.showTrackOverlays })),
  toggleTerrain3d: () => set((s) => ({ terrain3d: !s.terrain3d })),
  setBasemap: (b) => set({ basemap: b }),
  toggleWeatherAnimation: () => set((s) => ({ weatherAnimating: !s.weatherAnimating })),
  // Written on EVERY camera settle — including rotate/pitch-only gestures and
  // the follow-mode camera moving with each GPS fix, where the centre is
  // unchanged. A fresh object literal there would replace `mapCenter`'s
  // identity every time and re-render every subscriber (the map screen among
  // them) for nothing, so compare the coordinates before storing.
  setMapCenter: (c) =>
    set((s) =>
      s.mapCenter === c ||
      (s.mapCenter !== null &&
        c !== null &&
        s.mapCenter.latitude === c.latitude &&
        s.mapCenter.longitude === c.longitude)
        ? s
        : { mapCenter: c },
    ),
}));

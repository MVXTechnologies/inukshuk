import { normalizeBasemap, type Basemap } from '@core/geo/tiles';
import type { BoundingBox } from '@core/models';
import { create } from 'zustand';

/** Base layer drawn under the overlays on the main map (same set as the
 * downloadable {@link Basemap}s — kept as one type so they can't diverge). */
export type MapBasemap = Basemap;

/**
 * Transient map view state that isn't persisted: whether the camera follows the
 * user, the trails visibility toggle and the basemap. Which overlays are
 * *active* (PDF pages and trail ids) is persisted state and lives in the
 * library store; the "PDF maps" master switch is persisted too and lives in
 * the settings store (`showPdfOverlay`, #233).
 */
interface MapState {
  followUser: boolean;
  /** Whether trail overlays are drawn. */
  showTrackOverlays: boolean;
  /** Base layer: our map or satellite imagery (Relief was retired, #484). */
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
   * Screen padding for that fit, when the caller knows what covers the map
   * (a shown long-distance trail's pill and stage sheet, #472). Null = the
   * default fit padding.
   */
  focusPadding: { top: number; right: number; bottom: number; left: number } | null;
  /**
   * One-shot request (from the Library's "Show on map") for the map to fly the
   * camera to a waypoint's position. Consumed and cleared by the map's camera
   * controls, like {@link focusBounds}.
   */
  focusWaypoint: { latitude: number; longitude: number } | null;
  /**
   * One-shot request (the empty Library's "Record a trail") for the map to
   * open its record-start sheet. The map shows the sheet while this is set
   * and clears it when the sheet starts or is dismissed.
   */
  recordRequested: boolean;
  setRecordRequested: (requested: boolean) => void;
  setFollowUser: (follow: boolean) => void;
  toggleTrackOverlays: () => void;
  setBasemap: (b: MapBasemap) => void;
  toggleWeatherAnimation: () => void;
  setMapCenter: (c: { latitude: number; longitude: number } | null) => void;
  setFocusBounds: (
    b: BoundingBox | null,
    padding?: { top: number; right: number; bottom: number; left: number },
  ) => void;
  setFocusWaypoint: (target: { latitude: number; longitude: number } | null) => void;
}

export const useMapStore = create<MapState>((set) => ({
  followUser: true,
  showTrackOverlays: true,
  basemap: 'map',
  weatherAnimating: false,
  mapCenter: null,
  focusBounds: null,
  focusPadding: null,
  focusWaypoint: null,
  recordRequested: false,
  setRecordRequested: (requested) => set({ recordRequested: requested }),
  setFocusBounds: (b, padding) => set({ focusBounds: b, focusPadding: padding ?? null }),
  setFocusWaypoint: (target) => set({ focusWaypoint: target }),
  setFollowUser: (follow) => set({ followUser: follow }),
  toggleTrackOverlays: () => set((s) => ({ showTrackOverlays: !s.showTrackOverlays })),
  // Normalised: a stale `relief` (retired as a base map, #484) from any
  // caller — an older deep link, a trail viewer seeded before the update —
  // lands on `map` instead of a base map the style can no longer draw.
  setBasemap: (b) => set({ basemap: normalizeBasemap(b) }),
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

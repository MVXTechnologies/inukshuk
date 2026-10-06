import maplibregl, { type Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';

import { ECCC_ATTRIBUTION } from '@core/geo/weatherLayers';
import { OPENFREEMAP_STYLE_URL, type Theme } from '@/ui/theme';

/** Québec City — the app's device-QA reference viewport, so captures compare. */
export const HOME_VIEW = { center: [-71.2075, 46.8139] as [number, number], zoom: 10.4 };

export interface MapView {
  west: number;
  south: number;
  east: number;
  north: number;
  /** Container size in CSS px — what the drape's pixel budget is stated in. */
  widthPt: number;
  heightPt: number;
}

export interface MapCanvasProps {
  theme: Theme;
  /** True while a weather drape is up — selects the muted cartography. */
  muted: boolean;
  /** Opening camera from the URL, when one was named. */
  initialCenter: [number, number] | null;
  initialZoom: number | null;
  /** Fires with the map once it exists, and with a fresh epoch after every
   *  style swap — overlay layers have to be re-added on each new style. */
  onReady: (map: MlMap, styleEpoch: number) => void;
  /** Fires on camera settle (and on resize) with the current viewport. */
  onView: (view: MapView) => void;
}

function readView(map: MlMap): MapView {
  const b = map.getBounds();
  const c = map.getContainer();
  return {
    west: b.getWest(),
    south: b.getSouth(),
    east: b.getEast(),
    north: b.getNorth(),
    widthPt: c.clientWidth,
    heightPt: c.clientHeight,
  };
}

/**
 * The MapLibre GL JS instance.
 *
 * NOTE the divergence from the app that makes this whole project possible:
 * `@maplibre/maplibre-react-native` wraps the iOS/Android SDKs and cannot run
 * in a browser, so there is no sharing a single MapView component between the
 * two. What IS shared is everything the map is *told* — style numbers, drape
 * URLs, timelines, catalog geometry — which is where the decisions live.
 */
export function MapCanvas({
  theme,
  muted,
  initialCenter,
  initialZoom,
  onReady,
  onView,
}: MapCanvasProps) {
  // Which OpenFreeMap cartography this (theme, weather-on) pair asks for.
  const styleId = muted ? theme.mutedBasemapStyle : theme.basemapStyle;
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [epoch, setEpoch] = useState(0);

  // Effects below want the latest callbacks without re-running on every render
  // (re-running the mount effect would destroy and recreate the map). Refs are
  // written in an effect, never during render.
  const onReadyRef = useRef(onReady);
  const onViewRef = useRef(onView);
  useEffect(() => {
    onReadyRef.current = onReady;
    onViewRef.current = onView;
  }, [onReady, onView]);

  // Create once. The style is swapped in the theme effect, never by remounting:
  // a remount would drop the camera, and the whole point is to A/B two themes
  // on the SAME view.
  useEffect(() => {
    const container = holder.current;
    if (container === null) return;

    const map = new maplibregl.Map({
      container,
      style: OPENFREEMAP_STYLE_URL(styleId),
      center: initialCenter ?? HOME_VIEW.center,
      zoom: initialZoom ?? HOME_VIEW.zoom,
      // Tilt is part of the brief ("pan/zoom/tilt") and the app ships a 3D
      // pitched view, so the pitch ceiling is opened up rather than left at
      // MapLibre's default 60.
      maxPitch: 85,
      attributionControl: false,
      // Fractional zoom on a trackpad reads as drift on a map you are trying
      // to judge a colour field on; whole-step wheel zoom is steadier.
      hash: false,
    });
    mapRef.current = map;
    // Dev convenience: poke at the live map from the devtools console
    // (`__map.getStyle()`, `__map.setPaintProperty(...)`) to try a value before
    // committing it to code. Also what the screenshot harness waits on.
    if (import.meta.env.DEV) {
      (window as unknown as { __map?: MlMap }).__map = map;
    }

    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: ECCC_ATTRIBUTION,
      }),
      'bottom-right',
    );
    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true, showZoom: false }),
      'top-right',
    );

    const emitView = () => onViewRef.current(readView(map));

    // `style.load`, NOT `styledata`.
    //
    // `styledata` fires on every change to the style — including the ones this
    // app makes itself. Adding the overlay layers fired it, which bumped the
    // epoch, which tore the overlays down and re-added them, which fired it
    // again: a loop that left the map with no drape and no reference lines at
    // all. `style.load` fires exactly once per loaded style (the first one and
    // each `setStyle`), which is precisely when the previous style's layers
    // have been thrown away and ours have to be rebuilt.
    const onStyleLoad = () => setEpoch((n) => n + 1);

    map.on('load', emitView);
    map.on('moveend', emitView);
    map.on('resize', emitView);
    map.on('style.load', onStyleLoad);

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Mount-only: `theme` is read for the INITIAL style and then owned by the
    // effect below. Re-running this would destroy and recreate the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Basemap swap (theme change, or weather turning on/off), preserving the
  // camera. `setStyle` drops every layer, which is why the overlay stack is
  // rebuilt on the `style.load` that follows.
  const firstStyle = useRef(true);
  useEffect(() => {
    const map = mapRef.current;
    if (map === null) return;
    if (firstStyle.current) {
      firstStyle.current = false;
      return;
    }
    map.setStyle(OPENFREEMAP_STYLE_URL(styleId));
  }, [styleId]);

  // Hand the map (and each new style epoch) to the overlay hooks.
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || epoch === 0) return;
    onReadyRef.current(map, epoch);
  }, [epoch]);

  return <div className="map" ref={holder} />;
}

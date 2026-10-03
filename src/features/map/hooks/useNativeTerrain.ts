import { drapeStyle, type DrapeStyleInput } from '@core/terrain3d/drapeStyle';
import { TERRAIN_MAX_PITCH_DEG } from '@core/terrain3d/morph';
import { packLook, terrainLook, type TerrainBasemap } from '@core/terrain3d/look';
import { nameFieldsFor, packLabelTheme, type TerrainLineSpec } from '@core/terrain3d/sceneInput';
import type { TiltRelief } from '@core/map/tiltRelief';
import { reportError } from '@lib/errorReporting';
import { nativeTerrain, type NativeTerrainConfig } from '@lib/nativeTerrain';
import { palette, schemeTokens } from '@ui/tokens';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { findNodeHandle, type View } from 'react-native';
import { stoneScheme } from '../stoneScheme';

export interface NativeTerrainOptions {
  /** A host View that CONTAINS the <Map> (the module finds the map view inside it). */
  hostRef: RefObject<View | null>;
  mapLoaded: boolean;
  /** The "3D relief" setting; `off` = no native layer at all (the 2D path as before). */
  relief: TiltRelief;
  /** Extra gate (e.g. the map maker's editor style owns the map). */
  allowed: boolean;
  basemap: TerrainBasemap;
  dark: boolean;
  networkAllowed: boolean;
  /** QA: attach as a frame-timing probe that draws nothing (the 2D baseline). */
  probe?: boolean;
  /** QA: native debug switches (see LookParams.debugFlags). */
  debugFlags?: number;
  /** Contour lines on the 3D surface (the map: always; satellite: its contour setting). */
  contours: boolean;
  /** 3D pin labels (peaks, places, huts…). */
  labels?: boolean;
  labelLanguage?: 'local' | 'fr' | 'en';
  /**
   * The live 2D style: draped per terrain tile (the map painted crisply on
   * the relief, as Outmap/Mapbox do). Omitted = the shaded relief model.
   */
  style?: DrapeStyleInput;
  /** Layer ids kept out of the drape besides the names (e.g. the tilt-relief pass). */
  drapeDropLayerIds?: readonly string[];
  /** The 2D hillshade layer, shaded at every zoom in the drape. */
  hillshadeLayerId?: string;
  /** Contour line layers, softened in the drape. */
  contourLayerIds?: readonly string[];
  /** The hillshade's raster-dem source (read deeper in the drape). */
  demSourceId?: string;
}

/** Contours in the drape: half as strong (steep 3D slopes pack them tight). */
const DRAPE_CONTOUR_OPACITY = 0.45;
/** Seen obliquely the 2D hillshade reads flat: shade the drape harder. */
const DRAPE_HILLSHADE_BOOST = 2.2;
/** The draped relief's contrast (alpha × on the theme's own hillshade colours). */
const DRAPE_HILLSHADE_ALPHA = { shadow: 1.35, highlight: 2, accent: 1.3 };
/** At night the shadows are already deep: the relief reads through its lit faces. */
const DRAPE_HILLSHADE_ALPHA_DARK = { shadow: 1.05, highlight: 2.4, accent: 1.1 };
/** The drape's DEM is read two zooms deeper (256 px tiles declared as 128). */
const DRAPE_DEM_TILE_SIZE = 128;

export interface NativeTerrainBinding {
  /** The native layer is attached and drawing (3D relief replaces the 2D tilt pass). */
  active: boolean;
  /** React tag the module is attached to (QA harness), or null. */
  viewTag: number | null;
}

/**
 * Native 3D terrain on the main map (docs/plans/native-terrain.md): attaches
 * the module's custom layer once the map is up, pushes the theme-derived look
 * when the theme, base map or setting changes, and detaches when the setting
 * goes off. Every frame after that is native — no JS per frame.
 */
export function useNativeTerrain(o: NativeTerrainOptions): NativeTerrainBinding {
  const module = nativeTerrain();
  const wanted = module !== null && o.allowed && (o.relief !== 'off' || o.probe === true);
  const [viewTag, setViewTag] = useState<number | null>(null);

  const config = useMemo<NativeTerrainConfig>(() => {
    const scheme = stoneScheme(o.dark);
    const tokens = schemeTokens(o.dark);
    const look = terrainLook({
      basemap: o.basemap,
      dark: o.dark,
      land: scheme.land,
      landAlt: scheme.landAlt,
      water: scheme.water,
      contour: scheme.contour,
      ink: scheme.ink,
      skyTint: palette.river,
      relief: o.relief === 'dramatic' ? 'dramatic' : 'natural',
      contours: o.contours,
    });
    return {
      look: [...packLook(look), o.debugFlags ?? 0],
      enabled: o.probe !== true && o.relief !== 'off',
      networkAllowed: o.networkAllowed,
      maxPitch: TERRAIN_MAX_PITCH_DEG,
      // Paper plates on both themes' own surface, inked like the 2D names.
      labelTheme: packLabelTheme({
        plate: tokens.surface,
        plateOpacity: 0.94,
        ink: scheme.ink,
        muted: scheme.inkMuted,
        water: scheme.waterInk,
      }),
      nameFields: nameFieldsFor(o.labelLanguage),
      labels: o.labels ?? true,
    };
  }, [
    o.basemap,
    o.dark,
    o.relief,
    o.networkAllowed,
    o.probe,
    o.debugFlags,
    o.contours,
    o.labels,
    o.labelLanguage,
  ]);

  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // Attach once the map is up; detach when unwanted or unmounted.
  useEffect(() => {
    if (!wanted || !o.mapLoaded || module === null) return;
    const tag = findNodeHandle(o.hostRef.current);
    if (tag === null) return;
    let cancelled = false;
    module
      .attach(tag, configRef.current)
      .then((ok) => {
        if (!cancelled && ok) setViewTag(tag);
      })
      .catch((e: unknown) => reportError(e, 'terrain3d-attach'));
    return () => {
      cancelled = true;
      setViewTag(null);
      module.detach(tag).catch((e: unknown) => reportError(e, 'terrain3d-detach'));
    };
  }, [wanted, o.mapLoaded, module, o.hostRef]);

  // A new look (theme, base map, setting) is a cheap in-place update.
  useEffect(() => {
    if (viewTag === null || module === null) return;
    try {
      module.update(viewTag, config);
    } catch (e) {
      reportError(e, 'terrain3d-update');
    }
  }, [config, viewTag, module]);

  // The drape: a new JSON only when the draped content really changes (the
  // native side re-renders every drape texture on a change).
  const drapeJson = useMemo(() => {
    if (o.style === undefined) return '';
    return JSON.stringify(
      drapeStyle(o.style, {
        dropLayerIds: o.drapeDropLayerIds,
        hillshadeLayerId: o.hillshadeLayerId,
        hillshadeBoost: DRAPE_HILLSHADE_BOOST,
        hillshadeAlpha: o.dark ? DRAPE_HILLSHADE_ALPHA_DARK : DRAPE_HILLSHADE_ALPHA,
        contourLayerIds: o.contourLayerIds,
        contourOpacity: DRAPE_CONTOUR_OPACITY,
        demSourceId: o.demSourceId,
        demTileSize: DRAPE_DEM_TILE_SIZE,
      }),
    );
  }, [o.style, o.drapeDropLayerIds, o.hillshadeLayerId, o.contourLayerIds, o.demSourceId, o.dark]);
  useEffect(() => {
    if (viewTag === null || module === null || module.setDrapeStyle === undefined) return;
    try {
      module.setDrapeStyle(viewTag, drapeJson);
    } catch (e) {
      reportError(e, 'terrain3d-drape');
    }
  }, [drapeJson, viewTag, module]);

  return { active: viewTag !== null && config.enabled, viewTag };
}

/**
 * The 3D scene's trails (lifted onto the terrain) and location marker, sent
 * once per change. `lines` should keep its identity between renders.
 */
export function useNativeTerrainScene(
  viewTag: number | null,
  lines: readonly TerrainLineSpec[],
  puck: { lng: number; lat: number } | null,
): void {
  const module = nativeTerrain();
  // Trails and the location marker: once per change (never per frame).
  useEffect(() => {
    if (viewTag === null || module === null || module.setLines === undefined) return;
    try {
      module.setLines(viewTag, [...lines]);
    } catch (e) {
      reportError(e, 'terrain3d-lines');
    }
  }, [lines, viewTag, module]);

  const puckLng = puck?.lng ?? null;
  const puckLat = puck?.lat ?? null;
  useEffect(() => {
    if (viewTag === null || module === null || module.setPuck === undefined) return;
    try {
      module.setPuck(viewTag, puckLng !== null, puckLng ?? 0, puckLat ?? 0);
    } catch (e) {
      reportError(e, 'terrain3d-puck');
    }
  }, [puckLng, puckLat, viewTag, module]);
}

import { TERRAIN_MAX_PITCH_DEG } from '@core/terrain3d/morph';
import { packLook, terrainLook, type TerrainBasemap } from '@core/terrain3d/look';
import type { TiltRelief } from '@core/map/tiltRelief';
import { reportError } from '@lib/errorReporting';
import { nativeTerrain, type NativeTerrainConfig } from '@lib/nativeTerrain';
import { palette } from '@ui/tokens';
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
}

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
    const look = terrainLook({
      basemap: o.basemap,
      dark: o.dark,
      land: stoneScheme(o.dark).land,
      skyTint: palette.river,
      relief: o.relief === 'dramatic' ? 'dramatic' : 'natural',
    });
    return {
      look: packLook(look),
      enabled: o.probe !== true && o.relief !== 'off',
      networkAllowed: o.networkAllowed,
      maxPitch: TERRAIN_MAX_PITCH_DEG,
    };
  }, [o.basemap, o.dark, o.relief, o.networkAllowed, o.probe]);

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

  return { active: viewTag !== null && config.enabled, viewTag };
}

import { groupIndex, type TerrainLineGroup } from '@core/terrain3d/lineGroups';
import type { TerrainLineSpec } from '@core/terrain3d/sceneInput';
import { reportError } from '@lib/errorReporting';
import { nativeTerrain } from '@lib/nativeTerrain';
import { useTerrainViewStore } from '@state/terrainViewStore';
import { useEffect } from 'react';

/**
 * The 3D terrain's view tag while it draws; null in 2D (set by MapScreen,
 * @state/terrainViewStore) — what the map's line overlays need to hand their
 * lines to the 3D scene (#735).
 */
export function useTerrainView(): number | null {
  return useTerrainViewStore((s) => s.viewTag);
}

/**
 * Hands one overlay's lines to the 3D scene (#735): the 3D terrain is drawn
 * over the whole 2D map, so every line overlay also goes to the scene, lifted
 * onto the relief. One group per overlay: a change re-sends that overlay
 * only. `lines` should keep its identity while unchanged, and be null in 2D
 * (callers compute it only when `useTerrainView()` is set). The group is
 * cleared when the overlay unmounts or 3D ends.
 */
export function useTerrainLineGroup(
  group: TerrainLineGroup,
  lines: readonly TerrainLineSpec[] | null,
): void {
  const viewTag = useTerrainView();
  useEffect(() => {
    const module = nativeTerrain();
    if (viewTag === null || module?.setLineGroup === undefined) return;
    try {
      module.setLineGroup(viewTag, groupIndex(group), lines === null ? [] : [...lines]);
    } catch (e) {
      reportError(e, 'terrain3d-lines');
    }
  }, [viewTag, group, lines]);
  useEffect(() => {
    const module = nativeTerrain();
    if (viewTag === null || module?.setLineGroup === undefined) return;
    return () => {
      try {
        module.setLineGroup?.(viewTag, groupIndex(group), []);
      } catch {
        // detached meanwhile: nothing to clear
      }
    };
  }, [viewTag, group]);
}

/**
 * The lng, lat of the drawn 3D terrain under a map point (logical px) — where
 * a tap or a pen lands on the relief (#735). MapLibre's own answer is on its
 * flat ground, hundreds of metres off on a slope. Null in 2D, off the terrain
 * or without the module (callers keep MapLibre's answer then).
 */
export function terrainLngLat(
  viewTag: number | null,
  x: number,
  y: number,
): [number, number] | null {
  if (viewTag === null) return null;
  try {
    const at = nativeTerrain()?.unproject?.(viewTag, x, y) ?? null;
    return at !== null && Number.isFinite(at[0]) && Number.isFinite(at[1]) ? [at[0], at[1]] : null;
  } catch {
    return null;
  }
}

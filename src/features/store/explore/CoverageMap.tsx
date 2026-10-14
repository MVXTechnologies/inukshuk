import { locatorWindow, projectToWindow } from '@core/catalog/locator';
import { locatorScene } from '@core/catalog/locatorSceneCache';
import type { CatalogBbox } from '@core/catalog/schema';
import type { LatLng } from '@core/models';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

/**
 * The detail screen's coverage mini-map (#447, `Detail.dc.html`): the map's
 * footprint over the same offline Natural Earth outline the store rows use
 * (`@core/catalog/locator`), drawn wide, plus the user's position when it
 * falls inside the window. No tiles, no network — it works offline.
 *
 * The locator scene is square; the wide card shows its middle band
 * (`slice`), which is where the footprint sits.
 */

const CANVAS_PX = 100;
/** The dot's diameter is 5.2 units: a footprint is drawn at least this big, around its centre. */
export const MIN_FOOTPRINT = 8;

/** A footprint grown about its centre to at least `min` a side. */
export function minFootprint(
  r: { x: number; y: number; width: number; height: number },
  min: number,
): { x: number; y: number; width: number; height: number } {
  const width = Math.max(r.width, min);
  const height = Math.max(r.height, min);
  return { x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2, width, height };
}

export const CoverageMap = memo(function CoverageMap({
  bbox,
  position,
  height,
}: {
  bbox: CatalogBbox;
  position: LatLng | null;
  height: number;
}) {
  const t = useSchemeTokens();
  const scene = useMemo(() => locatorScene(bbox, CANVAS_PX), [bbox]);
  const sheet = minFootprint(scene.sheet, MIN_FOOTPRINT);
  const you = useMemo(() => {
    if (position === null) return null;
    const [x, y] = projectToWindow(
      position.longitude,
      position.latitude,
      locatorWindow(bbox),
      CANVAS_PX,
    );
    return x >= 0 && x <= CANVAS_PX && y >= 0 && y <= CANVAS_PX ? { x, y } : null;
  }, [bbox, position]);

  return (
    <View style={[styles.frame, { height, backgroundColor: t.library.mapWater }]}>
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${scene.size} ${scene.size}`}
        preserveAspectRatio="xMidYMid slice"
      >
        <Rect x={0} y={0} width={scene.size} height={scene.size} fill={t.library.mapWater} />
        {scene.land.map((d, i) => (
          <Path key={`land-${i}`} d={d} fill={t.explore.placeholder} />
        ))}
        {scene.lakes.map((d, i) => (
          <Path key={`lake-${i}`} d={d} fill={t.library.mapWater} />
        ))}
        {scene.borders.map((d, i) => (
          <Path key={`border-${i}`} d={d} stroke={t.outlineVariant} strokeWidth={0.5} fill="none" />
        ))}
        {you !== null && (
          <Circle
            cx={you.x}
            cy={you.y}
            r={2.6}
            fill={t.map.puck}
            stroke={t.map.puckRing}
            strokeWidth={1}
          />
        )}
        {/* Over the dot (2.5.2 QA: a river's small box hid under it), and never
          smaller than the dot itself. */}
        <Rect
          x={sheet.x}
          y={sheet.y}
          width={sheet.width}
          height={sheet.height}
          fill={t.explore.footprint}
          fillOpacity={0.14}
          stroke={t.explore.footprint}
          strokeWidth={1.2}
          testID="coverage-footprint"
        />
      </Svg>
    </View>
  );
});

/** "46.83°N to 47.00°N · 71.50°W to 71.25°W" */
export function coverageText(bbox: CatalogBbox): string {
  const lat = (v: number) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'S' : 'N'}`;
  const lon = (v: number) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'W' : 'E'}`;
  return `${lat(bbox[1])} to ${lat(bbox[3])} · ${lon(bbox[0])} to ${lon(bbox[2])}`;
}

const styles = StyleSheet.create({
  frame: { width: '100%', overflow: 'hidden' },
});

import { buildLocatorScene, type LocatorScene } from '@core/catalog/locator';
import { LOCATOR_BASEMAP } from '@core/catalog/locatorBasemap';
import type { CatalogBbox } from '@core/catalog/schema';
import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from 'react-native-paper';
import Svg, { Path, Rect } from 'react-native-svg';
import { MaterialCommunityIcons } from '@expo/vector-icons';

/**
 * Offline locator thumbnail for a store row: the item's coverage rectangle
 * highlighted over a simplified land/lake/border outline (Natural Earth data
 * baked into `@core/catalog/locatorBasemap`). Pure SVG — no tiles, no network,
 * so it renders instantly in the FlatList and works in offline-only mode.
 *
 * Memoized: the scene is a pure function of the bbox, and rows re-render on
 * download progress ticks — the SVG must not be rebuilt then.
 *
 * Perf: `useMemo` alone only survives as long as the row is mounted, and a
 * FlatList recycles cells constantly while scrolling — every recycle re-ran the
 * full projection + Sutherland–Hodgman clip of the basemap (measured: ~5.5k of
 * the basemap's 14.3k points touched per thumbnail, ~0.26 ms on desktop V8 and
 * several times that on Hermes). The scene is a deterministic pure function of
 * (bbox, size), so cache it module-side: the catalog is ~130 items and each
 * scene is a handful of short path strings, so the whole cache is a few hundred
 * KB at most and every re-visit to a row is then free.
 */
const sceneCache = new Map<string, LocatorScene>();

function locatorScene(bbox: CatalogBbox): LocatorScene {
  const key = bbox.join(',');
  const hit = sceneCache.get(key);
  if (hit !== undefined) return hit;
  const scene = buildLocatorScene(bbox, LOCATOR_BASEMAP, 100);
  sceneCache.set(key, scene);
  return scene;
}

export const LocatorThumb = memo(function LocatorThumb({
  bbox,
  size,
}: {
  bbox: CatalogBbox | undefined;
  size: number;
}) {
  const theme = useTheme();
  const scene = useMemo(() => (bbox === undefined ? null : locatorScene(bbox)), [bbox]);

  // Fixed miniature-map palette per theme (not theme.colors — water must read
  // as water in both themes, like the weather HUD's fixed gradient ramps).
  const water = theme.dark ? '#1c2a38' : '#d3e5f1';
  const land = theme.dark ? '#333b33' : '#eae6da';
  const border = theme.dark ? '#5a6470' : '#a9b0b8';

  if (scene === null) {
    return (
      <View
        style={[
          styles.frame,
          { width: size, height: size, backgroundColor: theme.colors.surfaceVariant },
          styles.placeholder,
        ]}
      >
        <MaterialCommunityIcons
          name="map-outline"
          size={size / 2}
          color={theme.colors.onSurfaceVariant}
        />
      </View>
    );
  }

  return (
    <View style={[styles.frame, { width: size, height: size }]}>
      <Svg width={size} height={size} viewBox={`0 0 ${scene.size} ${scene.size}`}>
        <Rect x={0} y={0} width={scene.size} height={scene.size} fill={water} />
        {scene.land.map((d, i) => (
          <Path key={`land-${i}`} d={d} fill={land} />
        ))}
        {scene.lakes.map((d, i) => (
          <Path key={`lake-${i}`} d={d} fill={water} />
        ))}
        {scene.borders.map((d, i) => (
          <Path key={`border-${i}`} d={d} stroke={border} strokeWidth={0.7} fill="none" />
        ))}
        <Rect
          x={scene.sheet.x}
          y={scene.sheet.y}
          width={scene.sheet.width}
          height={scene.sheet.height}
          fill={theme.colors.primary}
          fillOpacity={0.28}
          stroke={theme.colors.primary}
          strokeWidth={1.6}
          rx={1}
        />
      </Svg>
    </View>
  );
});

const styles = StyleSheet.create({
  frame: { borderRadius: 8, overflow: 'hidden' },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
});

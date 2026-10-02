import { buildFootprintScene } from '@core/catalog/footprintThumb';
import { LOCATOR_BASEMAP } from '@core/catalog/locatorBasemap';
import type { CatalogBbox } from '@core/catalog/schema';
import type { LatLng } from '@core/models';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo, useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

/**
 * A "Popular near you" card's picture: the map sheet's footprint as a
 * rectangle over the offline Natural Earth outline, framed to the card
 * (`@core/catalog/footprintThumb`). Pure SVG — no tiles, no network, so the
 * carousel draws instantly offline and never touches the tile server. Same
 * palette as the detail screen's coverage map (`CoverageMap`).
 *
 * A link-out place (a park with maps on its publisher's site) has only a
 * position, so `marker` draws a pin there instead of a rectangle.
 *
 * Outside the baked basemap's extent the scene has no land layer; rather
 * than a fake ocean the card gets a paper ground with a faint graticule.
 */
export const FootprintThumb = memo(function FootprintThumb({
  bbox,
  width,
  height,
  position,
  marker = false,
}: {
  bbox: CatalogBbox;
  width: number;
  height: number;
  position: LatLng | null;
  /** Draw the bbox centre as a pin (a link-out place) instead of a footprint. */
  marker?: boolean;
}) {
  const t = useSchemeTokens();
  const scene = useMemo(
    () => buildFootprintScene(bbox, LOCATOR_BASEMAP, { width, height, origin: position }),
    [bbox, width, height, position],
  );
  const ground = scene.basemap ? t.library.mapWater : t.explore.placeholder;

  return (
    <View
      style={{ width, height, backgroundColor: ground }}
      testID="footprint-thumb"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={width} height={height} viewBox={`0 0 ${scene.width} ${scene.height}`}>
        <Rect x={0} y={0} width={scene.width} height={scene.height} fill={ground} />
        {scene.land.map((d, i) => (
          <Path key={`land-${i}`} d={d} fill={t.explore.placeholder} />
        ))}
        {scene.lakes.map((d, i) => (
          <Path key={`lake-${i}`} d={d} fill={t.library.mapWater} />
        ))}
        {scene.borders.map((d, i) => (
          <Path
            key={`border-${i}`}
            d={d}
            stroke={t.outlineVariant}
            strokeWidth={0.8}
            strokeDasharray="3 2"
            fill="none"
          />
        ))}
        {scene.graticule.map((d, i) => (
          <Path key={`grat-${i}`} d={d} stroke={t.outlineVariant} strokeWidth={0.6} fill="none" />
        ))}
        {marker ? (
          <>
            <Circle
              cx={scene.sheet.x + scene.sheet.width / 2}
              cy={scene.sheet.y + scene.sheet.height / 2}
              r={14}
              fill={t.explore.footprint}
              fillOpacity={0.16}
            />
            <Circle
              cx={scene.sheet.x + scene.sheet.width / 2}
              cy={scene.sheet.y + scene.sheet.height / 2}
              r={5}
              fill={t.explore.footprint}
              stroke={t.surface}
              strokeWidth={2}
            />
          </>
        ) : (
          <Rect
            x={scene.sheet.x}
            y={scene.sheet.y}
            width={scene.sheet.width}
            height={scene.sheet.height}
            fill={t.explore.footprint}
            fillOpacity={0.16}
            stroke={t.explore.footprint}
            strokeWidth={1.6}
            rx={1.5}
          />
        )}
        {scene.you !== null && (
          <Circle
            cx={scene.you.x}
            cy={scene.you.y}
            r={4}
            fill={t.map.puck}
            stroke={t.map.puckRing}
            strokeWidth={1.5}
          />
        )}
      </Svg>
    </View>
  );
});

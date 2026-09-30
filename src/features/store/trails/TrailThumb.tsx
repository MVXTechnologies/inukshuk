import { badgeIndex } from '@core/catalog/exploreFormat';
import type { LngLat } from '@core/models';
import { thumbnailPath } from '@core/trails/geometry';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo, useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

/**
 * A long-distance trail's drawn thumbnail (#467, boards `Main/List.dc.html`):
 * the trail's own shape (the index's ~40-point line) in orange over a halo,
 * on a paper ground with three faint contour lines varied by `seed`. No
 * tiles — the Explore rows stay cheap and work offline.
 */
export const TrailThumb = memo(function TrailThumb({
  parts,
  width,
  height,
  seed,
  stroke = 3.5,
  contours = true,
}: {
  parts: readonly (readonly LngLat[])[];
  width: number;
  height: number;
  seed: string;
  stroke?: number;
  contours?: boolean;
}) {
  const t = useSchemeTokens();
  const pad = Math.max(8, Math.round(Math.min(width, height) * 0.12));
  const { d, start } = useMemo(
    () => thumbnailPath(parts, width, height, pad),
    [parts, width, height, pad],
  );
  const o = ((badgeIndex(seed, 997) % 5) - 2) * (height / 24);
  const curve = (y: number, a: number, b: number) =>
    `M0 ${y + o} C ${width * 0.3} ${y + a + o}, ${width * 0.6} ${y + b + o}, ${width} ${y - height * 0.08 + o}`;
  return (
    <View style={{ width, height, backgroundColor: t.explore.trailThumb }}>
      <Svg width={width} height={height}>
        {contours && (
          <>
            <Path
              d={curve(height * 0.25, -height * 0.1, height * 0.15)}
              stroke={t.explore.trailThumbContour}
              strokeWidth={1}
              fill="none"
            />
            <Path
              d={curve(height * 0.55, -height * 0.12, height * 0.12)}
              stroke={t.explore.trailThumbContour}
              strokeWidth={1}
              fill="none"
            />
            <Path
              d={curve(height * 0.85, -height * 0.08, height * 0.1)}
              stroke={t.explore.trailThumbContour}
              strokeWidth={1}
              fill="none"
            />
          </>
        )}
        {d !== '' && (
          <>
            <Path
              d={d}
              stroke={t.explore.trailHalo}
              strokeWidth={stroke * 2}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            <Path
              d={d}
              stroke={t.explore.trail}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </>
        )}
        {start !== null && (
          <Circle
            cx={start[0]}
            cy={start[1]}
            r={stroke * 1.1}
            fill={t.explore.trailHalo}
            stroke={t.explore.trail}
            strokeWidth={stroke * 0.6}
          />
        )}
      </Svg>
    </View>
  );
});

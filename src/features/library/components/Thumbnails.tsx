import { fnv1a32 } from '@core/encoding/fnv1a';
import type { CategoryDefinition } from '@core/library/categories';
import type { RouteThumbnail } from '@core/library/routeThumbnail';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { Icon } from 'react-native-paper';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

/** Thumbnail side (dp), board `After-Library.html`. */
export const THUMB_SIZE = 56;
const BADGE = 20;

/**
 * Three decorative contour sets from the board, picked per trail so a list
 * of thumbnails does not repeat one texture.
 */
const CONTOURS = [
  'M-2 16C12 10 26 20 58 12M-2 32C14 26 30 38 58 28M-2 48C16 42 30 52 58 44',
  'M-2 20C12 12 26 24 58 14M-2 36C14 30 30 42 58 30M-2 52C16 46 30 54 58 46',
  'M-2 12C12 6 26 16 58 8M-2 28C14 22 30 34 58 24M-2 44C16 38 30 48 58 40',
] as const;

/**
 * A trail's 56 dp route thumbnail (revamp §5): the simplified route in the
 * route colour, cased, over faint contours, with a dot at the start — plus
 * the activity badge of decision 7 overlapping the bottom-right corner.
 *
 * `thumb` undefined = still loading and null = nothing drawable: both show
 * the bare paper tile, so rows never jump.
 */
export const TrailThumbnail = memo(function TrailThumbnail({
  trackId,
  thumb,
  category,
}: {
  trackId: string;
  thumb: RouteThumbnail | null | undefined;
  category: CategoryDefinition | null;
}) {
  const t = useSchemeTokens();
  const contour = CONTOURS[parseInt(fnv1a32(trackId), 16) % CONTOURS.length] ?? CONTOURS[0];
  return (
    <View style={styles.frame}>
      <View
        style={[
          styles.tile,
          { backgroundColor: t.library.thumb, borderColor: t.library.thumbEdge },
        ]}
      >
        <Svg width={THUMB_SIZE} height={THUMB_SIZE} viewBox="0 0 56 56">
          <Path d={contour} fill="none" stroke={t.library.thumbContour} strokeWidth={1} />
          {thumb ? (
            <>
              <Path
                d={thumb.path}
                fill="none"
                stroke={t.library.thumbCasing}
                strokeWidth={4.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <Path
                d={thumb.path}
                fill="none"
                stroke={t.data.route}
                strokeWidth={2.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <Circle cx={thumb.start.x} cy={thumb.start.y} r={3} fill={t.library.thumbStart} />
            </>
          ) : null}
        </Svg>
      </View>
      {category !== null && (
        <View
          style={[styles.badge, { backgroundColor: t.library.badge, borderColor: category.color }]}
        >
          <Icon source={category.icon} size={13} color={category.color} />
        </View>
      )}
    </View>
  );
});

/**
 * A map row's 56 dp thumbnail: page 1's overlay raster when the overlay
 * pipeline already drew it, else a neutral folded-sheet placeholder.
 */
export function MapThumbnail({ uri }: { uri: string | null | undefined }) {
  const t = useSchemeTokens();
  return (
    <View
      style={[
        styles.tile,
        { backgroundColor: t.library.mapThumb, borderColor: t.library.thumbEdge },
      ]}
    >
      {uri ? (
        // `resize` makes Android decode at display size: the raster is 2048 px.
        <Image source={{ uri }} style={styles.raster} resizeMode="cover" resizeMethod="resize" />
      ) : (
        <Svg width={THUMB_SIZE} height={THUMB_SIZE} viewBox="0 0 56 56">
          <Rect
            x={11}
            y={5}
            width={34}
            height={46}
            rx={1.5}
            fill={t.library.mapSheet}
            stroke={t.library.mapSheetEdge}
            strokeWidth={1}
          />
          <Path
            d="M11 20H45M11 36H45M22 5V51M34 5V51"
            stroke={t.library.thumbEdge}
            strokeWidth={0.8}
          />
          <Path
            d="M13 14C18 10 24 16 30 12S40 10 43 13M13 26C19 22 25 30 32 25S40 23 43 26M13 42C19 38 26 44 33 40S40 38 43 41"
            fill="none"
            stroke={t.library.mapContour}
            strokeWidth={0.9}
          />
          <Path
            d="M24 30C27 27 33 28 34 32S29 38 25 36 21 33 24 30Z"
            fill={t.library.mapWater}
            stroke={t.data.info}
            strokeWidth={0.8}
          />
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { width: THUMB_SIZE, height: THUMB_SIZE },
  tile: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth * 2,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  raster: { width: THUMB_SIZE, height: THUMB_SIZE },
  badge: {
    position: 'absolute',
    right: -5,
    bottom: -5,
    width: BADGE,
    height: BADGE,
    borderRadius: BADGE / 2,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

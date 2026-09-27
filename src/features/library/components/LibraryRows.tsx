import type { CategoryDefinition } from '@core/library/categories';
import { formatBytes } from '@core/format';
import type { MapDocument, TrackSummary } from '@core/models';
import { InukshukIcon } from '@features/map/components/InukshukIcon';
import { tabularNums } from '@ui/fonts';
import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';
import { useMapThumbnail } from '../useMapThumbnail';
import { useRouteThumbnail } from '../useRouteThumbnail';
import { MapThumbnail, THUMB_SIZE, TrailThumbnail } from './Thumbnails';

/**
 * Library rows (revamp §5, `After-Library.html`): 76 dp, a 56 dp thumbnail,
 * three lines of text, and one trailing control. The whole row opens the
 * item; everything else lives in the ⋮ menu passed in as `trailing`.
 *
 * `leading` is Organize mode's drag grip; `children` render full-width under
 * the row (an elevation profile, a map's page list, a recovery notice).
 */

const ROW_HEIGHT = 76;

/** 1 dp hairline between rows, indented past the thumbnail (84 = 16 + 56 + 12). */
export function RowDivider() {
  const t = useSchemeTokens();
  return <View style={[styles.divider, { backgroundColor: t.divider }]} />;
}

function RowFrame({
  leading,
  trailing,
  children,
  selected,
  main,
}: {
  leading?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
  selected?: boolean;
  main: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={selected ? { backgroundColor: theme.colors.secondaryContainer } : undefined}>
      <View style={[styles.row, leading ? styles.rowWithGrip : null]}>
        {leading}
        {main}
        {trailing}
      </View>
      {children}
    </View>
  );
}

export function TrailRow({
  track,
  category,
  stats,
  caption,
  accessibilityLabel,
  onPress,
  onLongPress,
  selecting,
  selected,
  leading,
  trailing,
  children,
}: {
  track: TrackSummary;
  category: CategoryDefinition | null;
  stats: string;
  caption: string;
  accessibilityLabel: string;
  onPress: () => void;
  onLongPress: () => void;
  selecting: boolean;
  selected: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  const thumb = useRouteThumbnail(track);
  return (
    <RowFrame
      selected={selected}
      leading={leading}
      trailing={
        selecting ? (
          <View style={styles.trailingIcon}>
            <Icon
              source={selected ? 'checkbox-marked-circle' : 'checkbox-blank-circle-outline'}
              size={24}
              color={selected ? theme.colors.primary : t.inkMuted}
            />
          </View>
        ) : (
          trailing
        )
      }
      main={
        <Pressable
          style={styles.main}
          onPress={onPress}
          onLongPress={onLongPress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
        >
          <TrailThumbnail trackId={track.id} thumb={thumb} category={category} />
          <View style={styles.text}>
            <Text numberOfLines={1} style={[styles.name, { color: t.ink }]}>
              {track.name}
            </Text>
            {/* Never truncated: the three stats are the point of the row. */}
            <Text style={[styles.stats, { color: t.ink }]}>{stats}</Text>
            <Text numberOfLines={1} style={[styles.caption, { color: t.inkMuted }]}>
              {caption}
            </Text>
          </View>
        </Pressable>
      }
    >
      {children}
    </RowFrame>
  );
}

/** The sage "✓ On map" toggle (off: an outlined "Hidden" chip). */
export function OnMapChip({
  on,
  name,
  onToggle,
}: {
  on: boolean;
  name: string;
  onToggle: () => void;
}) {
  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={`Show ${name} on map`}
      style={styles.chipHit}
    >
      <View
        style={[
          styles.onMap,
          on
            ? { backgroundColor: t.library.onMap, borderColor: t.library.onMapBorder }
            : { backgroundColor: 'transparent', borderColor: t.outline },
        ]}
      >
        <Icon
          source={on ? 'check' : 'eye-off-outline'}
          size={14}
          color={on ? t.library.onMapInk : t.inkMuted}
        />
        <Text style={[styles.onMapLabel, { color: on ? t.library.onMapInk : t.inkMuted }]}>
          {on ? 'On map' : 'Hidden'}
        </Text>
      </View>
    </Pressable>
  );
}

export function MapRow({
  map,
  title,
  notice,
  pagesLine,
  status,
  rendering,
  renderingLabel,
  accessibilityLabel,
  onPress,
  leading,
  toggle,
  trailing,
  children,
}: {
  map: MapDocument;
  title: string;
  /** Why the map can never be drawn; replaces the size caption when set. */
  notice: string | null;
  /** "2/3 pages on map" for multi-page maps. */
  pagesLine: string | null;
  /** A second caption line (rendering progress / failure), if any. */
  status: { text: string; failed: boolean } | null;
  rendering: boolean;
  renderingLabel: string;
  accessibilityLabel: string;
  onPress: () => void;
  leading?: ReactNode;
  toggle?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  const thumbnail = useMapThumbnail(map, rendering);
  const caption =
    notice ??
    [
      'PDF',
      ...(thumbnail && thumbnail.bytes > 0 ? [formatBytes(thumbnail.bytes)] : []),
      ...(pagesLine ? [pagesLine] : []),
    ].join(' · ');
  const captionTone = notice ? 'notice' : 'normal';
  const thumbnailUri = thumbnail?.uri;
  const t = useSchemeTokens();
  const theme = useTheme();
  return (
    <RowFrame
      leading={leading}
      trailing={
        <>
          {toggle}
          {trailing}
        </>
      }
      main={
        <Pressable
          style={styles.main}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
        >
          <View>
            <MapThumbnail uri={thumbnailUri} />
            {rendering && (
              <View style={[styles.renderingVeil, { backgroundColor: t.library.chip }]}>
                <ActivityIndicator
                  size="small"
                  color={theme.colors.primary}
                  accessibilityLabel={renderingLabel}
                />
              </View>
            )}
          </View>
          <View style={styles.text}>
            <Text numberOfLines={1} style={[styles.name, { color: t.ink }]}>
              {title}
            </Text>
            <Text
              numberOfLines={captionTone === 'notice' ? 2 : 1}
              style={[styles.caption, tabularNums, { color: t.inkMuted }]}
            >
              {caption}
            </Text>
            {status && (
              <Text
                numberOfLines={2}
                style={[styles.caption, { color: status.failed ? theme.colors.error : t.inkMuted }]}
              >
                {status.text}
              </Text>
            )}
          </View>
        </Pressable>
      }
    >
      {children}
    </RowFrame>
  );
}

export function WaypointRow({
  name,
  detail,
  caption,
  photoUri,
  accessibilityLabel,
  onPress,
  onLongPress,
  leading,
  trailing,
}: {
  name: string;
  detail: string;
  caption: string;
  photoUri?: string;
  accessibilityLabel: string;
  onPress: () => void;
  onLongPress: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const t = useSchemeTokens();
  return (
    <RowFrame
      leading={leading}
      trailing={trailing}
      main={
        <Pressable
          style={styles.main}
          onPress={onPress}
          onLongPress={onLongPress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
        >
          <View
            style={[
              styles.glyphTile,
              { backgroundColor: t.library.thumb, borderColor: t.library.thumbEdge },
            ]}
          >
            {photoUri !== undefined ? (
              <Image source={{ uri: photoUri }} style={styles.photo} resizeMethod="resize" />
            ) : (
              <InukshukIcon size={30} color={t.ink} />
            )}
          </View>
          <View style={styles.text}>
            <Text numberOfLines={1} style={[styles.name, { color: t.ink }]}>
              {name}
            </Text>
            <Text numberOfLines={1} style={[styles.stats, { color: t.ink }]}>
              {detail}
            </Text>
            <Text numberOfLines={1} style={[styles.caption, { color: t.inkMuted }]}>
              {caption}
            </Text>
          </View>
        </Pressable>
      }
    />
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.lg,
    paddingRight: space.xs,
  },
  rowWithGrip: { paddingLeft: space.xs },
  main: {
    flex: 1,
    minHeight: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
  },
  text: { flex: 1, minWidth: 0, gap: 2, paddingRight: space.xs },
  name: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  stats: { fontSize: 14, lineHeight: 19, fontWeight: '600', ...tabularNums },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  divider: { height: 1, marginLeft: space.lg + THUMB_SIZE + space.md },
  trailingIcon: { width: 44, height: target.min, alignItems: 'center', justifyContent: 'center' },
  chipHit: { height: target.min, justifyContent: 'center', paddingHorizontal: 2 },
  onMap: {
    height: 34,
    paddingHorizontal: space.md,
    borderRadius: 17,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  onMapLabel: { fontSize: 13, lineHeight: 17, fontWeight: '700' },
  renderingVeil: {
    ...StyleSheet.absoluteFill,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.85,
  },
  glyphTile: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth * 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  photo: { width: THUMB_SIZE, height: THUMB_SIZE },
});

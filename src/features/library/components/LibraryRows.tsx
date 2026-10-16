import type { CategoryDefinition } from '@core/library/categories';
import { formatBytes } from '@core/format';
import type { MapDocument, TrackSummary } from '@core/models';
import { InukshukGlyph } from '@ui/components/InukshukGlyph';
import { tabularNums } from '@ui/fonts';
import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';
import { useMapThumbnail } from '../useMapThumbnail';
import { useRouteThumbnail } from '../useRouteThumbnail';
import { SourceMark } from '../../import/importParts';
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

/**
 * Select mode on a row (#711): while selecting, the row's trailing controls
 * (⋮, On map) give way to the circle check, in the same slot, so nothing
 * shifts sideways; a selected row takes the sage fill. `flash` is the soft
 * wash moved rows get for a moment so you can see where they landed.
 */
export interface RowSelection {
  selecting?: boolean;
  selected?: boolean;
  flash?: boolean;
}

/** The trailing circle check of a row in select mode. */
export function SelectCheck({ selected }: { selected: boolean }) {
  const t = useSchemeTokens();
  const theme = useTheme();
  return (
    <View
      style={styles.trailingIcon}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Icon
        source={selected ? 'checkbox-marked-circle' : 'checkbox-blank-circle-outline'}
        size={24}
        color={selected ? theme.colors.primary : t.inkMuted}
      />
    </View>
  );
}

/** Half-strength sage for the moved-rows wash (an 8-digit hex when the colour allows it). */
export function washOf(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}8C` : color;
}

function RowFrame({
  leading,
  trailing,
  children,
  selecting,
  selected,
  flash,
  main,
}: RowSelection & {
  leading?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
  main: ReactNode;
}) {
  const theme = useTheme();
  const fill = selected
    ? theme.colors.secondaryContainer
    : flash
      ? washOf(theme.colors.secondaryContainer)
      : undefined;
  return (
    <View style={fill ? { backgroundColor: fill } : undefined}>
      <View style={[styles.row, leading ? styles.rowWithGrip : null]}>
        {leading}
        {main}
        {selecting ? <SelectCheck selected={selected === true} /> : trailing}
      </View>
      {children}
    </View>
  );
}

/** A row's caption line, with an optional small icon before it (Share live's clock). */
function CaptionLine({ caption, icon }: { caption: string; icon: string | undefined }) {
  const t = useSchemeTokens();
  if (icon === undefined)
    return (
      <Text numberOfLines={1} style={[styles.caption, { color: t.inkMuted }]}>
        {caption}
      </Text>
    );
  return (
    <View style={styles.captionRow}>
      <Icon source={icon} size={14} color={t.status.pausedInk} />
      <Text numberOfLines={1} style={[styles.caption, styles.captionShrink, { color: t.inkMuted }]}>
        {caption}
      </Text>
    </View>
  );
}

/** Spoken state of a row in select mode ("selected" / "not selected"). */
function selectionState(selecting: boolean | undefined, selected: boolean | undefined) {
  return selecting ? { selected: selected === true } : undefined;
}

export function TrailRow({
  track,
  category,
  stats,
  caption,
  captionIcon,
  accessibilityLabel,
  onPress,
  onLongPress,
  selecting,
  selected,
  flash,
  sourceMark,
  leading,
  trailing,
  children,
}: RowSelection & {
  track: TrackSummary;
  category: CategoryDefinition | null;
  stats: string;
  caption: string;
  /** Share live (#712): a small icon before the caption (the "not sent yet" clock). */
  captionIcon?: string;
  accessibilityLabel: string;
  onPress: () => void;
  onLongPress: () => void;
  /** "Strava" — where an imported trail came from (#432/#435). */
  sourceMark?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  const t = useSchemeTokens();
  const thumb = useRouteThumbnail(track);
  return (
    <RowFrame
      selecting={selecting}
      selected={selected}
      flash={flash}
      leading={leading}
      trailing={trailing}
      main={
        <Pressable
          style={styles.main}
          onPress={onPress}
          onLongPress={onLongPress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={selectionState(selecting, selected)}
          testID={`library-row-track-${track.id}`}
        >
          <TrailThumbnail trackId={track.id} thumb={thumb} category={category} />
          <View style={styles.text}>
            <View style={styles.nameRow}>
              <Text numberOfLines={1} style={[styles.name, styles.nameShrink, { color: t.ink }]}>
                {track.name}
              </Text>
              {sourceMark ? <SourceMark label={sourceMark} /> : null}
            </View>
            {/* Never truncated: the three stats are the point of the row. */}
            <Text style={[styles.stats, { color: t.ink }]}>{stats}</Text>
            <CaptionLine caption={caption} icon={captionIcon} />
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
  credit,
  rendering,
  renderingLabel,
  accessibilityLabel,
  onPress,
  onLongPress,
  selecting,
  selected,
  flash,
  leading,
  toggle,
  trailing,
  children,
}: RowSelection & {
  map: MapDocument;
  title: string;
  /** Why the map can never be drawn; replaces the size caption when set. */
  notice: string | null;
  /** "2/3 pages on map" for multi-page maps. */
  pagesLine: string | null;
  /** A second caption line (rendering progress / failure), if any. */
  status: { text: string; failed: boolean } | null;
  /** The map author's credit, for catalog maps whose publisher requires it (#680). */
  credit?: string | null | undefined;
  rendering: boolean;
  renderingLabel: string;
  accessibilityLabel: string;
  onPress: () => void;
  onLongPress?: () => void;
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
      selecting={selecting}
      selected={selected}
      flash={flash}
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
          onLongPress={onLongPress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={selectionState(selecting, selected)}
          testID={`library-row-map-${map.id}`}
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
            {credit ? (
              <Text numberOfLines={2} style={[styles.caption, { color: t.inkMuted }]}>
                {credit}
              </Text>
            ) : null}
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
  captionIcon,
  photoUri,
  glyph,
  accessibilityLabel,
  onPress,
  onLongPress,
  selecting,
  selected,
  flash,
  testID,
  leading,
  trailing,
}: RowSelection & {
  testID?: string;
  name: string;
  detail: string;
  caption: string;
  /** Share live (#712): a small icon before the caption (the "not sent yet" clock). */
  captionIcon?: string;
  photoUri?: string;
  /** The waypoint's chosen pin icon (MaterialCommunityIcons), when it has one. */
  glyph?: string | null;
  accessibilityLabel: string;
  onPress: () => void;
  onLongPress: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const t = useSchemeTokens();
  return (
    <RowFrame
      selecting={selecting}
      selected={selected}
      flash={flash}
      leading={leading}
      trailing={trailing}
      main={
        <Pressable
          style={styles.main}
          onPress={onPress}
          onLongPress={onLongPress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={selectionState(selecting, selected)}
          testID={testID}
        >
          <View
            style={[
              styles.glyphTile,
              { backgroundColor: t.library.thumb, borderColor: t.library.thumbEdge },
            ]}
          >
            {photoUri !== undefined ? (
              <Image source={{ uri: photoUri }} style={styles.photo} resizeMethod="resize" />
            ) : glyph ? (
              <Icon source={glyph} size={28} color={t.ink} />
            ) : (
              <InukshukGlyph size={30} frame="square" />
            )}
          </View>
          <View style={styles.text}>
            <Text numberOfLines={1} style={[styles.name, { color: t.ink }]}>
              {name}
            </Text>
            <Text numberOfLines={1} style={[styles.stats, { color: t.ink }]}>
              {detail}
            </Text>
            <CaptionLine caption={caption} icon={captionIcon} />
          </View>
        </Pressable>
      }
    />
  );
}

/**
 * A drawn area (#503): its first photo, or a swatch of its colour, then the
 * name, its size and note preview, and the date. Same frame as a waypoint.
 */
export function AreaRow({
  name,
  detail,
  caption,
  captionIcon,
  color,
  photoUri,
  accessibilityLabel,
  onPress,
  onLongPress,
  selecting,
  selected,
  flash,
  testID,
  leading,
  trailing,
}: RowSelection & {
  testID?: string;
  leading?: ReactNode;
  name: string;
  detail: string;
  caption: string;
  /** Share live (#712): a small icon before the caption (the "not sent yet" clock). */
  captionIcon?: string;
  color: string;
  photoUri?: string;
  accessibilityLabel: string;
  onPress: () => void;
  onLongPress: () => void;
  trailing?: ReactNode;
}) {
  const t = useSchemeTokens();
  return (
    <RowFrame
      selecting={selecting}
      selected={selected}
      flash={flash}
      leading={leading}
      trailing={trailing}
      main={
        <Pressable
          style={styles.main}
          onPress={onPress}
          onLongPress={onLongPress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={selectionState(selecting, selected)}
          testID={testID}
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
              <View
                style={[styles.areaSwatch, { borderColor: color, backgroundColor: `${color}33` }]}
              />
            )}
          </View>
          <View style={styles.text}>
            <Text numberOfLines={1} style={[styles.name, { color: t.ink }]}>
              {name}
            </Text>
            <Text numberOfLines={1} style={[styles.stats, { color: t.ink }]}>
              {detail}
            </Text>
            <CaptionLine caption={caption} icon={captionIcon} />
          </View>
        </Pressable>
      }
    />
  );
}

const styles = StyleSheet.create({
  areaSwatch: {
    width: 32,
    height: 28,
    borderRadius: 6,
    borderWidth: 2.5,
    transform: [{ rotate: '-8deg' }],
  },
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
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  nameShrink: { flexShrink: 1 },
  stats: { fontSize: 14, lineHeight: 19, fontWeight: '600', ...tabularNums },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  captionRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  captionShrink: { flexShrink: 1 },
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

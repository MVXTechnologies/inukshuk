import { badgeIndex, sourceAbbreviation } from '@core/catalog/exploreFormat';
import type { CatalogBbox } from '@core/catalog/schema';
import type { LatLng } from '@core/models';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { tabularNums } from '@ui/fonts';
import { palette, radius, space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo, type ReactNode } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import Svg, { Path } from 'react-native-svg';

import { FootprintThumb } from './FootprintThumb';

/**
 * Building blocks of the map explorer (#447, boards `Main.dc.html` et al.):
 * section headings, the drawn map placeholder, carousel cards, filter chips,
 * activity/terrain tiles and collection rows. Presentational only — screens
 * own the data and navigation.
 */

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

/** A section title (20/800), with an optional text action on the right. */
export function SectionHeading({
  title,
  action,
}: {
  title: string;
  action?: { label: string; onPress: () => void; accessibilityLabel?: string };
}) {
  const t = useSchemeTokens();
  return (
    <View style={styles.heading}>
      <Text accessibilityRole="header" style={[styles.headingText, { color: t.ink }]}>
        {title}
      </Text>
      {action !== undefined && (
        <Pressable
          onPress={action.onPress}
          accessibilityRole="button"
          accessibilityLabel={action.accessibilityLabel ?? action.label}
          hitSlop={target.compactHitSlop}
          style={styles.headingAction}
        >
          <Text style={[styles.headingActionText, { color: t.explore.accent }]}>
            {action.label}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * The drawn preview a map without a publisher thumbnail gets: three contour
 * lines over paper, their shape and ink varied by `seed` so a row of cards
 * doesn't read as one image repeated.
 */
export const MapPlaceholder = memo(function MapPlaceholder({
  width,
  height,
  seed,
}: {
  width: number;
  height: number;
  seed: string;
}) {
  const t = useSchemeTokens();
  const n = badgeIndex(seed, 997);
  const ink = t.explore.placeholderContours[n % 3] ?? t.explore.placeholderContours[0];
  const o = ((n % 5) - 2) * 6;
  const w = 160;
  const h = 120;
  const curve = (y: number, a: number, b: number) =>
    `M0 ${y + o} C 40 ${y + a + o}, 90 ${y + b + o}, ${w} ${y - 20 + o}`;
  return (
    <View style={{ width, height, backgroundColor: t.explore.placeholder }}>
      <Svg width={width} height={height} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <Path d={curve(80, -30, 20)} stroke={ink} strokeWidth={1.3} fill="none" opacity={0.8} />
        <Path d={curve(55, -30, 20)} stroke={ink} strokeWidth={1.3} fill="none" opacity={0.8} />
        <Path d={curve(105, -25, 15)} stroke={ink} strokeWidth={1.6} fill="none" opacity={0.8} />
      </Svg>
    </View>
  );
});

/** A publisher thumbnail when the item has one, else the drawn placeholder. */
export function MapPreview({
  thumbnailUrl,
  seed,
  width,
  height,
}: {
  thumbnailUrl: string | undefined;
  seed: string;
  width: number;
  height: number;
}) {
  if (thumbnailUrl !== undefined) {
    return (
      <Image
        source={{ uri: thumbnailUrl }}
        style={{ width, height }}
        resizeMode="cover"
        accessibilityIgnoresInvertColors
      />
    );
  }
  return <MapPlaceholder width={width} height={height} seed={seed} />;
}

export const CARD_WIDTH = 160;
const CARD_IMAGE_HEIGHT = 120;

/**
 * One "Popular near you" card: picture + distance badge, title, meta line.
 * The picture is the sheet's footprint on an offline outline map when the
 * item has a bbox (`FootprintThumb`), else the publisher thumbnail, else the
 * drawn placeholder.
 */
export const MapCard = memo(function MapCard({
  id,
  title,
  meta,
  distance,
  thumbnailUrl,
  bbox,
  position = null,
  marker = false,
  external = false,
  onPress,
}: {
  id: string;
  title: string;
  meta: string;
  distance: string | null;
  thumbnailUrl: string | undefined;
  bbox?: CatalogBbox | undefined;
  position?: LatLng | null;
  /** Pin instead of footprint (a link-out place). */
  marker?: boolean;
  /** Opens the publisher's site: link role and an open-in-new mark. */
  external?: boolean;
  onPress: () => void;
}) {
  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={external ? 'link' : 'button'}
      accessibilityLabel={[title, meta, distance].filter(Boolean).join(', ')}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={[styles.cardImage, { borderColor: t.outlineVariant }]}>
        {bbox !== undefined ? (
          <FootprintThumb
            bbox={bbox}
            width={CARD_WIDTH}
            height={CARD_IMAGE_HEIGHT}
            position={position}
            marker={marker}
          />
        ) : (
          <MapPreview
            thumbnailUrl={thumbnailUrl}
            seed={id}
            width={CARD_WIDTH}
            height={CARD_IMAGE_HEIGHT}
          />
        )}
        {distance !== null && (
          <View style={[styles.distanceBadge, { backgroundColor: t.surface }]}>
            <Text style={[styles.distanceText, tabularNums, { color: t.inkVariant }]}>
              {distance}
            </Text>
          </View>
        )}
        {external && (
          <View style={[styles.externalBadge, { backgroundColor: t.surface }]}>
            <Icon source="open-in-new" size={14} color={t.inkVariant} />
          </View>
        )}
      </View>
      <Text numberOfLines={2} style={[styles.cardTitle, { color: t.ink }]}>
        {title}
      </Text>
      <Text numberOfLines={1} style={[styles.cardMeta, { color: t.inkMuted }]}>
        {meta}
      </Text>
    </Pressable>
  );
});

/** A pill filter chip (Library's chip tokens: stone when on, paper when off). */
export function FilterChip({
  label,
  on,
  onPress,
  icon,
  accessibilityLabel,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  icon?: string;
  accessibilityLabel?: string;
}) {
  const t = useSchemeTokens();
  const ink = on ? t.library.chipOnInk : t.library.chipInk;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={accessibilityLabel ?? label}
      style={styles.chipHit}
    >
      <View
        style={[
          styles.chip,
          on
            ? { backgroundColor: t.library.chipOn, borderColor: t.library.chipOn }
            : { backgroundColor: t.library.chip, borderColor: t.library.chipBorder },
        ]}
      >
        <Text style={[styles.chipLabel, { color: ink }]}>{label}</Text>
        {icon !== undefined && <Icon source={icon} size={16} color={ink} />}
      </View>
    </Pressable>
  );
}

/**
 * The explicit, labelled way into the explorer's map view (#474) — the
 * header's map glyph alone was not discoverable. A stone pill (the chips' "on"
 * tokens, so it reads as the primary action in both themes) with the map
 * glyph. `floating` lifts it over a list (shadow, no layout of its own).
 */
export function BrowseOnMapButton({
  onPress,
  label = 'Browse on the map',
  accessibilityLabel,
  floating = false,
}: {
  onPress: () => void;
  label?: string;
  accessibilityLabel?: string;
  floating?: boolean;
}) {
  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => [
        styles.browse,
        { backgroundColor: t.library.chipOn },
        floating && styles.browseFloating,
        pressed && styles.pressed,
      ]}
    >
      <Icon source="map-outline" size={20} color={t.library.chipOnInk} />
      <Text style={[styles.browseLabel, { color: t.library.chipOnInk }]}>{label}</Text>
    </Pressable>
  );
}

/** A horizontal, non-scrolling-parent-friendly row of chips. */
export function ChipRow({ children }: { children: ReactNode }) {
  return <View style={styles.chipRowWrap}>{children}</View>;
}

/** One activity tile: glyph over label, 4 to a row. */
export function ActivityTile({
  label,
  icon,
  count,
  width,
  onPress,
}: {
  label: string;
  icon: string;
  count: number | null;
  width: number;
  onPress: () => void;
}) {
  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={count === null ? label : `${label}, ${count} maps`}
      style={({ pressed }) => [
        styles.activity,
        { width, backgroundColor: t.surface, borderColor: t.outlineVariant },
        pressed && styles.pressed,
      ]}
    >
      <MaterialCommunityIcons name={icon as IconName} size={26} color={t.explore.accent} />
      <Text numberOfLines={1} style={[styles.activityLabel, { color: t.ink }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** One terrain tile: a coloured ground with the label and count. */
export function TerrainTile({
  label,
  countLabel,
  ground,
  onPress,
}: {
  label: string;
  countLabel: string | null;
  ground: string;
  onPress: () => void;
}) {
  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={countLabel === null ? label : `${label}, ${countLabel}`}
      style={({ pressed }) => [
        styles.terrain,
        { backgroundColor: ground },
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.terrainLabel, { color: t.explore.terrainInk }]}>{label}</Text>
      {countLabel !== null && (
        <Text style={[styles.terrainCount, tabularNums, { color: t.explore.terrainInk }]}>
          {countLabel}
        </Text>
      )}
    </Pressable>
  );
}

/** A collection row: badge, name, meta line, chevron (or an external-link glyph). */
export function CollectionRow({
  name,
  meta,
  badge,
  onPress,
  external = false,
  accessibilityHint,
}: {
  name: string;
  meta: string;
  badge: { kind: 'park' } | { kind: 'source'; id: string };
  onPress: () => void;
  external?: boolean;
  accessibilityHint?: string;
}) {
  const t = useSchemeTokens();
  const ground =
    badge.kind === 'park'
      ? t.explore.collectionBadge
      : (t.explore.sourceBadges[badgeIndex(badge.id, t.explore.sourceBadges.length)] ??
        t.explore.sourceBadges[0]);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={external ? 'link' : 'button'}
      accessibilityLabel={`${name}, ${meta}`}
      {...(accessibilityHint !== undefined ? { accessibilityHint } : {})}
      style={({ pressed }) => [
        styles.collection,
        { backgroundColor: t.surface, borderColor: t.outlineVariant },
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.badge, { backgroundColor: ground }]}>
        {badge.kind === 'park' ? (
          <MaterialCommunityIcons
            name="image-filter-hdr"
            size={26}
            color={t.explore.collectionBadgeInk}
          />
        ) : (
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            style={[styles.badgeText, { color: t.explore.sourceBadgeInk }]}
          >
            {sourceAbbreviation(name)}
          </Text>
        )}
      </View>
      <View style={styles.collectionText}>
        <Text numberOfLines={2} style={[styles.collectionName, { color: t.ink }]}>
          {name}
        </Text>
        <Text numberOfLines={2} style={[styles.collectionMeta, { color: t.inkMuted }]}>
          {meta}
        </Text>
      </View>
      <Icon source={external ? 'open-in-new' : 'chevron-right'} size={20} color={t.inkMuted} />
    </Pressable>
  );
}

/** A labelled stat tile (scale / size / distance) on the detail screen. */
export function ExploreStat({ value, label }: { value: string; label: string }) {
  const t = useSchemeTokens();
  return (
    <View
      style={[styles.stat, { backgroundColor: t.surface, borderColor: t.outlineVariant }]}
      accessible
      accessibilityLabel={`${label}: ${value}`}
    >
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={[styles.statValue, tabularNums, { color: t.ink }]}
      >
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: t.inkMuted }]}>{label}</Text>
    </View>
  );
}

/** A small tag chip (kind, activity, terrain) on the detail screen. */
export function TagChip({ label, strong = false }: { label: string; strong?: boolean }) {
  const t = useSchemeTokens();
  return (
    <View style={[styles.tag, { backgroundColor: strong ? t.library.onMap : t.surfaceVariant }]}>
      <Text style={[styles.tagText, { color: strong ? t.library.onMapInk : t.inkVariant }]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.85 },
  heading: {
    marginTop: 26,
    marginBottom: space.md,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  headingText: { flex: 1, fontSize: 20, lineHeight: 26, fontWeight: '800' },
  headingAction: { minHeight: target.compact, justifyContent: 'center' },
  headingActionText: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  card: { width: CARD_WIDTH, gap: 6 },
  cardImage: {
    width: CARD_WIDTH,
    height: CARD_IMAGE_HEIGHT,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  distanceBadge: {
    position: 'absolute',
    left: space.sm,
    bottom: space.sm,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  externalBadge: {
    position: 'absolute',
    right: space.sm,
    top: space.sm,
    padding: 4,
    borderRadius: 6,
  },
  distanceText: { fontSize: 12, lineHeight: 15, fontWeight: '700' },
  cardTitle: { fontSize: 15, lineHeight: 19, fontWeight: '700' },
  cardMeta: { fontSize: 13, lineHeight: 17 },
  chipRowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chipHit: { minHeight: target.min, justifyContent: 'center' },
  chip: {
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  chipLabel: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  browse: {
    alignSelf: 'flex-start',
    minHeight: target.min,
    paddingLeft: 14,
    paddingRight: 18,
    borderRadius: target.min / 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  browseFloating: {
    alignSelf: 'center',
    shadowColor: palette.shadow,
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  browseLabel: { fontSize: 15, lineHeight: 20, fontWeight: '800' },
  activity: {
    minHeight: 80,
    paddingVertical: space.md,
    paddingHorizontal: space.xs,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  activityLabel: { fontSize: 13, lineHeight: 17, fontWeight: '700' },
  terrain: {
    width: 132,
    height: 86,
    borderRadius: 14,
    padding: space.md,
    justifyContent: 'flex-end',
  },
  terrainLabel: { fontSize: 16, lineHeight: 20, fontWeight: '800' },
  terrainCount: { fontSize: 12, lineHeight: 16 },
  collection: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  badge: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { fontSize: 13, fontWeight: '800' },
  collectionText: { flex: 1, minWidth: 0, gap: 2 },
  collectionName: { fontSize: 16, lineHeight: 21, fontWeight: '800' },
  collectionMeta: { fontSize: 13, lineHeight: 18 },
  stat: {
    flex: 1,
    minWidth: 0,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: space.md,
  },
  statValue: { fontSize: 16, lineHeight: 21, fontWeight: '800' },
  statLabel: { fontSize: 12, lineHeight: 16 },
  tag: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  tagText: { fontSize: 12, lineHeight: 16, fontWeight: '700' },
});

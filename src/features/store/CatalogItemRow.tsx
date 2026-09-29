import type { InstallStatus } from '@core/catalog/installStatus';
import { catalogRowMeta, catalogSourceCaption } from '@core/catalog/nearbySections';
import type { CatalogItem, CatalogSource } from '@core/catalog/schema';
import type { Units } from '@core/format';
import { tabularNums } from '@ui/fonts';
import { radius, space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, ProgressBar, Text, useTheme } from 'react-native-paper';

import { LocatorThumb } from './LocatorThumb';

/**
 * One Maps-tab row (revamp `After-Maps.html`): a 56 dp locator thumbnail,
 * title, source caption, `31 MB · 12 km away`, and the one action the item's
 * install state calls for — a stone **Download**, a sage tonal **Downloaded ✓**
 * that opens the map, or **Update**. Tapping the row reveals the licence and
 * coverage details. Shared by the landing sections and the browse list, so a
 * sheet offers the same affordance wherever it is surfaced.
 */

/** Coverage line, hemisphere-correct for a worldwide catalog. */
function coverageLabel(bbox: readonly [number, number, number, number]): string {
  const lat = (value: number) => `${Math.abs(value).toFixed(2)}°${value < 0 ? 'S' : 'N'}`;
  const lon = (value: number) => `${Math.abs(value).toFixed(2)}°${value < 0 ? 'W' : 'E'}`;
  return `${lat(bbox[1])}–${lat(bbox[3])}, ${lon(bbox[0])}–${lon(bbox[2])}`;
}

/** The board's pill buttons are 44 dp; 2 dp of slop each side makes them 48. */
const PILL_HEIGHT = 44;
const PILL_SLOP = 2;

export interface CatalogItemRowProps {
  item: CatalogItem;
  source?: CatalogSource | undefined;
  installStatus: InstallStatus;
  /** Download progress 0..1, null for indeterminate, undefined when idle. */
  progress?: number | null | undefined;
  downloading: boolean;
  expanded: boolean;
  /** Metres to the user, when a position is known. */
  distanceMeters?: number | null | undefined;
  units: Units;
  onToggleExpand: () => void;
  /**
   * Explorer (#447): when set, tapping the row opens the map's detail screen
   * instead of expanding the licence/coverage lines in place.
   */
  onOpenDetails?: (() => void) | undefined;
  onDownload: () => void;
  onUpdate: () => void;
  onOpen: () => void;
  onCancel: () => void;
}

export function CatalogItemRow({
  item,
  source,
  installStatus,
  progress,
  downloading,
  expanded,
  distanceMeters,
  units,
  onToggleExpand,
  onOpenDetails,
  onDownload,
  onUpdate,
  onOpen,
  onCancel,
}: CatalogItemRowProps) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const muted = tokens.inkMuted;

  const caption = catalogSourceCaption(source?.name, item.region);
  const meta = catalogRowMeta(item.sizeBytes, distanceMeters, units);

  const action = downloading ? (
    <IconButton
      icon="close-circle-outline"
      accessibilityLabel={`Cancel download of ${item.title}`}
      onPress={onCancel}
    />
  ) : installStatus === 'installed' ? (
    <Pressable
      onPress={onOpen}
      hitSlop={PILL_SLOP}
      accessibilityRole="button"
      accessibilityLabel="Downloaded. Open on the map"
      style={({ pressed }) => [
        styles.pill,
        styles.downloaded,
        {
          backgroundColor: theme.colors.secondaryContainer,
          borderColor: theme.colors.secondary,
        },
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.pillText, { color: theme.colors.onSecondaryContainer }]}>
        Downloaded
      </Text>
      <Icon source="check-bold" size={15} color={theme.colors.onSecondaryContainer} />
    </Pressable>
  ) : installStatus === 'update-available' ? (
    <Pressable
      onPress={onUpdate}
      hitSlop={PILL_SLOP}
      accessibilityRole="button"
      accessibilityHint={item.title}
      style={({ pressed }) => [
        styles.pill,
        styles.downloaded,
        { backgroundColor: theme.colors.surface, borderColor: tokens.outline },
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.pillText, { color: tokens.ink }]}>Update</Text>
    </Pressable>
  ) : (
    <Pressable
      onPress={onDownload}
      hitSlop={PILL_SLOP}
      accessibilityRole="button"
      accessibilityHint={item.title}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: theme.colors.primary },
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.pillText, { color: theme.colors.onPrimary }]}>Download</Text>
    </Pressable>
  );

  return (
    <View>
      <Pressable
        onPress={onOpenDetails ?? onToggleExpand}
        accessibilityRole="button"
        {...(onOpenDetails !== undefined
          ? { accessibilityHint: "Opens the map's details" }
          : {
              accessibilityState: { expanded },
              accessibilityHint: 'Shows the licence and coverage',
            })}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <View
          style={[
            styles.thumb,
            { backgroundColor: tokens.elevation.level1, borderColor: tokens.divider },
          ]}
        >
          <LocatorThumb bbox={item.bbox} size={56} />
        </View>
        <View style={styles.text}>
          {/* Two lines, not the board's one: sheet titles carry their NTS/quad
              code at the end ("Saint-Raymond — CanTopo 021L13"), which one
              line would always cut. */}
          <Text numberOfLines={2} style={[styles.title, { color: tokens.ink }]}>
            {item.title}
          </Text>
          {caption !== '' && (
            <Text numberOfLines={1} style={[styles.caption, { color: muted }]}>
              {caption}
            </Text>
          )}
          {meta !== '' && (
            <Text style={[styles.caption, tabularNums, { color: muted }]}>{meta}</Text>
          )}
        </View>
        {action}
      </Pressable>
      {downloading && (
        <ProgressBar
          style={styles.progress}
          progress={progress ?? 0}
          indeterminate={progress === null || progress === undefined}
        />
      )}
      {expanded && (
        <View style={styles.details}>
          {source !== undefined && (
            <Text style={[styles.caption, { color: muted }]}>
              {source.attribution} — {source.licence}
            </Text>
          )}
          {item.updatedAt !== undefined && (
            <Text style={[styles.caption, { color: muted }]}>Updated {item.updatedAt}</Text>
          )}
          {item.bbox !== undefined && (
            <Text style={[styles.caption, { color: muted }]}>
              Coverage: {coverageLabel(item.bbox)}
            </Text>
          )}
          {source?.homepage !== undefined && (
            <Button
              compact
              icon="open-in-new"
              style={styles.sourceLink}
              onPress={() => void Linking.openURL(source.homepage ?? '')}
            >
              About this source
            </Button>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 76,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  rowPressed: { opacity: 0.85 },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  text: { flex: 1, minWidth: 0, gap: 1 },
  title: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  caption: { fontSize: 13, lineHeight: 18 },
  pill: {
    height: PILL_HEIGHT,
    borderRadius: PILL_HEIGHT / 2,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  downloaded: { borderWidth: 1, paddingHorizontal: space.md, gap: 6 },
  pressed: { opacity: 0.8 },
  pillText: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  progress: { marginHorizontal: space.lg, marginBottom: space.sm, height: 5, borderRadius: 3 },
  details: {
    paddingLeft: 84,
    paddingRight: space.lg,
    paddingBottom: space.md,
    gap: 3,
  },
  sourceLink: { alignSelf: 'flex-start', marginTop: 4, marginLeft: -8, borderRadius: radius.sm },
});

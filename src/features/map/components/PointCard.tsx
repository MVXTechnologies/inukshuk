/**
 * The normal-mode long-press card (#757 c, mockup 756 "757 (c)"): the team
 * long-press's grid with fewer cells — Waypoint, Navigate, Copy, Convert,
 * Share — docked in the bottom card slot like every other card. It replaces
 * the bubble whose 28 dp buttons were drawn in a map marker (and hit-tested
 * by the map). The header says where: the coordinates in the user's format,
 * then the distance and direction from my fix. A plain themed View
 * (paper-surface-ios-flex-collapse).
 */
import { PressGrid, type GridCell } from '@features/common/components/ActionGrid';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, View } from 'react-native';
import { Icon, IconButton, Text } from 'react-native-paper';

import { FLOATING_CARD_GAP } from '../bottomLayers';

export type PointCardAction = 'waypoint' | 'navigate' | 'copy' | 'convert' | 'share';

/** The cells, left to right. */
export const POINT_CARD_CELLS: readonly { k: PointCardAction; icon: string; label: string }[] = [
  { k: 'waypoint', icon: 'map-marker-plus-outline', label: 'Waypoint' },
  { k: 'navigate', icon: 'navigation-variant-outline', label: 'Navigate' },
  { k: 'copy', icon: 'content-copy', label: 'Copy' },
  { k: 'convert', icon: 'swap-horizontal', label: 'Convert' },
  { k: 'share', icon: 'share-variant-outline', label: 'Share' },
];

/** The text Share sends: the coordinates as shown, then a geo: link any map app opens. */
export function pointShareText(coords: string, latitude: number, longitude: number): string {
  return `${coords}\ngeo:${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

export function PointCard({
  coords,
  readout,
  floating,
  onAction,
  onClose,
}: {
  /** The point in the user's coordinate format. */
  coords: string;
  /** "1.2 km · NE" from my fix, or null without one. */
  readout: string | null;
  /** Over the recording panel: the dock already keeps the side gaps. */
  floating: boolean;
  onAction: (a: PointCardAction) => void;
  onClose: () => void;
}) {
  const t = useSchemeTokens();
  const cells: GridCell[] = POINT_CARD_CELLS.map(({ k, icon, label }) => ({
    icon,
    label,
    testID: `point-card-${k}`,
    run: () => onAction(k),
  }));
  return (
    <View
      style={[
        styles.card,
        !floating && styles.inset,
        { backgroundColor: t.elevation.level2, shadowColor: palette.shadow },
      ]}
      testID="point-card"
    >
      <View style={styles.head}>
        <Icon source="crosshairs" size={22} color={t.ink} />
        <View style={styles.flex} accessible accessibilityRole="text">
          <Text variant="titleSmall" style={{ color: t.ink }}>
            Here
          </Text>
          {/* Two lines at most: the coordinates never end in "…". */}
          <Text
            variant="bodySmall"
            style={{ color: t.inkVariant }}
            numberOfLines={2}
            testID="point-card-coords"
          >
            {readout === null ? coords : `${coords} · ${readout}`}
          </Text>
        </View>
        <IconButton
          icon="close"
          size={20}
          onPress={onClose}
          accessibilityLabel="Close"
          testID="point-card-close"
        />
      </View>
      <PressGrid cells={cells} testID="point-card-grid" />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  card: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 12,
    gap: 8,
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  inset: { marginHorizontal: FLOATING_CARD_GAP, marginBottom: FLOATING_CARD_GAP },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 4 },
});

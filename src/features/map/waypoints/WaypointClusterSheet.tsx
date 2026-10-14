import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useCoordinateFormatter } from '@state/useCoordinateFormatter';
import { useEffect, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, IconButton, Text } from 'react-native-paper';

import { visiblePinKey, type VisiblePin } from './pinHit';
import { useWaypointClusterSheet } from './waypointTap';
import { WaypointPinView } from './WaypointPinView';

interface Props {
  /** Every drawn pin (MapScreen's `visiblePins`): the sheet's keys resolve against it. */
  pins: readonly VisiblePin[];
  /** A row was picked: open that pin's card. The sheet has closed itself already. */
  onOpen: (pin: VisiblePin) => void;
  /** Floating above another bottom sheet (the recording panel): all corners rounded. */
  floating?: boolean;
  /**
   * Another card took the slot (a pin's card opened some other way): the
   * list closes for good rather than coming back when that card closes.
   */
  suppressed?: boolean;
}

/** Rows shown before the list scrolls. */
const VISIBLE_ROWS = 5;
const ROW_H = 56;

/**
 * The pins of a cluster that cannot split any further (#685, mockup
 * 252-pins "max zoom"): pins at one spot, or only apart past the camera's
 * cap. A bottom card in the waypoint card's dock — a plain themed View, never
 * a Portal (the #108 soft-lock) — listing them by name; a row opens that
 * pin's usual card. Nothing renders while the sheet is closed or none of its
 * pins is still drawn.
 */
export function WaypointClusterSheet({
  pins,
  onOpen,
  floating = false,
  suppressed = false,
}: Props) {
  const keys = useWaypointClusterSheet((s) => s.keys);
  const close = useWaypointClusterSheet((s) => s.close);
  const t = useSchemeTokens();
  const formatCoords = useCoordinateFormatter();
  const rows = useMemo(() => {
    if (keys === null) return [];
    const byKey = new Map(pins.map((p) => [visiblePinKey(p), p]));
    return keys.map((k) => byKey.get(k)).filter((p): p is VisiblePin => p !== undefined);
  }, [keys, pins]);
  useEffect(() => {
    if (suppressed) close();
  }, [suppressed, close]);
  if (suppressed || rows.length === 0) return null;
  return (
    <View
      style={[
        styles.card,
        floating && styles.floating,
        { backgroundColor: t.elevation.level2, shadowColor: palette.shadow },
      ]}
      testID="waypoint-cluster-sheet"
    >
      <View style={styles.header}>
        <View style={styles.titleBox}>
          <Text variant="titleMedium" style={{ color: t.ink }} accessibilityRole="header">
            {`${rows.length} waypoint${rows.length === 1 ? '' : 's'} here`}
          </Text>
          <Text variant="bodySmall" style={{ color: t.inkMuted }}>
            Pick one to open it
          </Text>
        </View>
        <IconButton
          icon="close"
          size={20}
          onPress={close}
          accessibilityLabel="Close the waypoint list"
          testID="waypoint-cluster-close"
        />
      </View>
      <ScrollView style={{ maxHeight: VISIBLE_ROWS * ROW_H }} bounces={false}>
        {rows.map((pin) => {
          const key = visiblePinKey(pin);
          const style = pin.source === 'saved' ? pin : null;
          return (
            <Pressable
              key={key}
              style={({ pressed }) => [
                styles.row,
                { borderTopColor: t.outlineVariant },
                pressed && { backgroundColor: t.elevation.level4 },
              ]}
              onPress={() => {
                useWaypointClusterSheet.getState().openedFrom(key);
                close();
                onOpen(pin);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Open ${pin.label}`}
              testID={`waypoint-cluster-row-${key}`}
            >
              <View style={styles.pin}>
                <WaypointPinView
                  icon={style?.icon}
                  color={style?.color}
                  size={style?.size}
                  diameter={24}
                />
              </View>
              <View style={styles.text}>
                <Text variant="bodyLarge" style={{ color: t.ink }} numberOfLines={1}>
                  {pin.label}
                </Text>
                <Text variant="bodySmall" style={{ color: t.inkMuted }} numberOfLines={1}>
                  {formatCoords(pin.latitude, pin.longitude)}
                </Text>
              </View>
              <Icon source="chevron-right" size={22} color={t.inkMuted} />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 4,
    paddingBottom: 8,
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 },
    elevation: 8,
  },
  floating: { borderRadius: 16 },
  header: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4 },
  titleBox: { flex: 1, paddingVertical: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: ROW_H,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  pin: { width: 28, alignItems: 'center' },
  text: { flex: 1 },
});

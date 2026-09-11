import {
  DEFAULT_WAYPOINT_ICON_LABEL,
  WAYPOINT_ICONS,
  waypointIconLabel,
} from '@core/library/waypointIcons';
import type { WaypointIcon } from '@core/models';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';
import { InukshukIcon } from './InukshukIcon';
import { mciGlyph } from './waypointGlyph';

interface Props {
  /** The waypoint's current icon; `undefined` = the default pin. */
  value: WaypointIcon | undefined;
  /** Pick an icon, or `undefined` to go back to the default pin. */
  onChange: (icon: WaypointIcon | undefined) => void;
}

const TILE = 44;
const GAP = 8;

/**
 * The waypoint editor's icon picker (#350): the default inukshuk pin plus the
 * dozen outdoor marks in `@core/library/waypointIcons`, so a map of twenty
 * waypoints reads at a glance instead of as a field of identical dots.
 *
 * **One scrolling row, not a wrapped grid.** Thirteen 44 px tiles wrap to three
 * rows on a small screen, and this dialog opens with the note field focused —
 * i.e. with the keyboard already eating half the height. Another ~190 px of
 * content there pushes Delete/Done off the bottom, and this Dialog does not
 * scroll. A row costs ~45 px and can never do that.
 *
 * Icon-only tiles with a caption naming the current choice, rather than a label
 * under every tile: thirteen captions is a wall of text in a dialog, and a
 * screen reader gets each tile's name from `accessibilityLabel` regardless. The
 * row is a radio group — one choice, always exactly one selected.
 *
 * Every colour comes from the Paper theme, so the tiles and the selection are
 * legible in both light and dark.
 */
export function WaypointIconPicker({ value, onChange }: Props) {
  const theme = useTheme();
  const scroller = useRef<ScrollView>(null);
  // The icon the editor opened on, captured once: scrolling the row back to it
  // on every change would fight the user as they try tiles out.
  const opened = useRef(value);

  // Open on the waypoint's own icon. Editing a "Hazard" waypoint — last in the
  // row — must not present a row scrolled to the start, where nothing looks
  // selected and the choice appears to have been lost.
  useEffect(() => {
    const index = WAYPOINT_ICONS.findIndex((spec) => spec.id === opened.current);
    // The chosen tile sits at index + 1 (the default pin leads the row); stop
    // one tile short of it so there is context on its left rather than a cut.
    if (index > 0) scroller.current?.scrollTo({ x: index * (TILE + GAP), animated: false });
  }, []);

  const tile = (
    icon: WaypointIcon | undefined,
    label: string,
    glyph: ReturnType<typeof mciGlyph>,
  ) => {
    const selected = value === icon;
    return (
      <Pressable
        key={icon ?? 'default'}
        onPress={() => onChange(icon)}
        accessibilityRole="radio"
        accessibilityLabel={label}
        accessibilityState={{ checked: selected, selected }}
        style={[
          styles.tile,
          {
            backgroundColor: selected ? theme.colors.primaryContainer : theme.colors.surfaceVariant,
            borderColor: selected ? theme.colors.primary : 'transparent',
          },
        ]}
      >
        {glyph === null ? (
          <InukshukIcon
            size={22}
            color={selected ? theme.colors.onPrimaryContainer : theme.colors.onSurfaceVariant}
          />
        ) : (
          <MaterialCommunityIcons
            name={glyph}
            size={22}
            color={selected ? theme.colors.onPrimaryContainer : theme.colors.onSurfaceVariant}
          />
        )}
      </Pressable>
    );
  };

  return (
    <View style={styles.wrap}>
      <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
        Pin icon
      </Text>
      <ScrollView
        ref={scroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        // The tiles are the touch targets; the row itself must not swallow a
        // press into a scroll gesture on a phone held in a cold hand.
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel="Pin icon">
          {tile(undefined, DEFAULT_WAYPOINT_ICON_LABEL, null)}
          {WAYPOINT_ICONS.map((spec) => tile(spec.id, spec.label, mciGlyph(spec.id)))}
        </View>
      </ScrollView>
      {/* Names the current choice for everyone who cannot tell "Ford" from
          "Water" by its glyph alone — which, at 22 px, is most people. */}
      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        {waypointIconLabel(value)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 12, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

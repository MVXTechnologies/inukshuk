import { StyleSheet, View } from 'react-native';
import { Icon, Text, TouchableRipple } from 'react-native-paper';
import { weatherChrome as wc } from '../weather/weatherChrome';
import { InukshukGlyph } from '@ui/components/InukshukGlyph';
import { MapButton } from './MapButton';

/**
 * The map-actions entry point (wave A item 6): the old bottom-right "+"
 * FAB.Group speed-dial sat exactly where the owner's thumb pans the map and
 * over the weather dock's corner — it moved to the TOP-RIGHT controls rail,
 * as a normal rail button directly below the Map overlays button. Tapping it
 * unfolds a compact dark sheet anchored under the rail with the same four
 * actions (labels unchanged — Maestro flows key on them).
 *
 * The sheet is a plain themed View in the rail's own column — never a
 * Portal/Menu (the invisible-overlay soft-lock landmine) and never a Paper
 * Surface (the absolutely-positioned iOS flex collapse) — following
 * WeatherModelSheet's pattern, with the same fixed dark chrome. `open` is
 * owned by the rail so it can also drop a map-covering backdrop that closes
 * the sheet on an outside tap.
 *
 * A11y/Maestro contract: the trigger keeps the EXACT label 'Map actions';
 * action rows keep 'Record track' / 'Add waypoint' / 'Download offline
 * area' / 'Make a map'. The guarded-tap idiom still holds — the action
 * labels only exist while the sheet is open, so they remain the open-state
 * sentinels. New rows are appended, never inserted, so an existing flow's
 * tap targets keep their position.
 */

export interface MapActions {
  onRecord: () => void;
  /** Drop a standalone waypoint at the current GPS position. */
  onAddWaypoint: () => void;
  /** Omitted while unavailable — region-select or a running download. */
  onDownload?: () => void;
  /** Open the map maker. Omitted in 3D. */
  onMakeMap?: () => void;
  /**
   * Open the coordinate readout/entry dialog (#97). This is the entry point
   * for BOTH halves of that feature — read the map centre out, or type a
   * coordinate to fly to / aim a destination at — which is why one row buys
   * the whole thing instead of two.
   *
   * Since #232 the PRIMARY way in is the map-tap chip's "Navigate to
   * coordinates", which opens the same dialog seeded with the tapped point.
   * This row survives as the way to type a coordinate you have not tapped.
   */
  onGoToCoordinates?: () => void;
  /** Open Settings (a stack route since Settings left the tab bar). */
  onOpenSettings?: () => void;
  /**
   * "Draw": opens the chooser between a route (#502) and an area (#503) —
   * one row for both drawing tools. Omitted in 3D.
   */
  onDraw?: () => void;
  /** Open Convert empty, to type a coordinate you have not tapped (appended last). */
  /** Team mode (#589): leave a message at the point chip, or the middle of the map. */
}

export function MapActionsMenu({
  actions,
  open,
  onToggle,
}: {
  actions: MapActions;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const run = (action: (() => void) | undefined) => () => {
    onToggle(false);
    action?.();
  };

  const row = (
    icon: string | null, // null = the inukshuk glyph
    label: string,
    onPress: () => void,
  ) => (
    <TouchableRipple onPress={onPress} accessibilityLabel={label} style={styles.row} borderless>
      <View style={styles.rowInner}>
        {icon === null ? (
          <InukshukGlyph size={20} frame="square" tone="mono" color={wc.ink} />
        ) : (
          <Icon source={icon} size={20} color={wc.ink} />
        )}
        <Text style={styles.rowLabel}>{label}</Text>
      </View>
    </TouchableRipple>
  );

  return (
    <>
      <MapButton
        icon={open ? 'close' : 'plus'}
        shape="square"
        onPress={() => onToggle(!open)}
        accessibilityLabel="Map actions"
      />
      {open && (
        <View style={styles.sheet}>
          {row('timer-outline', 'Record track', run(actions.onRecord))}
          {row(null, 'Add waypoint', run(actions.onAddWaypoint))}
          {actions.onDownload !== undefined &&
            row('tray-arrow-down', 'Download offline area', run(actions.onDownload))}
          {actions.onMakeMap !== undefined && row('map-plus', 'Make a map', run(actions.onMakeMap))}
          {actions.onGoToCoordinates !== undefined &&
            row('crosshairs', 'Navigate to coordinates', run(actions.onGoToCoordinates))}
          {actions.onOpenSettings !== undefined &&
            row('cog-outline', 'Settings', run(actions.onOpenSettings))}
          {actions.onDraw !== undefined && row('draw', 'Draw', run(actions.onDraw))}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  sheet: {
    minWidth: 210,
    backgroundColor: wc.panelSolid,
    borderRadius: 18,
    paddingVertical: 6,
    paddingHorizontal: 6,
  },
  row: { borderRadius: 12 },
  rowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
  },
  rowLabel: { flex: 1, fontSize: 14, lineHeight: 18, color: wc.ink },
});

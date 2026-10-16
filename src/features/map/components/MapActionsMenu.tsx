import { StyleSheet, View } from 'react-native';
import { Icon, Text, TouchableRipple } from '@ui/paper';
import { weatherChrome as wc } from '../weather/weatherChrome';
import { InukshukGlyph } from '@ui/components/InukshukGlyph';
import { MapButton } from './MapButton';
import { useScaledStyles, useDisplayScale } from '@ui/displayScale';

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
 * action rows keep 'Record track' / 'Pin my location' / 'Add waypoint' /
 * 'Download offline area' / 'Make a map'. The guarded-tap idiom still holds —
 * the action labels only exist while the sheet is open, so they remain the
 * open-state sentinels. Rows are appended, never inserted, so an existing
 * flow's tap targets keep their position — with one owner-ordered exception
 * (#709): 'Pin my location' (the fix: 2.5's 'Add waypoint') sits where the
 * old row was, and 'Add waypoint' (now at the centre cursor) follows it.
 */

export interface MapActions {
  onRecord: () => void;
  /** "Pin my location": a waypoint at the current GPS fix, in one tap (#671; #709 name). */
  onPinMyLocation: () => void;
  /** Its sub-line ("Waiting for a GPS fix…") while there is no fix. */
  pinMyLocationHint?: string;
  /** "Add waypoint": a waypoint at the centre cursor, in one tap (#709). */
  onAddWaypoint: () => void;
  /** Omitted while unavailable — region-select or a running download. */
  onDownload?: () => void;
  /** Open the map maker. Omitted in 3D. */
  onMakeMap?: () => void;
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
  const { sz } = useDisplayScale();

  const styles = useScaledStyles(stylesSheet);

  const run = (action: (() => void) | undefined) => () => {
    onToggle(false);
    action?.();
  };

  const row = (
    icon: string | null, // null = the inukshuk glyph
    label: string,
    onPress: () => void,
    sub?: string,
  ) => (
    <TouchableRipple
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityHint={sub}
      style={styles.row}
      borderless
    >
      <View style={styles.rowInner}>
        {icon === null ? (
          <InukshukGlyph size={sz(20)} frame="square" tone="mono" color={wc.ink} />
        ) : (
          <Icon source={icon} size={20} color={wc.ink} />
        )}
        <View style={styles.rowText}>
          <Text style={styles.rowLabel}>{label}</Text>
          {sub !== undefined && <Text style={styles.rowSub}>{sub}</Text>}
        </View>
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
          {row(
            'crosshairs-gps',
            'Pin my location',
            run(actions.onPinMyLocation),
            actions.pinMyLocationHint,
          )}
          {row(null, 'Add waypoint', run(actions.onAddWaypoint))}
          {actions.onDownload !== undefined &&
            row('tray-arrow-down', 'Download offline area', run(actions.onDownload))}
          {actions.onMakeMap !== undefined && row('map-plus', 'Make a map', run(actions.onMakeMap))}
          {actions.onOpenSettings !== undefined &&
            row('cog-outline', 'Settings', run(actions.onOpenSettings))}
          {actions.onDraw !== undefined && row('draw', 'Draw', run(actions.onDraw))}
        </View>
      )}
    </>
  );
}

const stylesSheet = StyleSheet.create({
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
  rowText: { flex: 1 },
  rowLabel: { fontSize: 14, lineHeight: 18, color: wc.ink },
  rowSub: { fontSize: 12, lineHeight: 16, color: wc.inkMuted },
});

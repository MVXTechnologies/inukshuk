import { metersPerPixel } from '@core/geo/scaleBar';
import { pinScaleFactor } from '@core/map/pinScale';
import { moveBarHint, moveSummary } from '@core/library/waypointActions';
import { pinGeometry, WAYPOINT_PIN_DIAMETER, waypointSize } from '@core/library/waypointStyle';
import type { Units } from '@core/format';
import type { LatLng } from '@core/models';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useWaypointMoveStore } from '@state/waypointMoveStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useRef } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { Button, Icon, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MapButton } from '../components/MapButton';
import { formatWaypointCoords } from './formatWaypointCoords';
import { WaypointPinView } from './WaypointPinView';
import { MAP_OVERLAY_Z } from '@features/map/overlayOrder';

interface Props {
  /** The map's settled zoom (for the precision hint), null before the first settle. */
  zoom?: number | null;
  units: Units;
  /** Put the pin back where it was and leave move mode. */
  onCancel: () => void;
  /** Save the pin at the map's centre and leave move mode. */
  onConfirm: () => void;
  /** Recentre on my position (the rail is hidden; Locate is the only map control). */
  onLocate: () => void;
}

/**
 * Move mode's chrome (#676, owner decision: pan the map under a FIXED pin).
 * The pin stays at the centre of the map with a crosshair under its tip, so
 * the finger never hides the spot; the user pans the map beneath it. A top
 * banner names the waypoint, and the bottom bar shows the live coordinates
 * and how far it has moved, with Cancel and Confirm. Locate is the only map
 * control left; the tab bar, search and + menu are hidden by their owners.
 *
 * Per-tick cost: nothing per frame. The coordinates and the distance come
 * from `mapStore.mapCenter`, which MapScreen sets once per settled camera
 * (onRegionDidChange) — so this re-renders once per pan, on idle. Android
 * Back cancels.
 */
export function MoveWaypointOverlay({ units, zoom = null, onCancel, onConfirm, onLocate }: Props) {
  const target = useWaypointMoveStore((s) => s.moving);
  const center = useMapStore((s) => s.mapCenter);
  // Settings › Pin size (#686): the moving pin matches the map's pins.
  const scale = useSettingsStore((s) => pinScaleFactor(s.pinScale));
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const cancelRef = useRef(onCancel);
  useEffect(() => {
    cancelRef.current = onCancel;
  });

  useEffect(() => {
    if (target === null) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      cancelRef.current();
      return true;
    });
    return () => sub.remove();
  }, [target]);

  if (target === null) return null;
  const at: LatLng = center ?? target.from;
  const summary = moveSummary(target.from, at, units);
  const diameter = WAYPOINT_PIN_DIAMETER[waypointSize(target.size)] * scale;
  const pinH = pinGeometry(diameter).height;
  const ink = tokens.team.mapInk;
  const halo = tokens.team.mapHalo;

  return (
    <View style={styles.root} pointerEvents="box-none" testID="move-waypoint">
      <View
        style={[
          styles.banner,
          { top: insets.top + 8, backgroundColor: theme.colors.elevation.level3 },
        ]}
        accessibilityRole="header"
      >
        <Icon source="arrow-all" size={20} color={theme.colors.onSurface} />
        {/* Two lines: a long name ellipsises on its own line and the hint is
          never cut ("Moving “Kiosque Edwin-Bélanger” · drag th…", QA 2.6.0). */}
        <View style={styles.bannerBody}>
          <Text
            numberOfLines={1}
            style={[styles.bannerText, { color: theme.colors.onSurface }]}
          >{`Moving “${target.label}”`}</Text>
          <Text
            numberOfLines={1}
            style={[styles.bannerHint, { color: theme.colors.onSurfaceVariant }]}
          >
            Drag the map to place it
          </Text>
        </View>
      </View>

      {/* The fixed pin: its tip is the map's centre (the wrapper's middle). */}
      <View style={styles.centre} pointerEvents="none">
        <View style={{ height: pinH * 2, alignItems: 'center' }} testID="move-pin">
          <WaypointPinView
            icon={target.icon}
            color={target.color}
            size={target.size}
            diameter={diameter}
          />
        </View>
      </View>
      <View style={styles.centre} pointerEvents="none" testID="move-crosshair">
        <View style={styles.cross}>
          <View style={[styles.shadow]} />
          <View style={[styles.hLine, styles.left, { backgroundColor: ink, borderColor: halo }]} />
          <View style={[styles.hLine, styles.right, { backgroundColor: ink, borderColor: halo }]} />
          <View style={[styles.vLine, styles.below, { backgroundColor: ink, borderColor: halo }]} />
          <View style={[styles.dot, { backgroundColor: ink, borderColor: halo }]} />
        </View>
      </View>

      <View
        style={[styles.locate, { bottom: BAR_HEIGHT + insets.bottom + 16 }]}
        pointerEvents="box-none"
      >
        <MapButton icon="crosshairs-gps" accessibilityLabel="My location" onPress={onLocate} />
      </View>

      <View
        style={[
          styles.bar,
          {
            paddingBottom: insets.bottom + 16,
            backgroundColor: theme.colors.elevation.level2,
            shadowColor: palette.black,
          },
        ]}
      >
        <Text
          style={[styles.coords, { color: theme.colors.onSurface }]}
          selectable
          testID="move-coords"
        >
          {formatWaypointCoords(at.latitude, at.longitude)}
        </Text>
        <Text style={[styles.hint, { color: theme.colors.onSurfaceVariant }]}>
          {moveBarHint(summary, zoom === null ? null : metersPerPixel(zoom, at.latitude))}
        </Text>
        <View style={styles.buttons}>
          <Button
            mode="outlined"
            onPress={onCancel}
            style={styles.button}
            contentStyle={styles.buttonContent}
            accessibilityLabel="Cancel move"
          >
            Cancel
          </Button>
          <Button
            mode="contained"
            onPress={onConfirm}
            style={styles.button}
            contentStyle={styles.buttonContent}
            accessibilityLabel="Confirm move"
          >
            Confirm
          </Button>
        </View>
      </View>
    </View>
  );
}

const BAR_HEIGHT = 140;
const ARM = 18;
const GAP = 6;

const styles = StyleSheet.create({
  // Above the recording panel (6), a waypoint card (7) and the snackbars (8):
  // move mode owns the screen until Confirm or Cancel.
  root: { ...StyleSheet.absoluteFill, zIndex: MAP_OVERLAY_Z.moveOverlay },
  banner: {
    position: 'absolute',
    left: 16,
    right: 16,
    minHeight: 52,
    paddingVertical: 6,
    borderRadius: 26,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    elevation: 4,
    shadowColor: palette.black,
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  bannerBody: { flex: 1, minWidth: 0 },
  bannerText: { fontSize: 14.5, fontWeight: '700' },
  bannerHint: { fontSize: 12.5 },
  centre: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cross: { width: 2 * (ARM + GAP), height: 2 * (ARM + GAP) },
  shadow: {
    position: 'absolute',
    left: ARM + GAP - 9,
    top: ARM + GAP - 3,
    width: 18,
    height: 7,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  hLine: { position: 'absolute', top: ARM + GAP - 1, width: ARM, height: 2, borderWidth: 0 },
  vLine: { position: 'absolute', left: ARM + GAP - 1, width: 2, height: ARM, borderWidth: 0 },
  left: { left: 0 },
  right: { right: 0 },
  below: { bottom: 0 },
  dot: {
    position: 'absolute',
    left: ARM + GAP - 2.5,
    top: ARM + GAP - 2.5,
    width: 5,
    height: 5,
    borderRadius: 2.5,
    borderWidth: 0.5,
  },
  locate: { position: 'absolute', right: 16 },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: BAR_HEIGHT,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 14,
    paddingHorizontal: 16,
    elevation: 8,
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: -4 },
  },
  coords: { fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  hint: { fontSize: 13, marginTop: 2 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 14 },
  button: { flex: 1, borderRadius: 24 },
  buttonContent: { height: 48 },
});

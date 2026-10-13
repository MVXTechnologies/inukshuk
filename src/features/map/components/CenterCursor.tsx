import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

/** The dot's diameter and its ring's width, in dp (mockup #677: 7 dp, 1.5 dp ring). */
export const CURSOR_DOT = 7;
export const CURSOR_RING = 1.5;

/**
 * The map's centre cursor (#677): a 7 dp stone dot in a paper ring at the
 * centre of the map view — the point the coordinates chip reads out.
 *
 * Absolutely centred over the map, touch-transparent, and STATIC: the camera
 * moves under it, so panning costs it nothing (no camera subscription at
 * all). It re-renders only when the setting or follow mode flips.
 *
 * Hidden while the camera follows the user — the puck marks that spot, and
 * the chip shows the user's position instead — and while `suppressed` (the
 * region selector or map maker owns the screen).
 */
export const CenterCursor = memo(function CenterCursor({ suppressed }: { suppressed: boolean }) {
  const on = useSettingsStore((s) => s.showCenterCursor);
  const following = useMapStore((s) => s.followUser);
  const t = useSchemeTokens();
  if (!on || following || suppressed) return null;
  return (
    <View style={styles.center} pointerEvents="none" testID="map-center-cursor">
      <View
        style={[styles.ring, { backgroundColor: t.map.cursorRing }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View style={[styles.dot, { backgroundColor: t.map.cursor }]} testID="map-center-dot" />
      </View>
    </View>
  );
});

const OUTER = CURSOR_DOT + 2 * CURSOR_RING;

const styles = StyleSheet.create({
  center: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    width: OUTER,
    height: OUTER,
    borderRadius: OUTER / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: CURSOR_DOT, height: CURSOR_DOT, borderRadius: CURSOR_DOT / 2 },
});

import { prefillFromPoint } from '@core/convert/prefill';
import { fixAltitude } from '@core/gnss/receiver';
import {
  ALTITUDE_SEPARATOR,
  altitudeFits,
  chipAltitudeText,
  isRealCenter,
  type AltitudeSource,
} from '@core/map/coordinatesChip';
import { openConvert } from '@features/convert/openConvert';
import { useGnssStore } from '@state/gnssStore';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useCoordinateFormatter } from '@state/useCoordinateFormatter';
import { useChromeOutline } from '@ui/useChromeOutline';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { memo } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { create } from 'zustand';

import { useCenterElevation } from '../centerElevation';

/**
 * Below this window width the chip drops to its compact form (~10 m: 4
 * decimals, whole seconds, a 4+4 MGRS) before anything in the bottom row can
 * wrap. Mockup #677's budget: at 390 dp the ⓘ + scale take ~120 and the chip
 * ~185, with ~50 to spare; a 360 dp phone has 30 dp less than that.
 */
export const COMPACT_BELOW_DP = 380;

/**
 * The room the bottom row leaves the chip, measured: the row's end side and
 * the tip button in it report their widths here (MapScreen wires the two
 * onLayouts). A store the CHIP subscribes to, not MapScreen state: a scale
 * bar that changes width on a settle must not re-render the map screen.
 */
const useChipRoom = create<{ rowW: number | null; tipW: number }>(() => ({
  rowW: null,
  tipW: 0,
}));
export const onChipRowLayout = (e: LayoutChangeEvent) =>
  useChipRoom.setState({ rowW: e.nativeEvent.layout.width });
export const onTipSlotLayout = (e: LayoutChangeEvent) =>
  useChipRoom.setState({ tipW: e.nativeEvent.layout.width });
/** Test hook: forget the measured room. */
export const resetChipRoom = () => useChipRoom.setState({ rowW: null, tipW: 0 });

/** Before the row is measured: ⓘ + the widest scale bar + gaps, and a tip button. */
const UNMEASURED_RESERVED_DP = 32 + 30 + 120 + 6 + 42;

/**
 * The coordinates chip (#677): the map centre's position — the point under
 * the centre cursor — in the bottom row, right of the ⓘ + scale, in the
 * scale bar's chip style, written in the app-wide coordinate format, with
 * its altitude after it when there is room.
 *
 * - Altitude: the centre's GROUND elevation from the DEM (`≈412 m`, see
 *   `@core/map/coordinatesChip` for the "≈"), or while following your fix's
 *   altitude exactly as the recording panel shows it. Absent when unknown
 *   (offline with no cached tile, a fix without altitude): never a stale
 *   number, never "0 m", never a spinner.
 * - Tap copies the COORDINATES ALONE, and the snackbar says exactly what was
 *   copied ("Copied 46.81394, -71.20761"): they are what every destination
 *   (a search box, Convert, another app) parses, and an appended "≈412 m"
 *   would break that. The altitude is set apart in a muted span, so the
 *   copied part is visibly the first one. Long-press opens Convert there.
 * - SETTLE-driven: it reads `mapStore.mapCenter`, written once per camera
 *   settle (never per frame), and subscribes in this leaf, so a pan
 *   re-renders neither the map screen nor, until the camera stops, the chip.
 *   Per settle: one format, and an LRU lookup + 4-pixel blend when the DEM
 *   tile is cached; else one tile load (and one more render when it lands).
 * - While following, `you` is the user's position (a small locate mark; the
 *   centre dot hides). One format per fix, in this leaf only; no DEM read.
 */
export const CenterCoordinatesChip = memo(function CenterCoordinatesChip({
  you,
  youAltitudeM,
  onCopied,
}: {
  /** The user's position while the camera follows them, else null. */
  you: { latitude: number; longitude: number } | null;
  /** The phone fix's altitude while following (the recorder's value), else null. */
  youAltitudeM: number | null;
  onCopied: (message: string) => void;
}) {
  const on = useSettingsStore((s) => s.showCenterCursor);
  const units = useSettingsStore((s) => s.units);
  const settled = useMapStore((s) => s.mapCenter);
  // No camera yet (0, 0 on first launch): no chip and no elevation lookup.
  const center = isRealCenter(settled) ? settled : null;
  // An external receiver in use feeds the recorder its own altitude: show
  // that one. Decimetres, so a jittering fix does not re-render per digit.
  const externalAltitude = useGnssStore((s) => {
    if (you === null || s.use !== 'external') return undefined;
    const alt = s.fix === null ? null : fixAltitude(s.fix);
    return alt === null ? null : Math.round(alt * 10) / 10;
  });
  const room = useChipRoom((s) =>
    s.rowW === null ? null : s.rowW - (s.tipW > 0 ? s.tipW + 6 : 0),
  );
  const format = useCoordinateFormatter();
  const { width } = useWindowDimensions();
  const router = useRouter();
  const t = useSchemeTokens();
  const outline = useChromeOutline();

  const following = you !== null;
  const at = you !== null && isRealCenter(you) ? you : following ? null : center;
  // The DEM is read only for the centre, and only while the chip is shown.
  const ground = useCenterElevation(on && !following ? center : null);
  if (!on || at === null) return null;

  const text = format(at.latitude, at.longitude, { compact: width < COMPACT_BELOW_DP });
  const gps = externalAltitude === undefined ? youAltitudeM : externalAltitude;
  const alt: { m: number; source: AltitudeSource } | null = following
    ? gps === null
      ? null
      : { m: gps, source: 'gps' }
    : ground === null
      ? null
      : { m: ground, source: 'dem' };
  const altText = alt === null ? null : chipAltitudeText(alt.m, units, alt.source);
  const available = room ?? width - UNMEASURED_RESERVED_DP;
  const showAlt = altText !== null && altitudeFits(available, text, altText, following);

  return (
    <Pressable
      onPress={() => {
        void Clipboard.setStringAsync(text);
        onCopied(`Copied ${text}`);
      }}
      onLongPress={() => openConvert(router, prefillFromPoint(at.latitude, at.longitude))}
      accessibilityRole="button"
      accessibilityLabel={
        `${following ? 'Your position' : 'Map centre'} ${text}` +
        (showAlt && alt !== null
          ? alt.source === 'dem'
            ? `, ground elevation about ${altText.replace('≈', '')}`
            : `, altitude ${altText}`
          : '')
      }
      accessibilityHint="Copies the coordinates. Long-press to convert them."
      hitSlop={6}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: t.map.chip },
        outline,
        pressed && styles.pressed,
      ]}
      testID="map-center-coords"
    >
      {following && (
        <Icon source="crosshairs-gps" size={14} color={t.map.chipInk} testID="map-coords-you" />
      )}
      <Text
        style={[styles.text, { color: t.map.chipInk }]}
        numberOfLines={1}
        // The last resort after the compact form: shrink a little, never wrap.
        adjustsFontSizeToFit
        minimumFontScale={0.85}
        testID="map-coords-text"
      >
        {text}
        {showAlt && (
          <Text style={{ color: t.map.chipInkMuted }} testID="map-coords-altitude">
            {ALTITUDE_SEPARATOR}
            {altText}
          </Text>
        )}
      </Text>
      <Icon source="content-copy" size={15} color={t.map.chipInkMuted} />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 15,
    flexShrink: 1,
  },
  text: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'], flexShrink: 1 },
  pressed: { opacity: 0.7 },
});

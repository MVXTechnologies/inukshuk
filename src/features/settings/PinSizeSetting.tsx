import {
  WAYPOINT_COLORS,
  WAYPOINT_PIN_DIAMETER,
  WAYPOINT_SIZES,
} from '@core/library/waypointStyle';
import {
  PIN_SCALES,
  isPinScale,
  normalizePinScale,
  pinScaleFactor,
  pinScaleLabel,
} from '@core/map/pinScale';
import { WaypointPinView } from '@features/map/waypoints/WaypointPinView';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, View } from 'react-native';
import { List, SegmentedButtons } from '@ui/paper';
import { useScaledStyles } from '@ui/displayScale';

const OPTIONS = PIN_SCALES.map((v) => ({
  value: String(v),
  label: pinScaleLabel(v),
  accessibilityLabel: `Pin size ${v} percent`,
  testID: `pin-size-${v}`,
}));

/** The preview's colours: the default sage and three of the palette, so sizes read apart. */
const paletteHex = (name: string) => WAYPOINT_COLORS.find((c) => c.name === name)?.hex;
const PREVIEW_COLORS = [undefined, paletteHex('Blue'), paletteHex('Yellow'), paletteHex('Red')];
const PREVIEW_ICONS = [undefined, 'water', 'camp', 'shelter'] as const;
/** The preview is drawn at this fraction of the map's size, so 150 % XL fits the row. */
const PREVIEW_K = 0.7;

/**
 * Settings › Display › Pin size (#686): every waypoint pin on the map at 75,
 * 100, 125 or 150 %, on top of its own S/M/L/XL. A live preview of the four
 * sizes at the chosen scale sits under the segments.
 */
export function PinSizeSetting() {
  const styles = useScaledStyles(stylesSheet);

  // The store normalises on hydrate; normalise here too, so the row never shows junk.
  const scale = normalizePinScale(useSettingsStore((s) => s.pinScale));
  const set = useSettingsStore((s) => s.set);
  const t = useSchemeTokens();
  const k = pinScaleFactor(scale);
  return (
    <>
      <List.Item
        title="Pin size"
        // Short: at 150 % a two-line subtitle pushed the controls down (2.5.2 QA).
        description={`${pinScaleLabel(scale)} · scales every pin on the map`}
        descriptionNumberOfLines={1}
      />
      <View style={styles.segment}>
        <SegmentedButtons
          value={String(scale)}
          onValueChange={(v) => {
            const n = Number(v);
            if (isPinScale(n)) set('pinScale', n);
          }}
          buttons={OPTIONS}
        />
      </View>
      <View
        style={[styles.preview, { backgroundColor: t.surfaceVariant }]}
        testID="pin-size-preview"
        accessible
        accessibilityLabel={`Preview: small, medium, large and extra large pins at ${pinScaleLabel(scale)}`}
      >
        {WAYPOINT_SIZES.map((size, i) => (
          <WaypointPinView
            key={size}
            size={size}
            color={PREVIEW_COLORS[i]}
            icon={PREVIEW_ICONS[i]}
            diameter={Math.round(WAYPOINT_PIN_DIAMETER[size] * k * PREVIEW_K)}
          />
        ))}
      </View>
    </>
  );
}

const stylesSheet = StyleSheet.create({
  // Same inset as the Units and Coordinates segments around it.
  segment: { paddingHorizontal: 16, paddingBottom: 8 },
  preview: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
    height: 76,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 16,
    paddingBottom: 8,
  },
});

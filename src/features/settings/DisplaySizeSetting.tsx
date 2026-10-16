import {
  DISPLAY_SCALES,
  displayScalePercent,
  displayScaleLabel,
  normalizeDisplayScale,
  type DisplayScale,
} from '@core/display/displayScale';
import { useSettingsStore } from '@state/settingsStore';
import { useScaledStyles } from '@ui/displayScale';
import { List, Text, useTheme } from '@ui/paper';
import { Pressable, StyleSheet, View } from 'react-native';

/**
 * The "A" in each segment, growing from Small to Large (sp at 100 %; it
 * scales with the rest of the row).
 */
export const SIZE_GLYPH_SP: Record<DisplayScale, number> = { 0.85: 12, 1: 15, 1.15: 18 };
/** Segment labels are capped at this OS font scale so the three fit at 360 dp. */
export const SIZE_LABEL_FONT_CAP = 1.15;
/** Label size (sp) and the segment's content padding (dp), at 100 %. */
export const SIZE_LABEL_SP = 14;
export const SIZE_SEGMENT_PAD = 8;
export const SIZE_GLYPH_GAP = 6;

/**
 * Settings › Display › Display size (#760): Small 85 %, Default 100 %, Large
 * 115 %, as one segmented control. A tap applies at once, so the Settings
 * screen itself is the live preview. Paper's SegmentedButtons pads its
 * content 16 dp a side, which leaves no room for the growing "A" at Large on
 * a 360 dp phone; this control draws the same outlined look with 8.
 */
export function DisplaySizeSetting() {
  const styles = useScaledStyles(stylesSheet);
  const value = normalizeDisplayScale(useSettingsStore((s) => s.displayScale));
  const set = useSettingsStore((s) => s.set);
  const theme = useTheme();
  return (
    <>
      <List.Item title="Display size" />
      <View
        style={[styles.group, { borderColor: theme.colors.outline }]}
        accessibilityRole="radiogroup"
        accessibilityLabel="Display size"
      >
        {DISPLAY_SCALES.map((v, i) => {
          const on = v === value;
          const ink = on ? theme.colors.onSecondaryContainer : theme.colors.onSurface;
          return (
            <Pressable
              key={v}
              testID={`display-size-${v}`}
              onPress={() => set('displayScale', v)}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${displayScaleLabel(v)}, ${displayScalePercent(v)}`}
              style={({ pressed }) => [
                styles.segment,
                i > 0 && [styles.divider, { borderLeftColor: theme.colors.outline }],
                on && { backgroundColor: theme.colors.secondaryContainer },
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[styles.glyph, glyphStyle(styles, v), { color: ink }]}
                maxFontSizeMultiplier={SIZE_LABEL_FONT_CAP}
                importantForAccessibility="no"
              >
                A
              </Text>
              <Text
                style={[styles.label, { color: ink }]}
                numberOfLines={1}
                maxFontSizeMultiplier={SIZE_LABEL_FONT_CAP}
              >
                {displayScaleLabel(v)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </>
  );
}

function glyphStyle(styles: typeof stylesSheet, v: DisplayScale) {
  if (v === 0.85) return styles.glyphSmall;
  if (v === 1.15) return styles.glyphLarge;
  return styles.glyphDefault;
}

const stylesSheet = StyleSheet.create({
  // Same inset as the Units and Pin size segments around it.
  group: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: 20,
    overflow: 'hidden',
  },
  segment: {
    flex: 1,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SIZE_GLYPH_GAP,
    paddingHorizontal: SIZE_SEGMENT_PAD,
  },
  divider: { borderLeftWidth: 1 },
  pressed: { opacity: 0.7 },
  glyph: { fontWeight: '800' },
  glyphSmall: { fontSize: SIZE_GLYPH_SP[0.85], lineHeight: 16 },
  glyphDefault: { fontSize: SIZE_GLYPH_SP[1], lineHeight: 20 },
  glyphLarge: { fontSize: SIZE_GLYPH_SP[1.15], lineHeight: 22 },
  label: { fontSize: SIZE_LABEL_SP, lineHeight: 20, fontWeight: '500', flexShrink: 1 },
});

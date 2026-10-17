import { ASPECT_SECTORS } from '@core/geo/slopeField';
import { SLOPE_BANDS } from '@core/geo/terrainAnalysis';
import {
  altitudeFromSlider,
  altitudeScaleLabels,
  altitudeSlider,
  altitudeSliderValue,
  aspectSelected,
  aspectSelectionLabel,
  DEFAULT_SLOPE_FILTER,
  DEFAULT_SLOPE_MAX_DEG,
  DEFAULT_SLOPE_MIN_DEG,
  showSlopeLegend,
  slopeLegendText,
  slopeRowHint,
  slopeSettingsAreDefault,
  steepnessLabel,
  toggleAllAspects,
  toggleAspect,
} from '@core/map/slopeSettings';
import { useSettingsStore } from '@state/settingsStore';
import { useTerrainAreaStore } from '@state/terrainAreaStore';
import { palette } from '@ui/tokens';
import { useChromeOutline } from '@ui/useChromeOutline';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@ui/paper';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';
import {
  SectionTitle,
  SubPanelButton,
  SubPanelHeader,
  SwitchRow,
  useSheetAccent,
  useSheetWidth,
} from './mapSheet';
import { RangeSlider } from './RangeSlider';
import { useScaledStyles, useDisplayScale } from '@ui/displayScale';

/**
 * The slope layer's options (#723, mockup B1–B4, owner pick: Option 2
 * "combined"): the Slope row in Map layers › Terrain with its sub-panel
 * accessory, the sub-panel itself (Steepness, Altitude, Aspect, Reset) and
 * the map's legend chip while a filter is on. The wording and the rules live
 * in `@core/map/slopeSettings`.
 */

/** The legend chip's petal colour (Option 2: the bands' red, 35°–44°). */
const LEGEND_PETAL = 'rgb(214,44,34)';
/** The steepness bands' widths in the legend strip (mockup B2). */
const BAND_FLEX = [1, 1, 1, 3, 1.5];
/** Value label beside the steepness track. */
const STEEP_VALUE_W = 88;
/** Value label + the "+" button beside the altitude track. */
const ALT_SIDE_W = 122;
const SIDE_PAD = 16;

function useSlopeSettings() {
  const slope = useSettingsStore((s) => s.terrainSlope);
  const minDeg = useSettingsStore((s) => s.terrainSlopeMinDeg);
  const maxDeg = useSettingsStore((s) => s.terrainSlopeMaxDeg);
  const filter = useSettingsStore((s) => s.terrainSlopeFilter);
  const units = useSettingsStore((s) => s.units);
  return { slope, minDeg, maxDeg, filter, units };
}

/**
 * Map layers › Terrain › Slope (mockup B1): the switch, and the round
 * chevron to its page; the hint says what is shaded ("NW · N · NE · 30–90°
 * · 800 m+", "All aspects · 27–90°").
 */
export function SlopeRow({
  onOpen,
  onSlopeEnabled,
}: {
  onOpen: () => void;
  onSlopeEnabled: () => void;
}) {
  const { slope, minDeg, maxDeg, filter, units } = useSlopeSettings();
  const set = useSettingsStore((s) => s.set);
  return (
    <SwitchRow
      icon="angle-acute"
      label="Slope"
      hint={slopeRowHint(minDeg, maxDeg, filter, units)}
      value={slope}
      onToggle={() => {
        const next = !slope;
        set('terrainSlope', next);
        if (next) onSlopeEnabled();
      }}
      accessory={
        <SubPanelButton
          onPress={onOpen}
          accessibilityLabel="Options for slope"
          testID="slope-options"
        />
      }
    />
  );
}

/** "Reset": steepness, aspects and altitude back to their defaults; quiet while they are. */
function SlopeReset({ onReset }: { onReset: () => void }) {
  const styles = useScaledStyles(stylesSheet);

  const tokens = useSchemeTokens();
  const { accent } = useSheetAccent();
  const { minDeg, maxDeg, filter } = useSlopeSettings();
  const set = useSettingsStore((s) => s.set);
  const idle = slopeSettingsAreDefault(minDeg, maxDeg, filter);
  return (
    <Pressable
      onPress={() => {
        set('terrainSlopeMinDeg', DEFAULT_SLOPE_MIN_DEG);
        set('terrainSlopeMaxDeg', DEFAULT_SLOPE_MAX_DEG);
        set('terrainSlopeFilter', DEFAULT_SLOPE_FILTER);
        onReset();
      }}
      disabled={idle}
      accessibilityRole="button"
      accessibilityLabel="Reset slope options"
      accessibilityState={{ disabled: idle }}
      hitSlop={8}
    >
      <Text style={[styles.reset, { color: idle ? tokens.inkMuted : accent }]}>Reset</Text>
    </Pressable>
  );
}

/** The steepness bands as a strip with their thresholds (mockup B2). */
function BandStrip() {
  const styles = useScaledStyles(stylesSheet);

  const tokens = useSchemeTokens();
  return (
    <View accessible accessibilityLabel="Bands from 27°, 30°, 32°, 35°, 45° and up">
      <View style={styles.bands}>
        {SLOPE_BANDS.map((b, i) => (
          <View
            key={b.minDeg}
            style={{
              flex: BAND_FLEX[i] ?? 1,
              backgroundColor: `rgb(${b.rgb[0]},${b.rgb[1]},${b.rgb[2]})`,
            }}
          />
        ))}
      </View>
      <View style={styles.bandLabels}>
        {SLOPE_BANDS.map((b, i) => (
          <Text
            key={b.minDeg}
            style={[styles.bandLabel, { flex: BAND_FLEX[i] ?? 1, color: tokens.inkMuted }]}
          >
            {i === SLOPE_BANDS.length - 1 ? `${b.minDeg}°+` : `${b.minDeg}°`}
          </Text>
        ))}
      </View>
    </View>
  );
}

const TAU = Math.PI * 2;
const ROSE = 196;

/** An annulus sector, angles in radians clockwise from north, centred on (c, c). */
function wedge(c: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) =>
    `${(c + r * Math.sin(a)).toFixed(2)} ${(c - r * Math.cos(a)).toFixed(2)}`;
  return `M${p(r0, a0)} L${p(r1, a0)} A${r1} ${r1} 0 0 1 ${p(r1, a1)} L${p(r0, a1)} A${r0} ${r0} 0 0 0 ${p(r0, a0)}Z`;
}

/**
 * The aspect rose (mockup B2): eight petals, tap to toggle (selected fill
 * sage), the "All" hub toggles all/none, a compass ring around. Each petal
 * and the hub is its own accessible toggle.
 */
export function AspectRose({ mask, onChange }: { mask: number; onChange: (mask: number) => void }) {
  const styles = useScaledStyles(stylesSheet);
  // #760: the rose is drawn in its 196-unit viewBox at the Display size; the
  // touch targets are placed in the same scaled box.
  const { sz } = useDisplayScale();
  const f = sz(ROSE) / ROSE;
  const petal = sz(44) / 2;
  const hub = sz(52) / 2;

  const tokens = useSchemeTokens();
  const { accent, onAccent } = useSheetAccent();
  const C = ROSE / 2;
  const R0 = 31;
  const R1 = 84;
  const LABEL_R = 60;
  const all = (mask & 0xff) === 0xff;
  return (
    <View style={styles.roseBox} accessibilityRole="none" accessibilityLabel="Aspect">
      <Svg width="100%" height="100%" viewBox={`0 0 ${ROSE} ${ROSE}`}>
        {Array.from({ length: 72 }, (_, i) => {
          const a = (i / 72) * TAU;
          const big = i % 9 === 0;
          const r2 = big ? 96 : 94;
          return (
            <Line
              key={`t${i}`}
              x1={C + 90 * Math.sin(a)}
              y1={C - 90 * Math.cos(a)}
              x2={C + r2 * Math.sin(a)}
              y2={C - r2 * Math.cos(a)}
              stroke={tokens.inkMuted}
              strokeOpacity={big ? 0.8 : 0.35}
              strokeWidth={big ? 1.6 : 1}
            />
          );
        })}
        {ASPECT_SECTORS.map((name, k) => {
          const g = 0.035;
          const a0 = ((k - 0.5) * Math.PI) / 4 + g;
          const a1 = ((k + 0.5) * Math.PI) / 4 - g;
          const am = (k * Math.PI) / 4;
          const on = aspectSelected(mask, k);
          return (
            <G key={name}>
              <Path d={wedge(C, R0, R1, a0, a1)} fill={on ? accent : tokens.surfaceVariant} />
              <SvgText
                x={C + LABEL_R * Math.sin(am)}
                y={C - LABEL_R * Math.cos(am) + 4.5}
                textAnchor="middle"
                fontSize={k % 2 ? 11.5 : 13.5}
                fontWeight="800"
                fill={on ? onAccent : tokens.inkVariant}
              >
                {name}
              </SvgText>
            </G>
          );
        })}
        <Circle
          cx={C}
          cy={C}
          r={26}
          fill={tokens.surface}
          stroke={all ? accent : tokens.outlineVariant}
          strokeWidth={2}
        />
        <SvgText
          x={C}
          y={C + 4}
          textAnchor="middle"
          fontSize={12}
          fontWeight="800"
          fill={tokens.ink}
        >
          All
        </SvgText>
      </Svg>
      {/* The touch targets: 44 dp squares on the petals' label ring, a 52 dp hub. */}
      {ASPECT_SECTORS.map((name, k) => {
        const am = (k * Math.PI) / 4;
        const on = aspectSelected(mask, k);
        return (
          <Pressable
            key={name}
            testID={`aspect-${name}`}
            onPress={() => onChange(toggleAspect(mask, k))}
            accessibilityRole="togglebutton"
            accessibilityLabel={name}
            accessibilityState={{ checked: on }}
            style={[
              styles.petalHit,
              {
                left: (C + LABEL_R * Math.sin(am)) * f - petal,
                top: (C - LABEL_R * Math.cos(am)) * f - petal,
              },
            ]}
          />
        );
      })}
      <Pressable
        testID="aspect-all"
        onPress={() => onChange(toggleAllAspects(mask))}
        accessibilityRole="togglebutton"
        accessibilityLabel="All aspects"
        accessibilityState={{ checked: all }}
        style={[styles.hubHit, { left: C * f - hub, top: C * f - hub }]}
      />
    </View>
  );
}

/** The legend chip's 20 px rose: the selected sectors in the bands' red. */
export function MiniRose({ mask }: { mask: number }) {
  const { sz } = useDisplayScale();

  const tokens = useSchemeTokens();
  return (
    <Svg
      viewBox="0 0 20 20"
      width={sz(20)}
      height={sz(20)}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {ASPECT_SECTORS.map((name, k) => (
        <Path
          key={name}
          d={wedge(10, 3, 9.5, ((k - 0.5) * Math.PI) / 4 + 0.05, ((k + 0.5) * Math.PI) / 4 - 0.05)}
          fill={aspectSelected(mask, k) ? LEGEND_PETAL : tokens.surfaceVariant}
        />
      ))}
    </Svg>
  );
}

/**
 * Map layers › Terrain › Slope (mockup B2): the steepness bands and window,
 * the altitude range (0 to the computed area's highest ground rounded up to
 * 500 m; its top end is "and above"; "+" extends it by 500 m), the aspect
 * rose, and Reset. Every change applies live and is persisted.
 */
export function SlopeSubPanel({ onBack }: { onBack: () => void }) {
  const styles = useScaledStyles(stylesSheet);

  const tokens = useSchemeTokens();
  const { accent } = useSheetAccent();
  const sheetW = useSheetWidth();
  const { minDeg, maxDeg, filter, units } = useSlopeSettings();
  const set = useSettingsStore((s) => s.set);
  const range = useTerrainAreaStore((s) => s.elevationRange);
  // "+" taps this visit: the scale grows by a chunk each (not persisted).
  const [extra, setExtra] = useState(0);
  const alt = altitudeSlider(filter, range, units, extra);
  const [scaleLo, scaleHi] = altitudeScaleLabels(alt.max, units);
  const updateFilter = (patch: Partial<typeof filter>) =>
    set('terrainSlopeFilter', { ...useSettingsStore.getState().terrainSlopeFilter, ...patch });

  return (
    <>
      <SubPanelHeader
        title="Slope"
        backLabel="Back to overlays"
        onBack={onBack}
        right={<SlopeReset onReset={() => setExtra(0)} />}
      />
      <SectionTitle>Steepness</SectionTitle>
      <BandStrip />
      <View style={styles.sliderRow}>
        <RangeSlider
          min={0}
          max={90}
          width={sheetW - 2 * SIDE_PAD - STEEP_VALUE_W}
          lo={minDeg}
          hi={maxDeg}
          accessibilityLabel="Slope"
          formatValue={steepnessLabel}
          onChange={(lo, hi) => {
            set('terrainSlopeMinDeg', lo);
            set('terrainSlopeMaxDeg', hi);
          }}
          accentColor={accent}
          trackColor={tokens.surfaceVariant}
        />
      </View>
      <SectionTitle>Altitude</SectionTitle>
      <View style={styles.sliderRow}>
        <RangeSlider
          // A new scale re-reads the thumbs from the store.
          key={alt.max}
          min={alt.min}
          max={alt.max}
          lo={alt.lo}
          hi={alt.hi}
          step={alt.step}
          unit={` ${units.elevation}`}
          width={sheetW - 2 * SIDE_PAD - ALT_SIDE_W}
          accessibilityLabel="Altitude"
          testID="altitude"
          formatValue={(lo, hi) => altitudeSliderValue(lo, hi, alt.max, units)}
          onChange={(lo, hi) => updateFilter(altitudeFromSlider(lo, hi, alt, units))}
          accentColor={accent}
          trackColor={tokens.surfaceVariant}
        />
        <Pressable
          testID="altitude-extend"
          onPress={() => setExtra((n) => n + 1)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Extend altitude range"
          style={[styles.plus, { backgroundColor: tokens.surfaceVariant }]}
        >
          <Text style={[styles.plusText, { color: tokens.ink }]}>+</Text>
        </Pressable>
      </View>
      <View style={[styles.scaleLabels, { width: sheetW - 2 * SIDE_PAD - ALT_SIDE_W }]}>
        <Text style={[styles.scaleLabel, { color: tokens.inkMuted }]}>{scaleLo}</Text>
        <Text style={[styles.scaleLabel, { color: tokens.inkMuted }]}>{scaleHi}</Text>
      </View>
      <SectionTitle>Aspect</SectionTitle>
      <AspectRose
        mask={filter.aspectMask}
        onChange={(aspectMask) => updateFilter({ aspectMask })}
      />
      <Text style={[styles.selection, { color: tokens.inkMuted }]} testID="aspect-selection">
        {aspectSelectionLabel(filter.aspectMask)}
      </Text>
    </>
  );
}

/**
 * On the map while slope is on and filtered (mockup B3/B4 option 2): a mini
 * rose with the selected aspects, the steepness and the altitude, above the
 * scale bar. A tap opens the Slope sub-panel. Renders nothing otherwise.
 */
export function SlopeLegendChip({ onPress }: { onPress: () => void }) {
  const styles = useScaledStyles(stylesSheet);

  const tokens = useSchemeTokens();
  const outline = useChromeOutline();
  const { slope, minDeg, maxDeg, filter, units } = useSlopeSettings();
  if (!showSlopeLegend(slope, filter)) return null;
  const { title, detail } = slopeLegendText(minDeg, maxDeg, filter, units);
  return (
    <Pressable
      testID="slope-legend"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Slope filter: ${title}, ${detail}`}
      style={[styles.legend, { backgroundColor: tokens.map.chip }, outline]}
    >
      <MiniRose mask={filter.aspectMask} />
      <Text style={[styles.legendTitle, { color: tokens.map.chipInk }]} numberOfLines={1}>
        {title}
      </Text>
      <Text style={[styles.legendDetail, { color: tokens.map.chipInkMuted }]} numberOfLines={1}>
        {detail}
      </Text>
    </Pressable>
  );
}

const stylesSheet = StyleSheet.create({
  reset: { fontSize: 15, fontWeight: '700' },
  bands: {
    flexDirection: 'row',
    height: 8,
    borderRadius: 6,
    overflow: 'hidden',
    marginHorizontal: SIDE_PAD,
    marginTop: 4,
  },
  bandLabels: { flexDirection: 'row', marginHorizontal: SIDE_PAD, marginTop: 3 },
  bandLabel: { fontSize: 10.5, lineHeight: 14, fontVariant: ['tabular-nums'] },
  sliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SIDE_PAD,
    paddingTop: 4,
  },
  plus: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusText: { fontSize: 17, lineHeight: 20, fontWeight: '800' },
  scaleLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginLeft: SIDE_PAD,
  },
  scaleLabel: { fontSize: 10.5, lineHeight: 14, fontVariant: ['tabular-nums'] },
  roseBox: { width: ROSE, height: ROSE, alignSelf: 'center', marginTop: 2 },
  petalHit: { position: 'absolute', width: 44, height: 44, borderRadius: 22 },
  hubHit: { position: 'absolute', width: 52, height: 52, borderRadius: 26 },
  selection: {
    textAlign: 'center',
    fontSize: 12.5,
    lineHeight: 17,
    fontVariant: ['tabular-nums'],
    paddingTop: 2,
    paddingBottom: 6,
  },
  legend: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 7,
    paddingLeft: 6,
    paddingRight: 11,
    paddingVertical: 5,
    borderRadius: 14,
    maxWidth: '100%',
    shadowColor: palette.shadow,
    shadowOpacity: 0.22,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  legendTitle: { fontSize: 12, lineHeight: 16, fontWeight: '700', flexShrink: 1 },
  legendDetail: { fontSize: 11.5, lineHeight: 16, fontWeight: '500', flexShrink: 1 },
});

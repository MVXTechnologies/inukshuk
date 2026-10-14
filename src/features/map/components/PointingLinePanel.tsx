import { previewTickStep, tickLabel } from '@core/geo/pointingLine';
import { waypointInk } from '@core/library/waypointStyle';
import {
  POINTING_LINE_COLORS,
  POINTING_LINE_DIRECTIONS,
  POINTING_LINE_LENGTHS,
  POINTING_LINE_TICKS,
  POINTING_LINE_WIDTHS,
  POINTING_LINE_WIDTH_DP,
  POINTING_LINE_WIDTH_LABEL,
  formatFixedBearing,
  parseBearing,
  pointingLineCaption,
  pointingLineGroundNote,
  pointingLineLengthLabels,
  pointingLineLengthM,
  pointingLineCasing,
  pointingLineSummary,
  pointingLineTicksLabel,
  type PointingLineDirection,
  type PointingLineSettings,
} from '@core/map/pointingLineSettings';
import { useSettingsStore } from '@state/settingsStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import Svg, { Circle, Line, Text as SvgText } from 'react-native-svg';
import {
  ControlRow,
  SectionTitle,
  Segmented,
  SheetNote,
  SubPanelButton,
  SubPanelHeader,
  SwitchRow,
  useSheetAccent,
  useSheetWidth,
} from './mapSheet';
import { StepSlider } from './StepSlider';

/** The `below` indent of a sheet row (see mapSheet), left + right. */
const BELOW_INSET = 52 + 16;
/** The slider's value label + its gap, beside the track. */
const VALUE_W = 74;
const PREVIEW_H = 56;
/** 30 dp swatches, 40 dp targets with their slop (nine must fit a phone-wide row). */
const SWATCH = 30;

const STARTS_AT = [{ value: 'you' as const, label: 'You' }];
const WIDTHS = POINTING_LINE_WIDTHS.map((w) => ({ value: w, label: POINTING_LINE_WIDTH_LABEL[w] }));

/** The pointing line's settings and a setter that merges a change into them. */
function usePointingLine(): [PointingLineSettings, (patch: Partial<PointingLineSettings>) => void] {
  const cfg = useSettingsStore((s) => s.pointingLine);
  const set = useSettingsStore((s) => s.set);
  return [
    cfg,
    (patch) => set('pointingLine', { ...useSettingsStore.getState().pointingLine, ...patch }),
  ];
}

/**
 * Map layers › Map: the "Pointing line" switch row and its sub-panel
 * accessory (#681; the owner's sub-menu rule). Off: "Off · 500 m along your
 * heading", so the row says what turning it on will draw.
 */
export function PointingLineRow({ onOpen }: { onOpen: () => void }) {
  const [cfg, update] = usePointingLine();
  const units = useSettingsStore((s) => s.units);
  const summary = pointingLineSummary(cfg, units);
  return (
    <SwitchRow
      icon="ray-start-arrow"
      label="Pointing line"
      hint={cfg.enabled ? summary : `Off · ${summary}`}
      value={cfg.enabled}
      onToggle={() => update({ enabled: !cfg.enabled })}
      accessory={
        <SubPanelButton
          onPress={onOpen}
          accessibilityLabel="Options for pointing line"
          testID="pointing-line-options"
        />
      }
    />
  );
}

/**
 * A drawing of the line as configured (mockup §7's preview strip): you, the
 * line in its colour and width over its casing, the ticks with every 5th one
 * longer (labelled when asked), and the caption under it.
 */
function Preview({ cfg }: { cfg: PointingLineSettings }) {
  const tokens = useSchemeTokens();
  const units = useSettingsStore((s) => s.units);
  const w = useSheetWidth() - 32;
  const x0 = 22;
  const x1 = w - 18;
  const y = 24;
  const stroke = POINTING_LINE_WIDTH_DP[cfg.width];
  const casing = pointingLineCasing(cfg.color);
  // The preview's ground length: the setting, or a nominal 1 km for Edge;
  // ticks as set (Auto: five), dropped when they would fuse.
  // In the user's units: 0.5 mi is drawn as 0.5 mi of ticks.
  const lengthM = cfg.length === 'edge' ? 1000 : pointingLineLengthM(cfg.length, units);
  const step = previewTickStep(cfg.ticks, lengthM, units);
  const px = step === null ? 0 : ((x1 - x0) * step.stepM) / lengthM;
  const ticks =
    step === null || px < 4
      ? []
      : Array.from({ length: Math.floor(lengthM / step.stepM + 1e-9) }, (_, i) => i + 1);
  return (
    <View style={styles.previewWrap}>
      <View
        testID="pointing-line-preview"
        accessible
        accessibilityLabel={`Preview: ${pointingLineCaption(cfg, units)}`}
        style={[styles.preview, { backgroundColor: tokens.surfaceVariant }]}
      >
        <Svg width={w} height={PREVIEW_H}>
          <Line
            x1={x0}
            y1={y}
            x2={x1}
            y2={y}
            stroke={casing}
            strokeWidth={stroke + 2.5}
            strokeLinecap="round"
          />
          {ticks.map((i) => {
            const major = i % 5 === 0;
            const x = x0 + i * px;
            const half = major ? 7 : 4.5;
            return [
              <Line
                key={`c${i}`}
                x1={x}
                y1={y - half}
                x2={x}
                y2={y + half}
                stroke={casing}
                strokeWidth={(major ? 2 : 1.5) + 2.2}
                strokeLinecap="round"
              />,
              <Line
                key={`t${i}`}
                x1={x}
                y1={y - half}
                x2={x}
                y2={y + half}
                stroke={cfg.color}
                strokeWidth={major ? 2 : 1.5}
                strokeLinecap="round"
              />,
              major && cfg.labelEvery5th && step !== null ? (
                <SvgText
                  key={`l${i}`}
                  x={x}
                  y={y + 20}
                  fontSize={10.5}
                  fontWeight="800"
                  textAnchor="middle"
                  fill={tokens.ink}
                >
                  {tickLabel(i * step.stepM, step.unit)}
                </SvgText>
              ) : null,
            ];
          })}
          <Line
            x1={x0}
            y1={y}
            x2={x1}
            y2={y}
            stroke={cfg.color}
            strokeWidth={stroke}
            strokeLinecap="round"
          />
          <Circle
            cx={x1}
            cy={y}
            r={stroke + 1.5}
            fill={cfg.color}
            stroke={casing}
            strokeWidth={1.5}
          />
          <Circle cx={x0} cy={y} r={9} fill={tokens.map.puckRing} />
          <Circle cx={x0} cy={y} r={6} fill={tokens.map.puck} />
        </Svg>
      </View>
      <Text style={[styles.caption, { color: tokens.inkMuted }]} numberOfLines={1}>
        {pointingLineCaption(cfg, units)}
      </Text>
    </View>
  );
}

/** The fixed bearing, typed in whole degrees; committed as you type, tidied on leaving. */
function BearingInput({ value, onChange }: { value: number; onChange: (deg: number) => void }) {
  const tokens = useSchemeTokens();
  const { accent } = useSheetAccent();
  const [text, setText] = useState(() => String(value));
  return (
    <View style={styles.bearingRow}>
      <Text style={[styles.bearingLabel, { color: tokens.inkVariant }]}>Bearing</Text>
      <TextInput
        value={text}
        onChangeText={(t) => {
          const digits = t.replace(/[^0-9]/g, '').slice(0, 3);
          setText(digits);
          const deg = parseBearing(digits);
          if (deg !== null) onChange(deg);
        }}
        onBlur={() => setText(String(value))}
        keyboardType="number-pad"
        returnKeyType="done"
        maxLength={3}
        selectTextOnFocus
        accessibilityLabel="Fixed bearing in degrees"
        testID="pointing-line-bearing"
        style={[
          styles.bearingInput,
          { color: tokens.ink, borderColor: accent, backgroundColor: tokens.surfaceVariant },
        ]}
      />
      <Text style={[styles.bearingLabel, { color: tokens.inkVariant }]}>° from true north</Text>
    </View>
  );
}

/**
 * Map layers › Map › Pointing line (#681, mockup 2.6.0 §7 `cfgLine2`): the
 * switch, then where it starts (You; the centre cursor joins in 2.6.0), its
 * direction (Heading / Course / Fixed, with the bearing), its length (100 m
 * to the screen edge), nine colours, four widths, the tick marks and their
 * labels. Every option can be set while the line is off.
 */
export function PointingLinePanel({
  onBack,
  backLabel = 'Back to overlays',
}: {
  onBack: () => void;
  /** The back row's a11y/Maestro handle (the info strip editor's page says where it goes back to). */
  backLabel?: string;
}) {
  const tokens = useSchemeTokens();
  const { accent } = useSheetAccent();
  const sheetW = useSheetWidth();
  const [cfg, update] = usePointingLine();
  const units = useSettingsStore((s) => s.units);
  const tickLevels = POINTING_LINE_TICKS.map((t) => ({
    value: t,
    label: pointingLineTicksLabel(t, units),
  }));
  const directions = POINTING_LINE_DIRECTIONS.map((d: PointingLineDirection) => ({
    value: d,
    label:
      d === 'heading'
        ? 'Heading'
        : d === 'course'
          ? 'Course'
          : `Fixed ${formatFixedBearing(cfg.fixedBearingDeg)}`,
  }));
  const lengthIndex = Math.max(0, POINTING_LINE_LENGTHS.indexOf(cfg.length));

  return (
    <>
      <SubPanelHeader title="Pointing line" backLabel={backLabel} onBack={onBack} />
      <Preview cfg={cfg} />
      <SwitchRow
        icon="ray-start-arrow"
        label="Show pointing line"
        hint={cfg.enabled ? pointingLineSummary(cfg, units) : 'Hidden on the map'}
        value={cfg.enabled}
        onToggle={() => update({ enabled: !cfg.enabled })}
      />
      <SectionTitle>Starts at</SectionTitle>
      <View style={styles.pad}>
        <Segmented
          levels={STARTS_AT}
          selected={cfg.origin}
          onSelect={() => update({ origin: 'you' })}
        />
      </View>
      <SectionTitle>Direction</SectionTitle>
      <View style={styles.pad}>
        <Segmented
          levels={directions}
          selected={cfg.direction}
          onSelect={(direction) => update({ direction })}
        />
      </View>
      {cfg.direction === 'fixed' && (
        <BearingInput
          value={cfg.fixedBearingDeg}
          onChange={(fixedBearingDeg) => update({ fixedBearingDeg })}
        />
      )}
      <ControlRow icon="ruler" label="Length">
        <StepSlider
          labels={pointingLineLengthLabels(units)}
          value={lengthIndex}
          onChange={(i) => {
            const length = POINTING_LINE_LENGTHS[i];
            if (length !== undefined) update({ length });
          }}
          width={sheetW - BELOW_INSET - VALUE_W}
          accessibilityLabel="Length"
          accentColor={accent}
          trackColor={tokens.surfaceVariant}
          tickColor={tokens.inkMuted}
        />
      </ControlRow>
      <SectionTitle>Colour</SectionTitle>
      <View style={styles.swatches} accessibilityRole="radiogroup" accessibilityLabel="Line colour">
        {POINTING_LINE_COLORS.map((c) => {
          const on = c.hex === cfg.color;
          return (
            <Pressable
              key={c.hex}
              onPress={() => update({ color: c.hex })}
              accessibilityRole="radio"
              accessibilityLabel={c.name}
              accessibilityState={{ checked: on, selected: on }}
              hitSlop={5}
              style={[
                styles.swatch,
                { backgroundColor: c.hex },
                c.hex === palette.surface && { borderWidth: 1, borderColor: palette.granite },
                on && { borderWidth: 2.5, borderColor: tokens.ink },
              ]}
            >
              {on && <Icon source="check" size={16} color={waypointInk(c.hex)} />}
            </Pressable>
          );
        })}
      </View>
      <SectionTitle>Width</SectionTitle>
      <View style={styles.pad}>
        <Segmented levels={WIDTHS} selected={cfg.width} onSelect={(width) => update({ width })} />
      </View>
      <SectionTitle>Tick marks</SectionTitle>
      <View style={styles.pad}>
        <Segmented
          levels={tickLevels}
          selected={cfg.ticks}
          onSelect={(ticks) => update({ ticks })}
        />
      </View>
      <SwitchRow
        icon="tag-text-outline"
        label="Label every 5th tick"
        hint="Its distance from you"
        value={cfg.labelEvery5th}
        onToggle={() => update({ labelEvery5th: !cfg.labelEvery5th })}
      />
      <SheetNote icon="compass-outline">{pointingLineGroundNote(cfg.length, units)}</SheetNote>
    </>
  );
}

const styles = StyleSheet.create({
  previewWrap: { paddingHorizontal: 16, paddingBottom: 4 },
  preview: { height: PREVIEW_H, borderRadius: 12, overflow: 'hidden' },
  caption: { fontSize: 11.5, lineHeight: 15, marginTop: 4 },
  pad: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 6 },
  bearingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 52,
    paddingRight: 16,
    paddingBottom: 8,
  },
  bearingLabel: { fontSize: 13.5 },
  bearingInput: {
    minWidth: 64,
    minHeight: 44,
    borderWidth: 1.5,
    borderRadius: 10,
    paddingHorizontal: 10,
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  swatches: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 6,
    rowGap: 10,
  },
  swatch: {
    width: SWATCH,
    height: SWATCH,
    borderRadius: SWATCH / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

import type { GpsQuality } from '@core/geo/track/gpsQuality';
import type { TrackStats } from '@core/models';
import { gpsChip } from '@core/recording/gpsChip';
import {
  collapsePanel,
  cycleHeroField,
  DEFAULT_HERO_FIELDS,
  EXPANDED_FIELDS,
  expandPanel,
  INITIAL_PANEL_STATE,
  panelAfterSwipe,
  type HeroField,
  type PanelState,
} from '@core/recording/panel';
import { sparklinePoints } from '@core/recording/sparkline';
import { msUntilSunset } from '@core/sun/sunTimes';
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatElevationChange,
  formatPace,
  formatSpeed,
} from '@state/formatters';
import { DisplaySheet } from '@features/display/DisplaySheet';
import { ReceiverChipView } from '@features/gnss/ReceiverChipView';
import { useReceiverChip } from '@features/gnss/useReceiverChip';
import { useGnssStore } from '@state/gnssStore';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import { useDisplayCondition } from '@ui/displayCondition';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Icon, Switch, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Polyline } from 'react-native-svg';
import { HoldButton } from './HoldButton';
import { InukshukGlyph } from '@ui/components/InukshukGlyph';

interface Props {
  status: 'recording' | 'paused';
  stats: TrackStats;
  elapsedS: number;
  liveSpeedMps: number;
  gpsQuality: GpsQuality;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onMark: () => void;
  /** Glove lock: every control but the long-press unlock is off (map gestures too, in MapScreen). */
  gloveLocked: boolean;
  onGloveLockChange: (locked: boolean) => void;
  /** Height the panel occupies above the screen bottom, so map chrome can stack above it. */
  onHeightChange?: (height: number) => void;
}

const FIELD_LABEL: Record<HeroField, string> = {
  time: 'TIME',
  distance: 'DISTANCE',
  gain: 'GAIN',
  speed: 'SPEED',
  pace: 'PACE',
  altitude: 'ALTITUDE',
  descent: 'DESCENT',
  moving: 'MOVING',
  sunset: 'TO SUNSET',
};

/** Split "3.42 km" into value and unit so the unit can be set smaller (board). */
function splitUnit(text: string): { value: string; unit: string } {
  const m = /^(.*?\d[^\s]*)\s+(\D.*)$/.exec(text);
  return m ? { value: m[1]!, unit: m[2]! } : { value: text, unit: '' };
}

/**
 * The recording panel (revamp decision 3, `Recording-States.html`): A a mini
 * overlay, B the instrument strip (default), C the expanded instruments.
 * Chevrons and vertical swipes step between them; changing size never
 * touches the recording.
 *
 * Maestro contract: 'Stop recording', 'Pause', 'Resume' and 'Add waypoint'
 * keep their labels (Stop now needs a hold: flows use longPressOn).
 */
export function RecordingPanel(props: Props) {
  const {
    status,
    stats,
    elapsedS,
    liveSpeedMps,
    gpsQuality,
    onPause,
    onResume,
    onStop,
    onMark,
    gloveLocked,
    onGloveLockChange,
    onHeightChange,
  } = props;
  const theme = useTheme();
  const tokens = useSchemeTokens();
  // Sunlight (decision 4): hero values one step up, 32 → 40.
  const sunlight = useDisplayCondition() === 'sunlight';
  const chosenDisplay = useSettingsStore((s) => s.displayCondition);
  const autoNight = useSettingsStore((s) => s.autoNightAtSunset);
  const setSetting = useSettingsStore((s) => s.set);
  const [displaySheetOpen, setDisplaySheetOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const [panel, setPanel] = useState<PanelState>(INITIAL_PANEL_STATE);
  const [fields, setFields] = useState<HeroField[]>([...DEFAULT_HERO_FIELDS]);
  const [optionsOpen, setOptionsOpen] = useState(false);

  const lastAccuracyM = useRecorderStore((s) => s.lastAccuracyM);
  const lastFixAt = useRecorderStore((s) => s.lastFixAt);
  const pausedAt = useRecorderStore((s) => s.pausedAt);
  const points = useRecorderStore((s) => s.points);
  const altitudes = useMemo(
    () => points.flatMap((p) => (typeof p.altitude === 'number' ? [p.altitude] : [])),
    [points],
  );
  const lastPoint = points[points.length - 1];

  // A one-second clock for the paused duration, the GPS age and the sunset
  // countdown (all keep moving while paused, when `elapsedS` stands still).
  const now = useNow(1000);
  const paused = status === 'paused';
  const chip = gpsChip(gpsQuality, lastAccuracyM, lastFixAt, now);
  const receiverChip = useReceiverChip();
  const setReceiverSheetOpen = useGnssStore((s) => s.setSheetOpen);

  const valueOf = (field: HeroField): string => {
    switch (field) {
      case 'time':
        return formatDuration(elapsedS);
      case 'distance':
        return formatDistance(stats.distanceM);
      case 'gain':
        return formatElevationChange(stats.ascentM, 'up');
      case 'speed':
        return formatSpeed(liveSpeedMps);
      case 'pace':
        return stats.avgSpeedMps > 0 ? formatPace(stats.avgSpeedMps) : '—';
      case 'altitude':
        return typeof lastPoint?.altitude === 'number' ? formatElevation(lastPoint.altitude) : '—';
      case 'descent':
        return formatElevationChange(stats.descentM, 'down');
      case 'moving':
        return formatDuration(stats.movingTimeS);
      case 'sunset': {
        const left =
          lastPoint === undefined
            ? null
            : msUntilSunset(now, lastPoint.latitude, lastPoint.longitude);
        return left === null ? '—' : formatDuration(Math.round(left / 1000));
      }
    }
  };

  const swipe = Gesture.Pan()
    .activeOffsetY([-12, 12])
    .failOffsetX([-24, 24])
    .runOnJS(true)
    .onEnd((e) => setPanel((p) => panelAfterSwipe(p, { dy: e.translationY, vy: e.velocityY })));

  const onLayout = (e: LayoutChangeEvent) => onHeightChange?.(e.nativeEvent.layout.height);

  // --- A · mini overlay -----------------------------------------------------
  if (panel === 'mini') {
    return (
      <GestureDetector gesture={swipe}>
        <View
          style={[styles.miniWrap, { paddingBottom: insets.bottom + 16 }]}
          pointerEvents="box-none"
          onLayout={onLayout}
        >
          <Pressable
            onPress={() => setPanel(expandPanel)}
            disabled={gloveLocked}
            accessibilityRole="button"
            accessibilityLabel={`${paused ? 'Paused' : 'Recording'}, ${valueOf('time')}, ${valueOf('distance')}. Show instruments`}
            style={[styles.mini, { backgroundColor: tokens.map.chromeMini }]}
          >
            <View
              style={[
                styles.recDot,
                { backgroundColor: paused ? palette.amber : tokens.status.recordingDot },
              ]}
            />
            <Text style={[styles.miniText, { color: tokens.map.chromeInk }]}>
              {valueOf('time')} · {valueOf('distance')}
            </Text>
            <Icon source="chevron-up" size={22} color={tokens.map.chromeInk} />
          </Pressable>
        </View>
      </GestureDetector>
    );
  }

  const expanded = panel === 'expanded';
  const ink = theme.colors.onSurface;
  const muted = tokens.inkMuted;

  const field = (f: HeroField, slot: number | null) => {
    const { value, unit } = splitUnit(valueOf(f));
    const label = FIELD_LABEL[f];
    const body = (
      <>
        <Text
          style={[styles.heroValue, sunlight && styles.heroValueSunlight, { color: ink }]}
          maxFontSizeMultiplier={1.4}
        >
          {value}
          {unit !== '' && <Text style={styles.heroUnit}> {unit}</Text>}
        </Text>
        <Text style={[styles.fieldLabel, { color: muted }]} maxFontSizeMultiplier={1.4}>
          {label}
        </Text>
      </>
    );
    const a11y = `${label.charAt(0)}${label.slice(1).toLowerCase()} ${value}${unit ? ` ${unit}` : ''}`;
    if (slot === null) {
      return (
        <View key={f} style={styles.gridCell} accessible accessibilityLabel={a11y}>
          {body}
        </View>
      );
    }
    return (
      <Pressable
        key={`${slot}-${f}`}
        onPress={() => setFields((fs) => cycleHeroField(fs, slot))}
        disabled={gloveLocked}
        accessibilityRole="button"
        accessibilityLabel={`${a11y}. Tap to change field`}
        style={[
          styles.heroCell,
          slot > 0 && { borderLeftColor: tokens.divider, borderLeftWidth: 1 },
        ]}
      >
        {body}
      </Pressable>
    );
  };

  const pausedFor =
    paused && pausedAt !== null
      ? formatDuration(Math.max(0, Math.floor((now - pausedAt) / 1000)))
      : null;

  return (
    <GestureDetector gesture={swipe}>
      <View
        onLayout={onLayout}
        accessibilityLabel="Recording instruments"
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.surface,
            paddingBottom: insets.bottom + 4,
            shadowColor: palette.shadow,
          },
        ]}
      >
        {/* Status bar: stone while recording, a thicker amber bar when paused. */}
        <View
          style={{
            height: paused ? 6 : 4,
            backgroundColor: paused ? tokens.status.paused : tokens.status.recording,
          }}
        />

        {/* Status row: REC/PAUSED chip + GPS chip · minimize + options. */}
        <View style={styles.statusRow}>
          <View style={styles.chips} accessibilityRole="text">
            {paused ? (
              <View style={[styles.chip, { backgroundColor: tokens.status.paused }]}>
                <Icon source="pause" size={14} color={tokens.status.onPaused} />
                <Text style={[styles.chipCaps, { color: tokens.status.onPaused }]}>PAUSED</Text>
              </View>
            ) : (
              <View style={[styles.chip, { backgroundColor: tokens.status.recording }]}>
                <View style={[styles.recDot, { backgroundColor: tokens.status.recordingDot }]} />
                <Text style={[styles.chipCaps, { color: palette.paper }]}>REC</Text>
              </View>
            )}
            {/* #588: with an external receiver in use, its chip (state, accuracy)
              replaces the phone's; tapping it opens the receiver sheet. */}
            {receiverChip !== null ? (
              <ReceiverChipView
                chip={receiverChip}
                variant="surface"
                onPress={() => setReceiverSheetOpen(true)}
                testID="gnss-panel-chip"
              />
            ) : (
              <View
                accessibilityLabel={chip.label}
                style={[
                  styles.chip,
                  chip.kind === 'lost'
                    ? { backgroundColor: tokens.status.gpsLost }
                    : {
                        borderWidth: 1,
                        borderColor:
                          chip.kind === 'weak' ? tokens.status.gpsWeak : tokens.outlineVariant,
                      },
                ]}
              >
                <Icon
                  source={chip.kind === 'lost' ? 'crosshairs-off' : 'crosshairs-gps'}
                  size={14}
                  color={
                    chip.kind === 'lost'
                      ? tokens.status.onGpsLost
                      : chip.kind === 'weak'
                        ? tokens.status.gpsWeak
                        : ink
                  }
                />
                <Text
                  style={[
                    styles.chipText,
                    {
                      color:
                        chip.kind === 'lost'
                          ? tokens.status.onGpsLost
                          : chip.kind === 'weak'
                            ? tokens.status.gpsWeak
                            : ink,
                    },
                  ]}
                >
                  {chip.label}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.rowEnd}>
            <Pressable
              onPress={() => setPanel(collapsePanel)}
              disabled={gloveLocked}
              accessibilityRole="button"
              accessibilityLabel={expanded ? 'Show fewer fields' : 'Minimize to a small overlay'}
              style={styles.iconButton}
            >
              <Icon source="chevron-down" size={24} color={ink} />
            </Pressable>
            <Pressable
              onPress={() => setOptionsOpen((o) => !o)}
              disabled={gloveLocked}
              accessibilityRole="button"
              accessibilityLabel="Recording options"
              accessibilityState={{ expanded: optionsOpen }}
              style={styles.iconButton}
            >
              <Icon source="dots-horizontal" size={24} color={ink} />
            </Pressable>
          </View>
        </View>

        {optionsOpen && !gloveLocked && (
          <View style={[styles.options, { borderColor: tokens.outlineVariant }]}>
            {/* Display · opt-in (After-Sunlight / After-Night boards). */}
            <View style={styles.optionBlock}>
              <Text style={[styles.optionCaps, { color: muted }]}>DISPLAY · OPT-IN</Text>
              <View style={[styles.segment, { borderColor: tokens.outlineVariant }]}>
                {(
                  [
                    ['normal', 'Normal'],
                    ['sunlight', 'Sun'],
                    ['night', 'Night'],
                  ] as const
                ).map(([value, label]) => {
                  const selected = chosenDisplay === value;
                  return (
                    <Pressable
                      key={value}
                      onPress={() => setSetting('displayCondition', value)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Display ${label}`}
                      style={[
                        styles.segmentItem,
                        selected && { backgroundColor: theme.colors.secondaryContainer },
                      ]}
                    >
                      <Text
                        style={[
                          styles.segmentText,
                          { color: selected ? theme.colors.onSecondaryContainer : ink },
                        ]}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <View style={styles.optionSwitchRow}>
                <Text style={[styles.optionTitle, { color: ink, flex: 1 }]}>
                  Auto night at sunset
                </Text>
                <Switch
                  value={autoNight}
                  onValueChange={(v) => setSetting('autoNightAtSunset', v)}
                  accessibilityLabel="Auto night at sunset"
                />
              </View>
            </View>
            <Pressable
              onPress={() => {
                setOptionsOpen(false);
                onGloveLockChange(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="Glove lock"
              accessibilityHint="Locks the map and every button; press and hold to unlock"
              style={styles.optionRow}
            >
              <Icon source="hand-back-left-off-outline" size={22} color={ink} />
              <View style={styles.optionText}>
                <Text style={[styles.optionTitle, { color: ink }]}>Glove lock</Text>
                <Text style={[styles.optionCaption, { color: muted }]}>
                  Lock the map and buttons in your pocket or with gloves
                </Text>
              </View>
            </Pressable>
            <Pressable
              onPress={() => {
                setOptionsOpen(false);
                setDisplaySheetOpen(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="All display options"
              style={styles.optionRow}
            >
              <Icon source="tune-variant" size={22} color={ink} />
              <Text style={[styles.optionTitle, { color: ink, flex: 1 }]}>All display options</Text>
              <Icon source="chevron-right" size={22} color={ink} />
            </Pressable>
          </View>
        )}
        <DisplaySheet visible={displaySheetOpen} onDismiss={() => setDisplaySheetOpen(false)} />

        {/* Three hero fields; tap one to cycle it. */}
        <View style={styles.heroRow}>{fields.map((f, i) => field(f, i))}</View>

        {/* C · expanded: six more fields and the elevation so far. */}
        {expanded && (
          <>
            <View style={styles.grid}>
              {EXPANDED_FIELDS.filter((f) => !fields.includes(f)).map((f) => field(f, null))}
            </View>
            <ElevationSoFar
              altitudes={altitudes}
              ink={ink}
              muted={muted}
              line={theme.colors.primary}
            />
          </>
        )}

        {/* Controls, or the glove-lock bar. */}
        {gloveLocked ? (
          <View style={styles.controls}>
            <HoldButton
              size={56}
              onConfirm={() => onGloveLockChange(false)}
              accessibilityLabel="Unlock controls"
              accessibilityHint="Press and hold to unlock"
              trackColor={tokens.outlineVariant}
              fillColor={theme.colors.primary}
              background={theme.colors.elevation.level3}
            >
              <Icon source="lock-open-variant-outline" size={24} color={ink} />
            </HoldButton>
            <Text style={[styles.lockText, { color: ink }]}>Glove lock on · hold to unlock</Text>
          </View>
        ) : (
          <View style={styles.controls}>
            <Pressable
              onPress={paused ? onResume : onPause}
              accessibilityRole="button"
              accessibilityLabel={paused ? 'Resume' : 'Pause'}
              style={[
                styles.primary,
                { backgroundColor: theme.colors.primary },
                paused && { borderWidth: 3, borderColor: palette.paper },
              ]}
            >
              <Icon source={paused ? 'play' : 'pause'} size={22} color={theme.colors.onPrimary} />
              <Text style={[styles.buttonText, { color: theme.colors.onPrimary }]}>
                {paused ? 'Resume' : 'Pause'}
              </Text>
            </Pressable>
            <Pressable
              onPress={onMark}
              disabled={paused}
              accessibilityRole="button"
              accessibilityLabel="Add waypoint"
              accessibilityState={{ disabled: paused }}
              style={[
                styles.mark,
                {
                  backgroundColor: theme.colors.elevation.level3,
                  borderColor: tokens.outlineVariant,
                },
                paused && styles.disabled,
              ]}
            >
              <InukshukGlyph size={22} frame="square" tone="mono" color={ink} />
              <Text style={[styles.buttonText, { color: ink }]}>Mark</Text>
            </Pressable>
            <HoldButton
              size={56}
              onConfirm={onStop}
              accessibilityLabel="Stop recording"
              accessibilityHint="Press and hold to stop"
              trackColor={tokens.outlineVariant}
              fillColor={tokens.status.gpsLost}
              background={theme.colors.elevation.level3}
            >
              <View style={[styles.stopSquare, { backgroundColor: palette.signalRed }]} />
            </HoldButton>
          </View>
        )}

        {/* Footer: paused time · More/Less · hold hint. */}
        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: muted }]}>
            {pausedFor !== null ? `Paused ${pausedFor}` : ''}
          </Text>
          <Pressable
            onPress={() => setPanel(expanded ? collapsePanel : expandPanel)}
            disabled={gloveLocked}
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Show fewer fields' : 'Show more fields'}
            style={styles.more}
          >
            <Icon source={expanded ? 'chevron-down' : 'chevron-up'} size={18} color={muted} />
            <Text style={[styles.moreText, { color: muted }]}>{expanded ? 'Less' : 'More'}</Text>
          </Pressable>
          <Text style={[styles.footerText, styles.footerEnd, { color: muted }]}>
            {gloveLocked ? '' : 'Hold to stop'}
          </Text>
        </View>
      </View>
    </GestureDetector>
  );
}

/** Wall-clock time, refreshed every `intervalMs`. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** "Elevation so far": the altitude sparkline with start → now. */
function ElevationSoFar({
  altitudes,
  ink,
  muted,
  line,
}: {
  altitudes: number[];
  ink: string;
  muted: string;
  line: string;
}) {
  const [width, setWidth] = useState(0);
  const first = altitudes[0];
  const last = altitudes[altitudes.length - 1];
  const points = width > 0 ? sparklinePoints(altitudes, width, 40) : '';
  return (
    <View style={styles.elevation}>
      <View style={styles.elevationHead}>
        <Text style={[styles.fieldLabel, { color: muted }]}>ELEVATION SO FAR</Text>
        {first !== undefined && last !== undefined && (
          <Text style={[styles.elevationRange, { color: ink }]}>
            {Math.round(first)} → {formatElevation(last)}
          </Text>
        )}
      </View>
      <View
        style={styles.sparkBox}
        onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {points !== '' && (
          <Svg width={width} height={40}>
            <Polyline points={points} fill="none" stroke={line} strokeWidth={2} />
          </Svg>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
    shadowOpacity: 0.22,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: -8 },
    elevation: 12,
  },
  statusRow: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 16,
    paddingRight: 4,
    paddingTop: 4,
  },
  chips: { flexDirection: 'row', gap: 8, alignItems: 'center', flexShrink: 1 },
  chip: {
    height: 28,
    paddingHorizontal: 11,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  chipCaps: { fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  chipText: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  recDot: { width: 9, height: 9, borderRadius: 5 },
  rowEnd: { flexDirection: 'row' },
  iconButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  options: { marginHorizontal: 16, marginBottom: 8, borderWidth: 1, borderRadius: 16 },
  optionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, minHeight: 56 },
  optionText: { flex: 1 },
  optionTitle: { fontSize: 16, fontWeight: '700' },
  optionCaption: { fontSize: 12 },
  heroRow: { flexDirection: 'row', paddingHorizontal: 8 },
  heroCell: { flex: 1, alignItems: 'center', paddingTop: 4, paddingBottom: 6, gap: 2 },
  heroValueSunlight: { fontSize: 40, lineHeight: 46 },
  optionBlock: { padding: 12, gap: 10 },
  optionCaps: { fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  segment: { flexDirection: 'row', borderWidth: 1, borderRadius: 24, overflow: 'hidden' },
  segmentItem: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  segmentText: { fontSize: 15, fontWeight: '700' },
  optionSwitchRow: { flexDirection: 'row', alignItems: 'center', minHeight: 48 },
  heroValue: {
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.3,
  },
  heroUnit: { fontSize: 18, fontWeight: '700' },
  fieldLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 8, paddingTop: 8 },
  gridCell: { width: '33.33%', alignItems: 'center', paddingVertical: 6, gap: 2 },
  elevation: { paddingHorizontal: 16, paddingTop: 8 },
  elevationHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  elevationRange: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  sparkBox: { height: 40, marginTop: 4 },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  primary: {
    flexGrow: 1,
    height: 56,
    borderRadius: 28,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  mark: {
    width: 116,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  disabled: { opacity: 0.5 },
  buttonText: { fontSize: 17, fontWeight: '700' },
  stopSquare: { width: 18, height: 18, borderRadius: 4 },
  lockText: { flex: 1, fontSize: 16, fontWeight: '700' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 2,
  },
  footerText: { flex: 1, fontSize: 12, fontWeight: '700' },
  footerEnd: { textAlign: 'right' },
  more: { height: 44, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 6 },
  moreText: { fontSize: 13, fontWeight: '700' },
  miniWrap: { alignItems: 'center' },
  mini: {
    height: 52,
    borderRadius: 26,
    paddingLeft: 18,
    paddingRight: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    shadowColor: palette.shadow,
    shadowOpacity: 0.28,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  miniText: { fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
});

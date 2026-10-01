import type { LegMode } from '@core/draw/legs';
import { palette, target } from '@ui/tokens';
import { useChromeOutline } from '@ui/useChromeOutline';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';

/**
 * Chrome of the drawing tools (#502/#503, boards `Route.dc.html` and
 * `Area.dc.html`): the route-mode chips and the hint pill at the top, and the
 * bottom panel with the live stats and Undo · Clear · Save.
 *
 * Plain themed Views — no Portal, no Paper Surface (the absolutely-positioned
 * iOS flex collapse, and the invisible-overlay touch-swallow) — in the app's
 * Stone & Paper tokens, so they follow light, dark and the display modes.
 */

export type RouteMode = LegMode;

const MODES: readonly { id: RouteMode; label: string; hint: string }[] = [
  { id: 'trails', label: 'Trails', hint: 'new legs follow hiking trails' },
  { id: 'roads', label: 'Roads', hint: 'new legs follow roads and streets' },
  { id: 'freehand', label: 'Freehand', hint: 'new legs are straight lines' },
];

/**
 * Trails · Roads · Freehand (#515): the mode the NEXT leg is drawn in. Legs
 * already drawn keep theirs, so one route can mix a road approach, a trail
 * and a straight off-trail bit.
 *
 * A compact segmented pill in the top bar, in the search pill's slot (the
 * search pill is hidden while drawing) and in its style: the map-chrome
 * stone with its ink, the chosen segment inverted, so it reads on light and
 * dark maps alike, with the sunlight outline.
 */
export function RouteModeChips({
  mode,
  top,
  onChange,
}: {
  mode: RouteMode;
  top: number;
  onChange: (mode: RouteMode) => void;
}) {
  const t = useSchemeTokens();
  const outline = useChromeOutline();
  return (
    <View
      style={[styles.modes, { top, backgroundColor: t.map.chrome }, outline]}
      accessibilityRole="radiogroup"
      accessibilityLabel="Route mode"
      testID="route-mode-picker"
    >
      {MODES.map((m) => {
        const on = m.id === mode;
        return (
          <Pressable
            key={m.id}
            onPress={() => onChange(m.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={m.label}
            accessibilityHint={m.hint}
            style={[styles.mode, on && { backgroundColor: t.map.chromeInk }]}
          >
            <Text
              numberOfLines={1}
              style={[styles.modeLabel, { color: on ? t.map.chrome : t.map.chromeInk }]}
            >
              {m.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The one-line instruction under the chips (or alone, for an area), and an
 * optional tip under it ("Tap the start to close the loop").
 */
export function DrawHint({ text, top, tip }: { text: string; top: number; tip?: string }) {
  const t = useSchemeTokens();
  const theme = useTheme();
  return (
    <View style={[styles.hintWrap, { top }]} pointerEvents="none">
      <Text
        style={[styles.hint, { backgroundColor: t.surface, color: t.inkVariant }]}
        accessibilityLiveRegion="polite"
      >
        {text}
      </Text>
      {tip !== undefined && (
        <View
          style={[styles.tip, { backgroundColor: theme.colors.secondaryContainer }]}
          testID="loop-tip"
        >
          <Icon source="autorenew" size={15} color={theme.colors.onSecondaryContainer} />
          <Text
            style={[styles.tipText, { color: theme.colors.onSecondaryContainer }]}
            accessibilityLiveRegion="polite"
          >
            {tip}
          </Text>
        </View>
      )}
    </View>
  );
}

export interface DrawStat {
  value: string;
  label: string;
  /** Spoken in full ("Climb 610 metres, computing"). */
  accessibilityLabel?: string;
}

interface PanelProps {
  title: string;
  stats: readonly DrawStat[];
  /** Under the stats: the route's elevation profile. */
  chart?: ReactNode;
  /** Below the stats: a warning or the selected point's delete row. */
  notice?: ReactNode;
  /** Beside Undo/Clear: a route's Return chip. */
  toggle?: ReactNode;
  /**
   * Drawn over the panel last (a menu anchored above the buttons row): gets
   * the distance from the panel's bottom edge to the top of that row.
   */
  overlay?: (buttonsBottom: number) => ReactNode;
  /** Under the buttons: the routing credit while snapped legs are shown. */
  footer?: ReactNode;
  canUndo: boolean;
  canClear: boolean;
  canSave: boolean;
  saveLabel: string;
  onUndo: () => void;
  onClear: () => void;
  onSave: () => void;
  onExit: () => void;
  onLayout?: (e: LayoutChangeEvent) => void;
}

/** The bottom panel shared by the route and area tools. */
export function DrawPanel({
  title,
  stats,
  chart,
  notice,
  toggle,
  overlay,
  footer,
  canUndo,
  canClear,
  canSave,
  saveLabel,
  onUndo,
  onClear,
  onSave,
  onExit,
  onLayout,
}: PanelProps) {
  const t = useSchemeTokens();
  const theme = useTheme();
  const [panelH, setPanelH] = useState(0);
  const [buttonsY, setButtonsY] = useState(0);
  return (
    <View
      style={[styles.panel, { backgroundColor: t.surface, shadowColor: palette.shadow }]}
      onLayout={(e) => {
        setPanelH(e.nativeEvent.layout.height);
        onLayout?.(e);
      }}
      testID="draw-panel"
    >
      <View style={styles.titleRow}>
        <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
          {title}
        </Text>
        <Pressable
          onPress={onExit}
          accessibilityRole="button"
          accessibilityLabel="Exit drawing"
          hitSlop={8}
          style={styles.exit}
        >
          <Icon source="close" size={22} color={t.inkMuted} />
        </Pressable>
      </View>
      <View style={styles.stats}>
        {stats.map((s) => (
          <View
            key={s.label}
            style={styles.stat}
            accessible
            accessibilityLabel={s.accessibilityLabel ?? `${s.label} ${s.value}`}
          >
            <Text style={[styles.statValue, { color: t.ink }]} numberOfLines={1}>
              {s.value}
            </Text>
            <Text style={[styles.statLabel, { color: t.inkMuted }]}>{s.label}</Text>
          </View>
        ))}
      </View>
      {chart}
      {notice}
      <View style={styles.actions} onLayout={(e) => setButtonsY(e.nativeEvent.layout.y)}>
        <Pressable
          onPress={onUndo}
          disabled={!canUndo}
          accessibilityRole="button"
          accessibilityLabel="Undo"
          accessibilityState={{ disabled: !canUndo }}
          style={[styles.round, { borderColor: t.outlineVariant }, !canUndo && styles.disabled]}
        >
          <Icon source="undo" size={22} color={t.ink} />
        </Pressable>
        <Pressable
          onPress={onClear}
          disabled={!canClear}
          accessibilityRole="button"
          accessibilityLabel="Clear"
          accessibilityState={{ disabled: !canClear }}
          style={[styles.round, { borderColor: t.outlineVariant }, !canClear && styles.disabled]}
        >
          <Icon source="eraser" size={22} color={t.ink} />
        </Pressable>
        {toggle}
        <Pressable
          onPress={onSave}
          disabled={!canSave}
          accessibilityRole="button"
          accessibilityLabel={saveLabel}
          accessibilityState={{ disabled: !canSave }}
          style={[
            styles.save,
            { backgroundColor: theme.colors.primary },
            !canSave && styles.disabled,
          ]}
        >
          <Text style={[styles.saveLabel, { color: theme.colors.onPrimary }]}>{saveLabel}</Text>
        </Pressable>
      </View>
      {footer}
      {overlay?.(Math.max(0, panelH - buttonsY) + 6)}
    </View>
  );
}

export type RouteFinish = 'oneway' | 'backforth' | 'loop';

const FINISHES: readonly { id: RouteFinish; icon: string; label: string; spoken: string }[] = [
  { id: 'oneway', icon: 'arrow-right', label: 'One way', spoken: 'One way' },
  { id: 'backforth', icon: 'arrow-u-left-top', label: 'Back & forth', spoken: 'Back and forth' },
  { id: 'loop', icon: 'autorenew', label: 'Loop', spoken: 'Loop' },
];

const finishOf = (id: RouteFinish) => FINISHES.find((f) => f.id === id) ?? FINISHES[0]!;

/**
 * "Return" (#515): how the route ends — one way, back & forth along the same
 * line, or a loop closed back to the start. One compact chip beside
 * Undo/Clear showing the current option; it opens {@link ReturnMenu}.
 * Disabled until there is a line (two points).
 */
export function ReturnChip({
  finish,
  disabled,
  open,
  onPress,
}: {
  finish: RouteFinish;
  disabled: boolean;
  open: boolean;
  onPress: () => void;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  const f = finishOf(finish);
  // Anything but One way is a choice made: the sage selected pill (like the
  // active tab), never the dark Save button's fill right next to it.
  const on = finish !== 'oneway';
  const ink = on ? theme.colors.onSecondaryContainer : t.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Return, ${f.spoken}`}
      accessibilityHint="Choose one way, back and forth, or a loop"
      accessibilityState={{ expanded: open, disabled }}
      style={[
        styles.toggle,
        { borderColor: on ? theme.colors.secondaryContainer : t.outlineVariant },
        on && { backgroundColor: theme.colors.secondaryContainer },
        disabled && styles.disabled,
      ]}
      testID="return-chip"
    >
      <Icon source={f.icon} size={20} color={ink} />
      <Text numberOfLines={1} style={[styles.toggleLabel, { color: ink }]}>
        {f.label}
      </Text>
      <Icon source={open ? 'chevron-down' : 'chevron-up'} size={16} color={ink} />
    </Pressable>
  );
}

/**
 * The Return options, one line each, anchored above the chip inside the
 * panel. A plain themed View (no Paper Menu/Portal: an invisible overlay
 * swallows touches on One UI). The caller closes it on any tap outside.
 */
export function ReturnMenu({
  finish,
  loopHint,
  bottom,
  onPick,
}: {
  finish: RouteFinish;
  /** Why Loop is not available yet; null = it is. */
  loopHint: string | null;
  /** Distance from the panel's bottom edge to the top of the buttons row. */
  bottom: number;
  onPick: (finish: RouteFinish) => void;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  return (
    <View
      style={[styles.menu, { bottom, backgroundColor: t.surface, borderColor: t.outlineVariant }]}
      accessibilityRole="menu"
      testID="return-menu"
    >
      {FINISHES.map((f) => {
        const selected = f.id === finish;
        const disabled = f.id === 'loop' && loopHint !== null;
        return (
          <Pressable
            key={f.id}
            onPress={() => onPick(f.id)}
            disabled={disabled}
            accessibilityRole="menuitem"
            accessibilityLabel={f.spoken}
            accessibilityHint={disabled ? (loopHint ?? undefined) : undefined}
            accessibilityState={{ selected, disabled }}
            style={({ pressed }) => [
              styles.menuRow,
              (selected || pressed) && { backgroundColor: theme.colors.secondaryContainer },
              disabled && styles.disabled,
            ]}
          >
            <Icon
              source={f.icon}
              size={20}
              color={selected ? theme.colors.onSecondaryContainer : t.ink}
            />
            <View style={styles.menuText}>
              <Text
                style={[
                  styles.menuLabel,
                  { color: selected ? theme.colors.onSecondaryContainer : t.ink },
                ]}
              >
                {f.label}
              </Text>
              {disabled && loopHint !== null && (
                <Text style={[styles.menuHint, { color: t.inkMuted }]} numberOfLines={1}>
                  {loopHint}
                </Text>
              )}
            </View>
            {selected && (
              <Icon source="check" size={18} color={theme.colors.onSecondaryContainer} />
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/** "Point 3 selected · Delete point" — the tap-to-delete affordance for a vertex. */
export function SelectedPointRow({
  label,
  onDelete,
  onDeselect,
}: {
  label: string;
  onDelete: () => void;
  onDeselect: () => void;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  return (
    <View style={[styles.selectedRow, { borderColor: t.outlineVariant }]}>
      <Text style={[styles.selectedText, { color: t.ink }]} numberOfLines={1}>
        {label}
      </Text>
      <Pressable
        onPress={onDeselect}
        accessibilityRole="button"
        accessibilityLabel="Keep point"
        style={styles.chipButton}
      >
        <Text style={[styles.chipButtonLabel, { color: t.inkVariant }]}>Keep</Text>
      </Pressable>
      <Pressable
        onPress={onDelete}
        accessibilityRole="button"
        accessibilityLabel="Delete point"
        style={[styles.chipButton, { backgroundColor: theme.colors.errorContainer }]}
      >
        <Icon source="trash-can-outline" size={16} color={theme.colors.onErrorContainer} />
        <Text style={[styles.chipButtonLabel, { color: theme.colors.onErrorContainer }]}>
          Delete point
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * An amber note under the stats (a crossing polygon, an unavailable climb, a
 * leg that could not snap), with an optional action ("Retry").
 */
export function DrawNotice({
  text,
  action,
}: {
  text: string;
  action?: { label: string; onPress: () => void };
}) {
  const t = useSchemeTokens();
  return (
    <View style={styles.notice} accessibilityLiveRegion="polite">
      <Icon source="alert-outline" size={16} color={t.status.pausedInk} />
      <Text style={[styles.noticeText, { color: t.status.pausedInk }]}>{text}</Text>
      {action && (
        <Pressable
          onPress={action.onPress}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          hitSlop={6}
          style={[styles.chipButton, { borderColor: t.outlineVariant }, styles.outlined]}
        >
          <Icon source="refresh" size={16} color={t.ink} />
          <Text style={[styles.chipButtonLabel, { color: t.ink }]}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

/** A quiet status line under the stats ("Snapping to trails…"). */
export function DrawStatus({ text }: { text: string }) {
  const t = useSchemeTokens();
  return (
    <View style={styles.notice} accessibilityLiveRegion="polite">
      <Icon source="map-marker-path" size={16} color={t.inkMuted} />
      <Text style={[styles.noticeText, { color: t.inkMuted }]}>{text}</Text>
    </View>
  );
}

/**
 * The routing credit the engines' terms ask for (OSM data + the engine), with
 * the "report a map error" link FOSSGIS asks apps to carry.
 */
export function RoutingCredit({ engines }: { engines: readonly string[] }) {
  const t = useSchemeTokens();
  return (
    <View style={styles.credit}>
      <Text style={[styles.creditText, styles.creditBody, { color: t.inkMuted }]} numberOfLines={2}>
        {engines.length > 0 ? `Routing ${engines.join(' + ')} · ` : 'Routing · '}© OpenStreetMap
        contributors
      </Text>
      <Pressable
        onPress={() => void Linking.openURL('https://www.openstreetmap.org/fixthemap')}
        accessibilityRole="link"
        accessibilityLabel="Report a map error"
        hitSlop={8}
      >
        <Text style={[styles.creditText, styles.creditLink, { color: t.inkVariant }]}>
          Report a map error
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // Below the compass, clear of the controls rail on the right (16 + 48 + 12).
  // The search pill's slot: between the compass (16 + 48) and the rail, 12 dp
  // either side, the pill's height and shadow.
  modes: {
    position: 'absolute',
    left: 76,
    right: 76,
    height: target.min,
    padding: 4,
    borderRadius: target.min / 2,
    flexDirection: 'row',
    gap: 2,
    elevation: 4,
    shadowColor: palette.shadow,
    shadowOpacity: 0.28,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  mode: {
    flex: 1,
    borderRadius: (target.min - 8) / 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  modeLabel: { fontSize: 14, lineHeight: 18, fontWeight: '800' },
  hintWrap: { position: 'absolute', left: 16, right: 76, alignItems: 'flex-start' },
  hint: {
    fontSize: 13,
    lineHeight: 17,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    overflow: 'hidden',
  },
  panel: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 14,
    gap: 10,
    elevation: 8,
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: -2 },
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', minHeight: 36 },
  title: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '800' },
  exit: { width: 40, height: 36, alignItems: 'flex-end', justifyContent: 'center' },
  stats: { flexDirection: 'row', gap: 8 },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { fontSize: 20, lineHeight: 26, fontWeight: '800' },
  statLabel: { fontSize: 12, lineHeight: 16 },
  actions: { flexDirection: 'row', gap: 8 },
  round: {
    width: 52,
    minHeight: 48,
    borderRadius: 24,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  save: {
    flex: 1,
    minHeight: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveLabel: { fontSize: 16, lineHeight: 20, fontWeight: '800' },
  toggle: {
    minHeight: 48,
    borderRadius: 24,
    borderWidth: 1.5,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  toggleLabel: { fontSize: 13, lineHeight: 16, fontWeight: '800' },
  menu: {
    position: 'absolute',
    left: 138,
    minWidth: 220,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 6,
    gap: 2,
    elevation: 10,
    shadowColor: palette.shadow,
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
  },
  menuText: { flex: 1 },
  menuLabel: { fontSize: 15, lineHeight: 19, fontWeight: '700' },
  menuHint: { fontSize: 12, lineHeight: 15 },
  tip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
  },
  tipText: { fontSize: 13, lineHeight: 17, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  selectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  selectedText: { flex: 1, fontSize: 14, lineHeight: 18, fontWeight: '700' },
  chipButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
  },
  chipButtonLabel: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  outlined: { borderWidth: 1.5, minHeight: 32 },
  credit: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: -2 },
  creditText: { fontSize: 11, lineHeight: 14 },
  creditBody: { flex: 1 },
  creditLink: { textDecorationLine: 'underline', fontWeight: '700' },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 17 },
});

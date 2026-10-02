import type { LegMode } from '@core/draw/legs';
import { bottomRowLayout } from '@core/draw/panelLayout';
import { palette, target } from '@ui/tokens';
import { useChromeOutline } from '@ui/useChromeOutline';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
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
              adjustsFontSizeToFit
              minimumFontScale={0.75}
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
 * A small transient tip under the chips (2.1.1): the first tap's
 * instruction, or "Tap the start to close the loop" near the start. The
 * standing instruction banner is gone; the full help is behind the panel
 * title's (?).
 */
export function DrawTip({
  text,
  top,
  icon,
  testID,
}: {
  text: string;
  top: number;
  icon: string;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.hintWrap, { top }]} pointerEvents="none">
      <View
        style={[styles.tip, { backgroundColor: theme.colors.secondaryContainer }]}
        testID={testID}
      >
        <Icon source={icon} size={15} color={theme.colors.onSecondaryContainer} />
        <Text
          style={[styles.tipText, { color: theme.colors.onSecondaryContainer }]}
          accessibilityLiveRegion="polite"
        >
          {text}
        </Text>
      </View>
    </View>
  );
}

/**
 * The drawing help (2.1.1): a small popover anchored above the panel title's
 * (?), with the instructions the banner used to show. A full-screen
 * transparent backdrop closes it on a tap anywhere (and keeps that tap from
 * adding a point). Plain Views — no Portal, no Dialog.
 */
export function DrawHelpPopover({
  lines,
  bottom,
  anchorX,
  onClose,
}: {
  lines: readonly string[];
  /** Distance from the screen's bottom edge to the popover's (the panel's height). */
  bottom: number;
  /** The (?)'s centre, from the screen's left edge: where the caret points. */
  anchorX: number;
  onClose: () => void;
}) {
  // A Material tooltip: inverse colours, so it reads apart from the panel
  // (same surface) and the map, in light and dark alike.
  const { colors } = useTheme();
  const popBottom = bottom + HELP_GAP + HELP_CARET / 2;
  return (
    <View style={styles.helpLayer} pointerEvents="box-none" testID="draw-help">
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityLabel="Close drawing help"
        testID="draw-help-backdrop"
      />
      {/* The caret: a square turned 45°, half under the bubble, pointing at the (?). */}
      <View
        pointerEvents="none"
        style={[
          styles.helpCaret,
          {
            bottom: popBottom - HELP_CARET / 2,
            left: Math.max(HELP_SIDE + 12, anchorX - HELP_CARET / 2),
            backgroundColor: colors.inverseSurface,
          },
        ]}
      />
      <View
        style={[
          styles.help,
          {
            bottom: popBottom,
            backgroundColor: colors.inverseSurface,
            shadowColor: palette.shadow,
          },
        ]}
        pointerEvents="none"
        accessibilityLiveRegion="polite"
      >
        {lines.map((line) => (
          <Text key={line} style={[styles.helpText, { color: colors.inverseOnSurface }]}>
            {line}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** The help popover's caret (side of the turned square), gap to the panel, side margins. */
const HELP_CARET = 14;
const HELP_GAP = 4;
const HELP_SIDE = 12;

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
  /**
   * Beside Undo/Clear: a route's Return chip — its label (measured) and the
   * chip, with or without that label (it collapses first when space runs out).
   */
  toggle?: { label: string; render: (showLabel: boolean) => ReactNode };
  /**
   * Drawn over the panel last (a menu anchored above the buttons row): gets
   * the distance from the panel's bottom edge to the top of that row.
   */
  overlay?: (buttonsBottom: number) => ReactNode;
  /**
   * The (?) after the title (2.1.1): toggles the help popover. `onAnchor` gets
   * the (?)'s centre from the panel's left edge, for the popover's caret.
   */
  help?: { open: boolean; onToggle: () => void; onAnchor: (x: number) => void };
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

/** The panel's side padding (dp): the (?)'s anchor is measured from it. */
const PANEL_PAD_X = 18;

/** Bottom-row geometry (dp): Undo + Clear, the gap, Save's side padding, the chip's chrome. */
const ROW_GAP = 8;
const ICONS_W = 52 + ROW_GAP + 52;
/** Save's minimum side padding: the pill still reads as a button at its narrowest. */
const SAVE_PAD = 10;
/** Chip: padding 2×8, border 2×1.5, icon 20, gaps 2×3, caret 14 — plus its label. */
const CHIP_CHROME = 16 + 3 + 20 + 6 + 14;
/** Collapsed chip: icon + caret only. */
const CHIP_COMPACT = 16 + 3 + 20 + 3 + 14;

/** The bottom panel shared by the route and area tools. */
export function DrawPanel({
  title,
  stats,
  chart,
  notice,
  toggle,
  overlay,
  help,
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
  const [rowW, setRowW] = useState(0);
  const [labelW, setLabelW] = useState({ save: 0, chip: 0 });
  const widths = {
    save: labelW.save > 0 ? Math.ceil(labelW.save) + 2 * SAVE_PAD : 0,
    chipFull: toggle ? Math.ceil(labelW.chip) + CHIP_CHROME : 0,
    chipCompact: toggle ? CHIP_COMPACT : 0,
  };
  const layout = bottomRowLayout({
    row: labelW.save > 0 ? rowW : 0,
    icons: ICONS_W,
    gap: ROW_GAP,
    ...widths,
  });
  const saveButton = (
    <Pressable
      onPress={onSave}
      disabled={!canSave}
      accessibilityRole="button"
      accessibilityLabel={saveLabel}
      accessibilityState={{ disabled: !canSave }}
      style={[
        styles.save,
        // Never narrower than its one-line label.
        { backgroundColor: theme.colors.primary, minWidth: widths.save || undefined },
        !canSave && styles.disabled,
      ]}
      testID="draw-save"
    >
      <Text
        numberOfLines={1}
        style={[styles.saveLabel, { color: theme.colors.onPrimary }]}
        testID="draw-save-label"
      >
        {saveLabel}
      </Text>
    </Pressable>
  );
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
        <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
        {help !== undefined && (
          <Pressable
            onPress={help.onToggle}
            onLayout={(e) => {
              const { x, width } = e.nativeEvent.layout;
              help.onAnchor(PANEL_PAD_X + x + width / 2);
            }}
            accessibilityRole="button"
            accessibilityLabel="Drawing help"
            accessibilityState={{ expanded: help.open }}
            hitSlop={8}
            style={styles.helpButton}
            testID="draw-help-button"
          >
            <Icon
              source={help.open ? 'help-circle' : 'help-circle-outline'}
              size={20}
              color={t.inkMuted}
            />
          </Pressable>
        )}
        <View style={styles.titleSpacer} />
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
      {/* Natural widths of Save's and the Return chip's labels, measured off-screen. */}
      <View
        style={styles.measure}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text
          style={styles.saveLabel}
          onLayout={(e) => {
            const width = e.nativeEvent.layout.width;
            setLabelW((w) => ({ ...w, save: width }));
          }}
          testID="measure-save"
        >
          {saveLabel}
        </Text>
        {toggle && (
          <Text
            style={styles.toggleLabel}
            onLayout={(e) => {
              const width = e.nativeEvent.layout.width;
              setLabelW((w) => ({ ...w, chip: width }));
            }}
            testID="measure-chip"
          >
            {toggle.label}
          </Text>
        )}
      </View>
      <View
        style={layout.mode === 'stacked' ? styles.stack : undefined}
        onLayout={(e) => {
          setButtonsY(e.nativeEvent.layout.y);
          setRowW(e.nativeEvent.layout.width);
        }}
        testID="draw-actions"
      >
        <View style={styles.actions}>
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
          {toggle?.render(layout.chipLabel)}
          {layout.mode !== 'stacked' && saveButton}
        </View>
        {layout.mode === 'stacked' && (
          <View style={styles.actions} testID="draw-save-row">
            {saveButton}
          </View>
        )}
      </View>
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

/** The Return chip's visible label for an option ("Back & forth"). */
export const finishLabel = (id: RouteFinish): string => finishOf(id).label;

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
  showLabel = true,
}: {
  finish: RouteFinish;
  disabled: boolean;
  open: boolean;
  onPress: () => void;
  /** False when the row is narrow: icon + caret only (the spoken label stays). */
  showLabel?: boolean;
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
      accessibilityLabel={`Return: ${f.spoken}`}
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
      {showLabel && (
        <Text numberOfLines={1} style={[styles.toggleLabel, { color: ink }]}>
          {f.label}
        </Text>
      )}
      <Icon source={open ? 'chevron-down' : 'chevron-up'} size={14} color={ink} />
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
  // Sized by their labels ("Freehand" is the longest), sharing what is left;
  // on a narrow phone the labels shrink a little rather than truncate.
  mode: {
    flexGrow: 1,
    flexShrink: 1,
    borderRadius: (target.min - 8) / 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  modeLabel: { fontSize: 14, lineHeight: 18, fontWeight: '800' },
  hintWrap: { position: 'absolute', left: 16, right: 76, alignItems: 'flex-start' },
  panel: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: PANEL_PAD_X,
    paddingTop: 8,
    paddingBottom: 14,
    gap: 10,
    elevation: 8,
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: -2 },
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', minHeight: 36 },
  title: { flexShrink: 1, fontSize: 15, lineHeight: 20, fontWeight: '800' },
  titleSpacer: { flex: 1 },
  helpButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  // Over the whole screen (above the panel's dock), for the backdrop.
  helpLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10 },
  help: {
    position: 'absolute',
    left: HELP_SIDE,
    right: HELP_SIDE,
    maxWidth: 360,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 6,
    elevation: 10,
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  helpText: { fontSize: 14, lineHeight: 19 },
  helpCaret: {
    position: 'absolute',
    width: HELP_CARET,
    height: HELP_CARET,
    transform: [{ rotate: '45deg' }],
    elevation: 10,
  },
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
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stack: { gap: 8 },
  measure: { position: 'absolute', opacity: 0, left: 0, top: 0, flexDirection: 'row' },
  saveLabel: { fontSize: 16, lineHeight: 20, fontWeight: '800' },
  toggle: {
    minHeight: 48,
    borderRadius: 24,
    borderWidth: 1.5,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
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
  noticeText: { flex: 1, fontSize: 13, lineHeight: 17 },
});

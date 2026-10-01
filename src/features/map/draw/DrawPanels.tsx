import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { ReactNode } from 'react';
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

export type RouteMode = 'trails' | 'roads' | 'freehand';

const MODES: readonly { id: RouteMode; label: string; available: boolean }[] = [
  { id: 'trails', label: 'Trails', available: false },
  { id: 'roads', label: 'Roads', available: false },
  { id: 'freehand', label: 'Freehand', available: true },
];

/**
 * Trails · Roads · Freehand. Only Freehand draws today; snapping to trails or
 * roads needs the routing engine (coming with the NAS router), so those two
 * are shown — the board's promise — but disabled, with "Coming soon".
 */
export function RouteModeChips({ mode, top }: { mode: RouteMode; top: number }) {
  const t = useSchemeTokens();
  return (
    <View
      style={[styles.modes, { top, backgroundColor: t.surface }]}
      accessibilityRole="radiogroup"
      accessibilityLabel="Route mode"
    >
      {MODES.map((m) => {
        const on = m.id === mode;
        return (
          <Pressable
            key={m.id}
            disabled={!m.available}
            accessibilityRole="radio"
            accessibilityState={{ selected: on, disabled: !m.available }}
            accessibilityLabel={m.available ? m.label : `${m.label}, coming soon`}
            style={[styles.mode, on && { backgroundColor: t.library.chipOn }]}
          >
            <Text
              style={[
                styles.modeLabel,
                { color: on ? t.library.chipOnInk : m.available ? t.ink : t.inkMuted },
              ]}
            >
              {m.label}
            </Text>
            {!m.available && <Text style={[styles.soon, { color: t.inkMuted }]}>Coming soon</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}

/** The one-line instruction under the chips (or alone, for an area). */
export function DrawHint({ text, top }: { text: string; top: number }) {
  const t = useSchemeTokens();
  return (
    <View style={[styles.hintWrap, { top }]} pointerEvents="none">
      <Text
        style={[styles.hint, { backgroundColor: t.surface, color: t.inkVariant }]}
        accessibilityLiveRegion="polite"
      >
        {text}
      </Text>
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
  /** Below the stats: a warning or the selected point's delete row. */
  notice?: ReactNode;
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
  notice,
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
  return (
    <View
      style={[styles.panel, { backgroundColor: t.surface, shadowColor: palette.shadow }]}
      onLayout={onLayout}
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
      {notice}
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

/** An amber note under the stats (a crossing polygon, an unavailable climb). */
export function DrawNotice({ text }: { text: string }) {
  const t = useSchemeTokens();
  return (
    <View style={styles.notice} accessibilityLiveRegion="polite">
      <Icon source="alert-outline" size={16} color={t.status.pausedInk} />
      <Text style={[styles.noticeText, { color: t.status.pausedInk }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  modes: {
    position: 'absolute',
    left: 16,
    right: 16,
    padding: 6,
    borderRadius: 26,
    flexDirection: 'row',
    gap: 6,
    elevation: 4,
    shadowColor: palette.shadow,
    shadowOpacity: 0.2,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 4 },
  },
  mode: {
    flex: 1,
    minHeight: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
  },
  modeLabel: { fontSize: 14.5, lineHeight: 18, fontWeight: '800' },
  soon: { fontSize: 10.5, lineHeight: 13, fontWeight: '700' },
  hintWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'flex-start' },
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
  noticeText: { flex: 1, fontSize: 13, lineHeight: 17 },
});

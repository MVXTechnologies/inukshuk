import type { ActionState } from '@core/library/selection';
import { palette, space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useDisplayCondition } from '@ui/displayCondition';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, IconButton, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Select mode's chrome (#711, approved mockup `mockups-261-library-select`):
 * the header that replaces the Library title while anything is selected, the
 * fixed-slot action bar that replaces the tab bar, the "why is this dimmed"
 * bubble, and the Undo snackbar.
 */

/** ✕ · "5 selected" over its kind summary · Select all (absent for a folder). */
export function SelectionHeader({
  title,
  summary,
  selectAll,
  onClose,
}: {
  title: string;
  summary: string;
  /** The Select all button, or null (a selected folder has none). */
  selectAll: { label: string; onPress: () => void } | null;
  onClose: () => void;
}) {
  const t = useSchemeTokens();
  return (
    <View style={styles.header}>
      <IconButton
        icon="close"
        iconColor={t.ink}
        style={styles.headerButton}
        onPress={onClose}
        accessibilityLabel="Exit selection"
        testID="library-selection-close"
      />
      <View style={styles.headerText}>
        <Text
          numberOfLines={1}
          accessibilityRole="header"
          style={[styles.count, { color: t.ink }]}
          testID="library-selection-count"
        >
          {title}
        </Text>
        {summary !== '' && (
          <Text numberOfLines={1} style={[styles.kinds, { color: t.inkMuted }]}>
            {summary}
          </Text>
        )}
      </View>
      {selectAll && (
        <Pressable
          onPress={selectAll.onPress}
          accessibilityRole="button"
          accessibilityLabel={selectAll.label}
          testID="library-select-all"
          style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}
        >
          <Icon source="select-all" size={20} color={t.ink} />
          <Text style={[styles.textButtonLabel, { color: t.ink }]}>{selectAll.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

export interface BarSlot {
  id: string;
  icon: string;
  state: ActionState;
  /** The sage pill: the bar's primary action. */
  primary?: boolean;
  /** Red ink (Delete). */
  danger?: boolean;
}

/**
 * The action bar: fixed slots, each at least 48 dp wide and 56 dp tall. A
 * slot that does not apply is dimmed IN PLACE (the bar never reorders), and a
 * tap on it explains why; the reason is its accessibility hint too.
 */
export function SelectionActionBar({
  slots,
  onAction,
  onExplain,
  testIDPrefix,
}: {
  slots: readonly BarSlot[];
  onAction: (id: string) => void;
  onExplain: (reason: string) => void;
  testIDPrefix: string;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: theme.colors.elevation.level2,
          borderTopColor: t.outlineVariant,
          paddingBottom: Math.max(insets.bottom, space.sm),
        },
      ]}
      accessibilityRole="toolbar"
      testID={`${testIDPrefix}-bar`}
    >
      {slots.map((slot) => {
        const { enabled, reason, label } = slot.state;
        const ink = !enabled ? t.inkMuted : slot.danger ? theme.colors.error : t.ink;
        return (
          <Pressable
            key={slot.id}
            onPress={() => (enabled ? onAction(slot.id) : reason && onExplain(reason))}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={enabled ? undefined : (reason ?? undefined)}
            accessibilityState={{ disabled: !enabled }}
            testID={`${testIDPrefix}-${slot.id}`}
            style={({ pressed }) => [
              styles.slot,
              !enabled && styles.off,
              pressed && styles.pressed,
            ]}
          >
            <View
              style={[
                styles.slotIcon,
                slot.primary && enabled && { backgroundColor: theme.colors.secondaryContainer },
              ]}
            >
              <Icon source={slot.icon} size={24} color={ink} />
            </View>
            {/* Two lines: "Hide from map" is wider than a fifth of a 360 dp
              phone and was cut to "Hide from m…" (QA 2.6.1, #711). */}
            <Text
              numberOfLines={SLOT_LABEL_LINES}
              maxFontSizeMultiplier={1.3}
              style={[styles.slotLabel, { color: ink }]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The bubble over the bar that says why a dimmed action does not apply. */
export function ReasonTip({ message }: { message: string | null }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  if (message === null) return null;
  return (
    <View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={[
        styles.tip,
        {
          backgroundColor: theme.colors.inverseSurface,
          bottom: BAR_HEIGHT + Math.max(insets.bottom, space.sm) + space.sm,
        },
      ]}
      testID="library-action-reason"
    >
      <Text style={[styles.tipText, { color: theme.colors.inverseOnSurface }]}>{message}</Text>
    </View>
  );
}

/**
 * The Undo snackbar: the inverse surface, the message, and a 48 dp Undo.
 * A plain View (never Paper's Snackbar, whose timer sticks on One UI); its
 * timer is `useUndoSnackbar`'s.
 */
export function UndoBar({
  message,
  onUndo,
  bottom,
}: {
  message: string | null;
  onUndo: () => void;
  bottom: number;
}) {
  const theme = useTheme();
  const night = useDisplayCondition() === 'night';
  if (message === null) return null;
  // The mockup's sage: light on the dark slab, deep on the light one.
  const undoInk = night
    ? theme.colors.inverseOnSurface
    : theme.dark
      ? palette.sageDeep
      : theme.colors.inversePrimary;
  return (
    <View
      style={[styles.snack, { backgroundColor: theme.colors.inverseSurface, bottom }]}
      accessibilityLiveRegion="polite"
      testID="library-undo-bar"
    >
      <Text style={[styles.snackText, { color: theme.colors.inverseOnSurface }]}>{message}</Text>
      <Pressable
        onPress={onUndo}
        accessibilityRole="button"
        accessibilityLabel="Undo"
        testID="library-undo"
        style={({ pressed }) => [styles.undo, pressed && styles.pressed]}
      >
        <Text style={[styles.undoLabel, { color: undoInk }]}>Undo</Text>
      </Pressable>
    </View>
  );
}

/** The bar's height above the bottom inset. */
export const BAR_HEIGHT = 64;

/** An action label may wrap once ("Hide from / map") rather than be cut. */
export const SLOT_LABEL_LINES = 2;

const styles = StyleSheet.create({
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.xs,
    paddingRight: space.sm,
    gap: space.xs,
  },
  headerButton: { margin: 0, width: target.min, height: target.min },
  headerText: { flex: 1, minWidth: 0 },
  count: { fontSize: 22, lineHeight: 26, fontWeight: '800' },
  kinds: { fontSize: 12.5, lineHeight: 16, fontWeight: '700' },
  textButton: {
    minHeight: target.min,
    paddingHorizontal: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 24,
  },
  textButtonLabel: { fontSize: 15, fontWeight: '800' },
  pressed: { opacity: 0.6 },
  bar: {
    flexDirection: 'row',
    paddingTop: space.xs,
    paddingHorizontal: space.xs,
    borderTopWidth: 1,
    elevation: 6,
    shadowColor: palette.shadow,
    shadowOpacity: 0.1,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: -4 },
  },
  slot: {
    flex: 1,
    minWidth: target.min,
    minHeight: 56,
    alignItems: 'center',
    paddingTop: 6,
    gap: 3,
  },
  off: { opacity: 0.45 },
  slotIcon: {
    width: 48,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotLabel: {
    fontSize: 12,
    lineHeight: 14,
    fontWeight: '700',
    textAlign: 'center',
    paddingHorizontal: 2,
  },
  tip: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: space.md,
    elevation: 6,
    shadowColor: palette.black,
    shadowOpacity: 0.28,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 6 },
  },
  tipText: { fontSize: 13.5, lineHeight: 18, fontWeight: '600' },
  snack: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    minHeight: 52,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.lg,
    paddingRight: space.xs,
    elevation: 6,
    shadowColor: palette.black,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 6 },
  },
  snackText: { flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: '600', paddingVertical: space.sm },
  undo: { minHeight: target.min, paddingHorizontal: 14, justifyContent: 'center' },
  undoLabel: { fontSize: 15, fontWeight: '800' },
});

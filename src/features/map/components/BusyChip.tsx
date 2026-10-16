import {
  busyChipA11yLabel,
  busyChipLabel,
  busyFraction,
  busyRowA11yLabel,
  busyRowText,
  nextBusyRevealAt,
  visibleBusyTasks,
} from '@core/tasks/busyChip';
import type { BusyTask } from '@core/tasks/busyTasks';
import { palette } from '@ui/tokens';
import { useChromeOutline } from '@ui/useChromeOutline';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';
import { useBusyTasks } from '@state/busyTasksStore';
import { useSheetAccent } from './mapSheet';

/**
 * The tasks the chip may show now: each one only after it has run
 * BUSY_SHOW_AFTER_MS (no flashing). Re-evaluates on its own when the next
 * hidden task comes due.
 */
export function useVisibleBusyTasks(): BusyTask[] {
  const { tasks } = useBusyTasks();
  // The clock the threshold is read against; it advances only when a hidden
  // task comes due (a timer), never per render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const due = nextBusyRevealAt(tasks, now);
    if (due === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, due - Date.now()));
    return () => clearTimeout(timer);
  }, [tasks, now]);
  return visibleBusyTasks(tasks, now);
}

/** The small spinner of the chip and its rows (mockup: 14 px). */
function Spinner() {
  const theme = useTheme();
  return (
    <ActivityIndicator
      size="small"
      color={theme.colors.primary}
      style={styles.spinner}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}

/** The running tasks above the chip (mockup A3): one row each, a bar where progress counts. */
function BusyPopover({
  tasks,
  anchor,
  onClose,
}: {
  tasks: readonly BusyTask[];
  /** The chip's top-left in window coordinates (null until measured). */
  anchor: { x: number; y: number } | null;
  onClose: () => void;
}) {
  const tokens = useSchemeTokens();
  const { accent } = useSheetAccent();
  // Placed from the TOP, its own measured height above the chip. Chip and
  // modal root are both measured with `measure` (page coordinates):
  // `measureInWindow` left out the status bar on Android edge-to-edge and
  // floated the list ~52 dp above the chip (emulator, 2.6.2 QA).
  const rootRef = useRef<View>(null);
  const [rootAt, setRootAt] = useState<{ x: number; y: number } | null>(null);
  const [popH, setPopH] = useState<number | null>(null);
  const placed =
    anchor !== null && rootAt !== null && popH !== null
      ? { left: anchor.x - rootAt.x, top: anchor.y - rootAt.y - popH - POP_GAP }
      : anchor !== null
        ? styles.popMeasuring // a frame to learn where it goes: no jump
        : styles.popFallback;
  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View
        ref={rootRef}
        style={styles.modalRoot}
        onLayout={() =>
          rootRef.current?.measure((_x, _y, _w, _h, pageX, pageY) =>
            setRootAt({ x: pageX, y: pageY }),
          )
        }
      >
        {/* Tap anywhere else to close. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close running tasks"
        />
        <View
          testID="busy-popover"
          accessibilityLabel="Running tasks"
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
          onLayout={(e) => setPopH(e.nativeEvent.layout.height)}
          style={[
            styles.pop,
            placed,
            { backgroundColor: tokens.surface, borderColor: tokens.outlineVariant },
          ]}
        >
          {tasks.map((task, i) => {
            const { title, detail } = busyRowText(task);
            const fraction = busyFraction(task);
            return (
              <View
                key={task.id}
                accessible
                accessibilityLabel={busyRowA11yLabel(task)}
                style={[
                  styles.row,
                  i > 0 && { borderTopWidth: StyleSheet.hairlineWidth },
                  { borderTopColor: tokens.outlineVariant },
                ]}
              >
                <View style={styles.rowLine}>
                  <Spinner />
                  <Text style={[styles.rowTitle, { color: tokens.ink }]} numberOfLines={1}>
                    {title}
                  </Text>
                  <Text style={[styles.rowDetail, { color: tokens.inkMuted }]} numberOfLines={1}>
                    {detail}
                  </Text>
                </View>
                {fraction !== null && (
                  <View
                    testID="busy-progress"
                    style={[styles.bar, { backgroundColor: tokens.surfaceVariant }]}
                  >
                    <View
                      style={[
                        styles.barFill,
                        { width: `${Math.round(fraction * 100)}%`, backgroundColor: accent },
                      ]}
                    />
                  </View>
                )}
              </View>
            );
          })}
          <View
            style={[
              styles.arrow,
              { backgroundColor: tokens.surface, borderColor: tokens.outlineVariant },
            ]}
          />
        </View>
      </View>
    </Modal>
  );
}

/**
 * What the map is busy with (#721, mockup A1–A3): ONE chip in the bottom
 * chrome column, where the PDF "Rendering… page N" rows used to stack. The
 * longest-running task names it ("Slope", "Map tiles 12/40", "PDF p.2"); a
 * sage "+N" counts the others. A tap opens the list above it; a tap anywhere
 * else (or Back) closes it. Nothing shows for work shorter than 400 ms.
 *
 * A plain themed View, not a Paper Surface: absolutely-positioned Surfaces
 * collapse their flex columns on iOS.
 */
export function BusyChip() {
  const tokens = useSchemeTokens();
  const outline = useChromeOutline();
  const { accent, onAccent } = useSheetAccent();
  const visible = useVisibleBusyTasks();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const chipRef = useRef<View>(null);
  // Nothing running any more: the list closes with the chip.
  if (open && visible.length === 0) setOpen(false);

  const first = visible[0];
  if (first === undefined) return null;
  const more = visible.length - 1;
  return (
    <>
      <Pressable
        ref={chipRef}
        testID="busy-chip"
        onPress={() => {
          chipRef.current?.measure((_x, _y, _w, _h, pageX, pageY) =>
            setAnchor({ x: pageX, y: pageY }),
          );
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={busyChipA11yLabel(visible)}
        accessibilityState={{ expanded: open }}
        style={[
          styles.chip,
          { backgroundColor: tokens.surfaceVariant },
          open && { borderColor: accent, borderWidth: 2 },
          outline,
        ]}
      >
        <Spinner />
        <Text style={[styles.chipText, { color: tokens.inkVariant }]} numberOfLines={1}>
          {busyChipLabel(first)}
        </Text>
        {more > 0 && (
          <View style={[styles.more, { backgroundColor: accent }]} testID="busy-more">
            <Text style={[styles.moreText, { color: onAccent }]}>{`+${more}`}</Text>
          </View>
        )}
      </Pressable>
      {open && <BusyPopover tasks={visible} anchor={anchor} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Popover's gap above the chip (room for its arrow). */
const POP_GAP = 10;

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
    minHeight: 30,
    paddingLeft: 10,
    paddingRight: 12,
    paddingVertical: 4,
    borderRadius: 14,
    borderWidth: 0,
    borderColor: 'transparent',
    maxWidth: '100%',
    shadowColor: palette.shadow,
    shadowOpacity: 0.22,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  spinner: { width: 14, height: 14, transform: [{ scale: 0.7 }] },
  chipText: { flexShrink: 1, fontSize: 12.5, lineHeight: 17, fontWeight: '500' },
  more: {
    minWidth: 22,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 6,
    marginLeft: -2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreText: { fontSize: 11, lineHeight: 14, fontWeight: '800' },
  modalRoot: { flex: 1 },
  pop: {
    position: 'absolute',
    width: 226,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
    shadowColor: palette.shadow,
    shadowOpacity: 0.28,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  popFallback: { left: 16, bottom: 160 },
  popMeasuring: { left: 16, top: 0, opacity: 0 },
  row: { paddingHorizontal: 14, paddingVertical: 8, gap: 6 },
  rowLine: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowTitle: { flex: 1, fontSize: 13, lineHeight: 17, fontWeight: '700' },
  rowDetail: { flexShrink: 1, fontSize: 12, lineHeight: 16, fontVariant: ['tabular-nums'] },
  bar: { height: 4, borderRadius: 2, marginLeft: 24, overflow: 'hidden' },
  barFill: { height: 4, borderRadius: 2 },
  arrow: {
    position: 'absolute',
    left: 24,
    bottom: -6,
    width: 12,
    height: 12,
    transform: [{ rotate: '45deg' }],
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});

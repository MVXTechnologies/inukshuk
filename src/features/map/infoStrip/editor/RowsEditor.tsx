import { spokenValue } from '@core/infoStrip/compute';
import {
  canAddRow,
  dropSlot,
  moveField,
  moveRow,
  removeField,
  type RowRect,
  type Slot,
} from '@core/infoStrip/edit';
import { fitRow } from '@core/infoStrip/layout';
import type { ComputeContext, DepsSnapshot, FieldRef } from '@core/infoStrip/types';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { Animated, Pressable, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Icon, Text } from 'react-native-paper';

import { StripField } from '../StripField';
import { previewValue } from './preview';

/** How long a field is held before it lifts to be dragged, ms (a tap opens its settings). */
export const DRAG_HOLD_MS = 300;

type Rows = readonly (readonly FieldRef[])[];

export interface RowsEditorProps {
  rows: Rows;
  data: DepsSnapshot;
  ctx: ComputeContext;
  onChange: (rows: FieldRef[][]) => void;
  onOpenField: (at: Slot) => void;
  /** Open the picker to add to row `row` (`rows.length`: a new row). */
  onAdd: (row: number) => void;
}

const FIELD_ACTIONS = [
  { name: 'moveLeft', label: 'Move left' },
  { name: 'moveRight', label: 'Move right' },
  { name: 'moveUp', label: 'Move to the row above' },
  { name: 'moveDown', label: 'Move to the row below' },
  { name: 'remove', label: 'Remove' },
] as const;
const ROW_ACTIONS = [
  { name: 'rowUp', label: 'Move row up' },
  { name: 'rowDown', label: 'Move row down' },
] as const;

/**
 * The editor's rows (mockup §3 `erow`): each row as it will look, every field
 * with its live value and ✕; tap a field for its settings, hold and drag it
 * within its row or to another (below the last row: a new one, while there
 * are fewer than 3), or drag a row by its handle. A + shows only where the
 * row has a free space; "Add a row" only while there are fewer than 3.
 *
 * The drop rules are the pure `moveField` / `moveRow` / `dropSlot`: a drop
 * that does not fit simply puts the field back. Every move is also a screen
 * reader action (move left/right, to the row above/below, row up/down).
 */
export function RowsEditor({ rows, data, ctx, onChange, onOpenField, onAdd }: RowsEditorProps) {
  const t = useSchemeTokens();
  // The measured views and their window rects: read only in gesture
  // callbacks, never in render (one mutable bag for the editor's lifetime).
  const [views] = useState(() => ({
    rows: new Map<number, View | null>(),
    chips: new Map<string, View | null>(),
    rects: [] as RowRect[],
  }));
  const [drag] = useState(() => new Animated.ValueXY());
  const [dragging, setDragging] = useState<Slot | null>(null);

  /**
   * Screen rects of every row and field, read when a drag starts (the sheet
   * may have scrolled), in the gesture's own frame: `measure`'s pageX/pageY,
   * like the drop point's absoluteX/Y. Never `measureInWindow`: on Android it
   * sits a status bar higher, so every drop landed a row low (a drop on row 1
   * made a new row; QA 2.6.0 on the emulator, a 52 dp status bar).
   */
  const measure = () => {
    const next: RowRect[] = rows.map((r) => ({
      y: 0,
      h: 0,
      fields: r.map(() => ({ x: 0, w: 0 })),
    }));
    rows.forEach((_row, r) =>
      views.rows.get(r)?.measure((_x, _y, _w, h, _pageX, pageY) => {
        const row = next[r];
        if (row !== undefined) Object.assign(row, { y: pageY, h });
      }),
    );
    rows.forEach((row, r) =>
      row.forEach((_f, i) =>
        views.chips.get(`${r}:${i}`)?.measure((_x, _y, w, _h, pageX) => {
          const f = next[r]?.fields[i];
          if (f !== undefined) Object.assign(f, { x: pageX, w });
        }),
      ),
    );
    views.rects.splice(0, views.rects.length, ...next);
  };

  const apply = (next: FieldRef[][] | null) => {
    if (next !== null) onChange(next);
  };
  const dropField = (from: Slot, point: { x: number; y: number }) => {
    const to = dropSlot(views.rects, point);
    if (to !== null) apply(moveField(rows, from, to));
  };
  const dropRow = (from: number, y: number) => {
    const to = views.rects.findIndex((r) => y < r.y + r.h);
    apply(moveRow(rows, from, to === -1 ? rows.length - 1 : to));
  };

  const fieldAction = (at: Slot) => (e: AccessibilityActionEvent) => {
    const n = e.nativeEvent.actionName;
    if (n === 'remove') return onChange(removeField(rows, at));
    if (n === 'moveLeft') return apply(moveField(rows, at, { row: at.row, index: at.index - 1 }));
    if (n === 'moveRight') return apply(moveField(rows, at, { row: at.row, index: at.index + 2 }));
    const row = at.row + (n === 'moveUp' ? -1 : 1);
    if (row < 0) return;
    apply(moveField(rows, at, { row, index: rows[row]?.length ?? 0 }));
  };
  const rowAction = (r: number) => (e: AccessibilityActionEvent) =>
    apply(moveRow(rows, r, r + (e.nativeEvent.actionName === 'rowUp' ? -1 : 1)));

  return (
    <View>
      {rows.map((row, r) => {
        const fit = fitRow(row);
        const handle = Gesture.Pan()
          .runOnJS(true)
          .withTestId(`strip-row-drag-${r}`)
          .onStart(measure)
          .onEnd((e) => dropRow(r, e.absoluteY));
        return (
          <View
            key={`row-${r}`}
            ref={(v) => {
              views.rows.set(r, v);
            }}
            style={[styles.row, { backgroundColor: t.surfaceVariant }]}
            testID={`strip-edit-row-${r}`}
          >
            <GestureDetector gesture={handle}>
              <View
                style={styles.handle}
                accessible
                accessibilityLabel={`Row ${r + 1}`}
                accessibilityHint="Drag to reorder the rows"
                accessibilityActions={ROW_ACTIONS}
                onAccessibilityAction={rowAction(r)}
                testID={`strip-row-handle-${r}`}
              >
                <Icon source="drag-vertical" size={20} color={t.inkMuted} />
              </View>
            </GestureDetector>
            {row.map((f, i) => {
              const pv = previewValue(f, data, ctx);
              if (pv === null) return null;
              const at = { row: r, index: i };
              const lifted = dragging?.row === r && dragging.index === i;
              const pan = Gesture.Pan()
                .activateAfterLongPress(DRAG_HOLD_MS)
                .runOnJS(true)
                .withTestId(`strip-field-drag-${r}-${i}`)
                .onStart(() => {
                  measure();
                  setDragging(at);
                })
                .onUpdate((e) => drag.setValue({ x: e.translationX, y: e.translationY }))
                .onEnd((e) => dropField(at, { x: e.absoluteX, y: e.absoluteY }))
                .onFinalize(() => {
                  drag.setValue({ x: 0, y: 0 });
                  setDragging(null);
                });
              return (
                <GestureDetector key={`${f.field}-${i}`} gesture={pan}>
                  <Animated.View
                    ref={(v: View | null) => {
                      views.chips.set(`${r}:${i}`, v);
                    }}
                    testID={`strip-edit-chip-${r}-${i}`}
                    style={[
                      styles.chip,
                      { flex: pv.descriptor.spaces, backgroundColor: t.surface },
                      lifted && [
                        styles.lifted,
                        { transform: drag.getTranslateTransform(), borderColor: t.ink },
                      ],
                    ]}
                  >
                    <Pressable
                      onPress={() => onOpenField(at)}
                      accessibilityRole="button"
                      accessibilityLabel={
                        pv.live
                          ? spokenValue(pv.descriptor.label, pv.value)
                          : `${pv.descriptor.label}, no value now`
                      }
                      accessibilityHint="Opens its settings. Hold to drag it."
                      accessibilityActions={FIELD_ACTIONS}
                      onAccessibilityAction={fieldAction(at)}
                      style={styles.chipBody}
                      testID={`strip-edit-field-${r}-${i}`}
                    >
                      <StripField
                        value={pv.value}
                        shrink={pv.descriptor.spaces > 1}
                        muted={!pv.live}
                      />
                    </Pressable>
                    <Pressable
                      onPress={() => onChange(removeField(rows, at))}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${pv.descriptor.label}`}
                      style={styles.remove}
                    >
                      <Icon source="close" size={14} color={t.inkMuted} />
                    </Pressable>
                  </Animated.View>
                </GestureDetector>
              );
            })}
            {fit.plus && (
              <Pressable
                onPress={() => onAdd(r)}
                accessibilityRole="button"
                accessibilityLabel={`Add a field to row ${r + 1}`}
                style={[styles.plus, { borderColor: t.outline }]}
                testID={`strip-add-field-${r}`}
              >
                <Icon source="plus" size={18} color={t.inkVariant} />
              </Pressable>
            )}
          </View>
        );
      })}
      {canAddRow(rows) && (
        <Pressable
          onPress={() => onAdd(rows.length)}
          accessibilityRole="button"
          accessibilityLabel="Add a row"
          style={[styles.addRow, { borderColor: t.outline }]}
          testID="strip-add-row"
        >
          <Icon source="plus" size={18} color={t.inkVariant} />
          <Text style={[styles.addRowText, { color: t.inkVariant }]}>Add a row</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 12,
    marginVertical: 4,
    padding: 6,
    paddingLeft: 0,
    borderRadius: 12,
    minHeight: 52,
  },
  handle: { width: 32, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    height: 40,
    borderRadius: 10,
    paddingLeft: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  chipBody: { flex: 1, minWidth: 0, height: 40, justifyContent: 'center' },
  lifted: { zIndex: 10, elevation: 8, shadowOpacity: 0.25, shadowRadius: 8 },
  remove: { width: 26, height: 40, alignItems: 'center', justifyContent: 'center' },
  plus: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginHorizontal: 12,
    marginVertical: 4,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  addRowText: { fontSize: 14, fontWeight: '600' },
});

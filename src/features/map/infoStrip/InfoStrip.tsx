import { spokenValue, type PlacedValue } from '@core/infoStrip/compute';
import {
  ROW_DIVIDER_DP,
  ROW_H_DP,
  STRIP_MERGED_EXTRA_DP,
  STRIP_PAD_DP,
} from '@core/infoStrip/layout';
import type { Dock } from '@core/infoStrip/types';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo, Fragment } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from 'react-native';

import { StripField } from './StripField';

/** The long-press that opens the editor, ms (a tap keeps a field's own action). */
export const EDIT_HOLD_MS = 450;

const EDIT_ACTION = [{ name: 'longpress', label: 'Customize info strip' }] as const;

export interface InfoStripViewProps {
  rows: readonly (readonly PlacedValue[])[];
  dock: Dock;
  /** Sitting on the recording panel: the strip takes the panel's rounded top. */
  onPanel: boolean;
  /** Top dock: the status bar's height, which the strip's surface reaches behind. */
  topInset: number;
  onEdit: () => void;
  /** A tap on a field that copies (coordinates): the text it copies. */
  onCopy: (p: PlacedValue) => void;
  /** A tap on the target name (#696): open its target's card. */
  onOpenTarget?: (p: PlacedValue) => void;
  onLayout?: (e: LayoutChangeEvent) => void;
}

/**
 * The docked strip (mockup 2.6.0 §1): full width, on the themed surface
 * (paper by day, stone by night), 30 dp rows of 1–4 spaces, a hairline
 * between rows and between fields. Fields share the row by their spaces;
 * each reads left-aligned in its share.
 *
 * Bottom dock: joined to the tab bar (a hairline and a soft shadow up onto
 * the map), or stacked on the recording panel, taking its rounded top. Top
 * dock: its surface reaches up behind the status bar.
 *
 * A long-press anywhere opens the editor; a tap keeps a field's own action
 * (the coordinates copy, the target name opens its target). Pure layout:
 * values come in computed.
 */
export const InfoStripView = memo(function InfoStripView({
  rows,
  dock,
  onPanel,
  topInset,
  onEdit,
  onCopy,
  onOpenTarget,
  onLayout,
}: InfoStripViewProps) {
  const t = useSchemeTokens();
  const top = dock === 'top';
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'longpress') onEdit();
  };
  return (
    <Pressable
      onLongPress={onEdit}
      delayLongPress={EDIT_HOLD_MS}
      onLayout={onLayout}
      accessible={false}
      testID="info-strip"
      style={[
        styles.strip,
        { backgroundColor: t.surface, borderColor: t.outlineVariant },
        top
          ? [styles.top, { paddingTop: topInset + STRIP_PAD_DP / 2 }]
          : onPanel
            ? styles.onPanel
            : styles.bottom,
      ]}
    >
      {rows.map((row, r) => (
        <Fragment key={`r${row[0]!.row}`}>
          {r > 0 && <View style={[styles.rowDivider, { backgroundColor: t.divider }]} />}
          <View style={styles.row} testID={`info-strip-row-${r}`}>
            {row.map((p, i) => {
              const copies =
                p.descriptor.id === 'coords' && (p.ref.params.tapToCopy as boolean) !== false;
              const isCoords = p.descriptor.id === 'coords';
              const opens = p.descriptor.id === 'targetName' && onOpenTarget !== undefined;
              const field = (
                <StripField
                  value={p.value}
                  shrink={p.descriptor.spaces > 1}
                  textTestID={
                    isCoords
                      ? 'map-coords-text'
                      : p.descriptor.id === 'elevation'
                        ? 'map-coords-altitude'
                        : undefined
                  }
                />
              );
              const spoken = spokenValue(p.descriptor.label, p.value);
              return (
                <Fragment key={`${p.row}:${p.index}`}>
                  {i > 0 && <View style={[styles.fieldDivider, { backgroundColor: t.divider }]} />}
                  {copies || opens ? (
                    <Pressable
                      onPress={() => (copies ? onCopy(p) : onOpenTarget?.(p))}
                      onLongPress={onEdit}
                      delayLongPress={EDIT_HOLD_MS}
                      accessibilityRole="button"
                      accessibilityLabel={spoken}
                      accessibilityHint={copies ? 'Copies the coordinates' : 'Opens the target'}
                      accessibilityActions={EDIT_ACTION}
                      onAccessibilityAction={onAction}
                      style={({ pressed }) => [
                        styles.cell,
                        { flex: p.descriptor.spaces },
                        pressed && styles.pressed,
                      ]}
                      testID={copies ? 'map-center-coords' : `strip-field-${p.descriptor.id}`}
                    >
                      {field}
                    </Pressable>
                  ) : (
                    <View
                      accessible
                      accessibilityLabel={spoken}
                      accessibilityActions={EDIT_ACTION}
                      onAccessibilityAction={onAction}
                      style={[styles.cell, { flex: p.descriptor.spaces }]}
                      // On the accessible cell, so iOS (which folds its children) finds it too.
                      testID={isCoords ? 'map-center-coords' : `strip-field-${p.descriptor.id}`}
                    >
                      {field}
                    </View>
                  )}
                </Fragment>
              );
            })}
          </View>
        </Fragment>
      ))}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  strip: { paddingHorizontal: 12 },
  // The hairline on top, 3 dp in, 3 dp under the last row: STRIP_PAD_DP in all.
  bottom: {
    borderTopWidth: 1,
    paddingTop: (STRIP_PAD_DP - 1) / 2,
    paddingBottom: (STRIP_PAD_DP - 1) / 2,
    shadowColor: palette.shadow,
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: -2 },
    elevation: 6,
  },
  // On the recording panel: its rounded top (+4 dp), one surface with it.
  onPanel: {
    borderTopWidth: 1,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: (STRIP_PAD_DP - 1) / 2 + STRIP_MERGED_EXTRA_DP,
    paddingBottom: (STRIP_PAD_DP - 1) / 2,
  },
  top: {
    borderBottomWidth: 1,
    paddingBottom: STRIP_PAD_DP / 2 - 1,
    shadowColor: palette.shadow,
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  row: { height: ROW_H_DP, flexDirection: 'row', alignItems: 'center' },
  rowDivider: { height: ROW_DIVIDER_DP, marginHorizontal: -4 },
  fieldDivider: { width: 1, alignSelf: 'stretch', marginVertical: 6, marginHorizontal: 8 },
  cell: { flexDirection: 'row', alignItems: 'center', minWidth: 0, height: ROW_H_DP },
  pressed: { opacity: 0.6 },
});

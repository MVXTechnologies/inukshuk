import { prefillFromPoint } from '@core/convert/prefill';
import { computeRows, type PlacedValue } from '@core/infoStrip/compute';
import { coordsPoint } from '@core/infoStrip/fields/position';
import { stripHeroMetrics, visibleRows } from '@core/infoStrip/layout';
import { effectiveTarget, targetOpen, type TargetOpen } from '@core/infoStrip/target';
import type { Target } from '@core/infoStrip/types';
import { useSettingsStore } from '@state/settingsStore';
import { openConvert } from '@features/convert/openConvert';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { InfoStripView } from './InfoStrip';
import { InfoStripEditor } from './editor/InfoStripEditor';
import { useRealSafeAreaInsets } from './InfoStripInsets';
import { useCurrentStrip } from './stripSettings';
import { openStripEditor, setStripRuntime, useStripRuntime } from './stripRuntime';
import { useStripSnapshot, type StripInputs } from './useStripData';
import { useScaledStyles } from '@ui/displayScale';

export interface InfoStripHostProps extends StripInputs {
  /** The bottom column's lift: the recording panel, a trail sheet or a drawing panel. */
  bottomLift: number;
  /** The region selector or the map maker owns the screen: no strip. */
  hidden: boolean;
  /**
   * A sheet covers the whole bottom edge (the trail inspector): a
   * bottom-docked strip steps aside rather than peek from under it, and
   * lifts nothing. A top-docked strip stays.
   */
  bottomSheetUp?: boolean;
  /** The map screen is the one in front (the editor's Android Back listens only then). */
  focused?: boolean;
  /**
   * The coordinates were copied: say so, with `convert` to open Convert on
   * that point (2.5.1's chip reached it by a long-press; the strip's
   * long-press edits, so the confirmation carries it).
   */
  onCopied: (message: string, convert?: () => void) => void;
  /**
   * A tap on the target name (#696): MapScreen opens the card on its own
   * paths (a waypoint's card, or the point chip on a point).
   */
  onOpenTarget: (open: TargetOpen) => void;
}

/**
 * Where MapScreen mounts the info strip (#673): one leaf that owns the
 * strip's subscriptions (`useStripSnapshot`), docks it, reports its measured
 * height for everything it lifts (`stripRuntime`), and hosts the editor.
 *
 * - Bottom dock: full width at `bottomLift` (on the tab bar's edge, or on
 *   the recording panel); MapScreen lifts its bottom column — the ⓘ + scale
 *   row and the compass tape — by the measured height.
 * - Top dock: under (and behind) the status bar; `InfoStripInsets` shifts
 *   every piece of top chrome down by the measured height below it.
 * - Stacking: the LOWEST overlay (`overlayOrder.ts`): no zIndex, mounted
 *   right after the map, so every sheet, card and shield draws over it.
 * - Recording: the panel owns its hero metrics; the strip drops the ones it
 *   shows (`visibleRows`) and tells the panel which ones the strip has
 *   (cycling skips them).
 */
export const InfoStripHost = memo(function InfoStripHost({
  bottomLift,
  hidden,
  bottomSheetUp = false,
  focused = true,
  onCopied,
  onOpenTarget,
  ...inputs
}: InfoStripHostProps) {
  const styles = useScaledStyles(stylesSheet);

  const strip = useCurrentStrip();
  const units = useSettingsStore((s) => s.units);
  const heroFields = useStripRuntime((s) => s.heroFields);
  const editorOpen = useStripRuntime((s) => s.editorOpen);
  const realInsets = useRealSafeAreaInsets();
  const topInset = realInsets.top;
  const panelMini = useStripRuntime((s) => s.panelMini);
  const panelPaused = useStripRuntime((s) => s.panelPaused);
  const router = useRouter();
  const recording = inputs.recording !== null;

  const rows = useMemo(
    () => visibleRows(strip.rows, heroFields, recording),
    [strip.rows, heroFields, recording],
  );
  const data = useStripSnapshot(strip, rows, inputs);
  const placed = useMemo(
    () => computeRows(rows, data, { units, target: strip.target }),
    [rows, data, units, strip.target],
  );

  const top = strip.dock === 'top';
  const shown = !hidden && !(bottomSheetUp && !top) && placed.length > 0;
  const onPanel = shown && !top && recording && heroFields.length > 0;
  // The panel minimised to its pill (QA 2.6.0, 06b): the strip takes the
  // screen's edge (the tab bar hides while recording), over the system bar,
  // and the pill floats on it — never the strip floating over the map.
  const atEdge = !top && recording && panelMini;

  // What the strip tells the others: its metrics (the panel's cycling) and
  // whether it sits on the panel.
  const metrics = useMemo(() => stripHeroMetrics(strip.rows), [strip.rows]);
  useEffect(() => setStripRuntime({ stripMetrics: metrics }), [metrics]);
  useEffect(() => setStripRuntime({ onPanel }), [onPanel]);
  // Which edge it lifts; nothing shown lifts nothing (its layout reports the height).
  useEffect(() => setStripRuntime({ dock: strip.dock }), [strip.dock]);
  useEffect(() => {
    if (!shown) setStripRuntime({ stripH: 0 });
  }, [shown]);
  useEffect(() => () => setStripRuntime({ stripH: 0, onPanel: false }), []);

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => setStripRuntime({ stripH: Math.round(e.nativeEvent.layout.height) }),
    [],
  );
  const onCopy = useCallback(
    (p: PlacedValue) => {
      void Clipboard.setStringAsync(p.value.value);
      // Convert on the point the field shows, in WGS 84 (as 2.5.1's long-press).
      const at = coordsPoint(data, p.ref.params);
      onCopied(
        `Copied ${p.value.value}`,
        at === null
          ? undefined
          : () => openConvert(router, prefillFromPoint(at.latitude, at.longitude)),
      );
    },
    [data, onCopied, router],
  );
  // Resolved at the tap, on the snapshot the field was drawn from.
  const onOpen = useCallback(
    (p: PlacedValue) => {
      const own = (p.ref.params.target as Target | null | undefined) ?? null;
      const open = targetOpen(effectiveTarget(own, strip.target), data);
      if (open !== null) onOpenTarget(open);
    },
    [data, strip.target, onOpenTarget],
  );

  return (
    <>
      {shown && (
        <View
          style={[styles.dock, top ? styles.top : { bottom: atEdge ? 0 : bottomLift }]}
          pointerEvents="box-none"
          testID="info-strip-dock"
        >
          <InfoStripView
            rows={placed}
            dock={strip.dock}
            onPanel={onPanel}
            panelPaused={panelPaused}
            topInset={topInset}
            bottomInset={atEdge ? realInsets.bottom : 0}
            onEdit={openStripEditor}
            onCopy={onCopy}
            onOpenTarget={onOpen}
            onLayout={onLayout}
          />
        </View>
      )}
      {editorOpen && !hidden && (
        <InfoStripEditor
          data={data}
          bottomLift={bottomLift}
          topInset={topInset}
          focused={focused}
        />
      )}
    </>
  );
});

const stylesSheet = StyleSheet.create({
  // The bottom of the map's overlay order (overlayOrder.ts), so neither zIndex nor elevation.
  dock: { position: 'absolute', left: 0, right: 0 },
  top: { top: 0 },
});

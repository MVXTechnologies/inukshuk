import { computeRows, type PlacedValue } from '@core/infoStrip/compute';
import { stripHeroMetrics, visibleRows } from '@core/infoStrip/layout';
import { useSettingsStore } from '@state/settingsStore';
import * as Clipboard from 'expo-clipboard';
import { memo, useCallback, useContext, useEffect, useMemo } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { InfoStripView } from './InfoStrip';
import { InfoStripEditor } from './editor/InfoStripEditor';
import { RealTopInsetContext } from './InfoStripInsets';
import { useCurrentStrip } from './stripSettings';
import { openStripEditor, setStripRuntime, useStripRuntime } from './stripRuntime';
import { useStripSnapshot, type StripInputs } from './useStripData';

export interface InfoStripHostProps extends StripInputs {
  /** The bottom column's lift: the recording panel, a trail sheet or a drawing panel. */
  bottomLift: number;
  /** The region selector or the map maker owns the screen: no strip. */
  hidden: boolean;
  onCopied: (message: string) => void;
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
 *   every piece of top chrome down by the measured height.
 * - Recording: the panel owns its hero metrics; the strip drops the ones it
 *   shows (`visibleRows`) and tells the panel which ones the strip has
 *   (cycling skips them).
 */
export const InfoStripHost = memo(function InfoStripHost({
  bottomLift,
  hidden,
  onCopied,
  ...inputs
}: InfoStripHostProps) {
  const strip = useCurrentStrip();
  const units = useSettingsStore((s) => s.units);
  const heroFields = useStripRuntime((s) => s.heroFields);
  const editorOpen = useStripRuntime((s) => s.editorOpen);
  const topInset = useContext(RealTopInsetContext);
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

  const shown = !hidden && placed.length > 0;
  const top = strip.dock === 'top';
  const onPanel = shown && !top && recording && heroFields.length > 0;

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
      onCopied(`Copied ${p.value.value}`);
    },
    [onCopied],
  );

  return (
    <>
      {shown && (
        <View
          style={[styles.dock, top ? styles.top : { bottom: bottomLift }]}
          pointerEvents="box-none"
        >
          <InfoStripView
            rows={placed}
            dock={strip.dock}
            onPanel={onPanel}
            topInset={topInset}
            onEdit={openStripEditor}
            onCopy={onCopy}
            onLayout={onLayout}
          />
        </View>
      )}
      {editorOpen && !hidden && (
        <InfoStripEditor data={data} bottomLift={bottomLift} topInset={topInset} />
      )}
    </>
  );
});

const styles = StyleSheet.create({
  dock: { position: 'absolute', left: 0, right: 0, zIndex: 4 },
  top: { top: 0 },
});

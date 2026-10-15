import { CURSOR_TICK_MS, createRateGate } from '@core/infoStrip/cursor';
import { stripReadsCursor } from '@core/infoStrip/deps';
import type { LatLng } from '@core/models';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useEffect, useState } from 'react';

/**
 * The map's centre while it moves, for the strip's cursor fields. MapScreen
 * publishes each camera report here (`publishLiveCentre`: a plain function
 * call, no React state, so MapScreen never re-renders for it); the strip
 * leaf subscribes (`useLiveCentre`) and re-renders at most every
 * `CURSOR_TICK_MS` (10 Hz), the last centre of a pan always delivered.
 *
 * Module state, not the map store: a store write at gesture rate would wake
 * every store subscriber's selector 60 times a second.
 */
let latest: LatLng | null = null;
const listeners = new Set<(c: LatLng) => void>();

/** A camera report (in gesture or settled): `[lon, lat]` as MapLibre gives it. */
export function publishLiveCentre(center: readonly [number, number] | readonly number[]): void {
  const lon = center[0];
  const lat = center[1];
  if (lon === undefined || lat === undefined) return;
  if (latest !== null && latest.latitude === lat && latest.longitude === lon) return;
  latest = { latitude: lat, longitude: lon };
  for (const l of listeners) l(latest);
}

/**
 * Whether the strip on the map reads the live cursor: MapScreen asks the map
 * for gesture-rate camera reports only then. A boolean selector, so it
 * re-renders MapScreen only when a cursor field is placed or removed.
 */
export function useStripReadsCursor(): boolean {
  return useSettingsStore((s) => stripReadsCursor(s.infoStrip.current.rows));
}

/** Test-only: forget the last centre and every listener. */
export function resetLiveCentre(): void {
  latest = null;
  listeners.clear();
}

/**
 * The live map centre, at most every `CURSOR_TICK_MS`, only while `on`
 * (else null and no subscription). Before the first report: the settled
 * centre the map store holds.
 */
export function useLiveCentre(on: boolean): LatLng | null {
  const settled = useMapStore((s) => (on ? s.mapCenter : null));
  const [centre, setCentre] = useState<LatLng | null>(null);
  useEffect(() => {
    if (!on) return;
    const gate = createRateGate<LatLng>(CURSOR_TICK_MS);
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The centre reported while nothing listened, delivered on the next tick.
    if (latest !== null) {
      const now = latest;
      timer = setTimeout(() => {
        timer = null;
        setCentre(now);
      }, 0);
    }
    const listener = (c: LatLng) => {
      const r = gate.push(c, Date.now());
      if (r.kind === 'emit') setCentre(c);
      else if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          const held = gate.flush(Date.now());
          if (held !== null) setCentre(held);
        }, r.inMs);
      }
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (timer !== null) clearTimeout(timer);
    };
  }, [on]);
  if (!on) return null;
  return centre ?? settled;
}

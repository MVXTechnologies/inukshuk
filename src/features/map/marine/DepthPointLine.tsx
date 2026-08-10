import { formatDepthReadout } from '@core/geo/marineDepth';
import type { LatLng } from '@core/models';
import { useMarinePackStore } from '@state/marinePackStore';
import { useSettingsStore } from '@state/settingsStore';
import { MapPointLine } from '../components/MapPointChip';
import { useDepthPointValue } from './useDepthPointValue';

/**
 * The depth line of the tap-anywhere chip (marine wave D §D1): with marine
 * mode on, a tap shows the surveyed depth under the finger —
 * "Depth 26.5 m · chart datum" (drying heights read "Drying 3.8 m"). Feet
 * under imperial units. A second muted line names WHO answered (§D3's
 * honesty rule): a 10 m CHS survey and a 450 m global compilation must never
 * look like the same number, and an offline pack says so out loud.
 *
 * While the query is in flight the line shows an ellipsis, exactly like the
 * weather line. On any failure — offline, land, no survey coverage — the
 * line renders NOTHING at all rather than a "No data" apology: with weather
 * also active the chip then simply keeps its weather line, and with marine
 * alone the chip collapses to its coordinates line (the caller always
 * renders one), which is the honest answer over unsurveyed water.
 */
export function DepthPointLine({ at }: { at: LatLng }) {
  const installedPacks = useMarinePackStore((s) => s.installed);
  const { status, valueM, sourceLabel } = useDepthPointValue(at, installedPacks);
  const imperial = useSettingsStore((s) => s.units === 'imperial');

  if (status === 'error') return null;
  if (status !== 'ready' || valueM === null) return <MapPointLine text="…" />;
  return (
    <>
      <MapPointLine text={formatDepthReadout(valueM, imperial)} />
      {sourceLabel !== null && <MapPointLine text={sourceLabel} muted />}
    </>
  );
}

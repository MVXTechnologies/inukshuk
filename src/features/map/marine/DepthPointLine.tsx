import { formatDepthReadout } from '@core/geo/marineDepth';
import type { LatLng } from '@core/models';
import { useSettingsStore } from '@state/settingsStore';
import { MapPointLine } from '../components/MapPointChip';
import { useDepthPointValue } from './useDepthPointValue';

/**
 * The depth line of the tap-anywhere chip (marine wave D §D1): with marine
 * mode on, a tap shows the surveyed NONNA depth under the finger —
 * "Depth 26.5 m · chart datum" (drying heights read "Drying 3.8 m"). Feet
 * under imperial units.
 *
 * While the query is in flight the line shows an ellipsis, exactly like the
 * weather line. On any failure — offline, land, no survey coverage — the
 * line renders NOTHING at all rather than a "No data" apology: with weather
 * also active the chip then simply keeps its weather line, and with marine
 * alone the chip collapses to its coordinates line (the caller always
 * renders one), which is the honest answer over unsurveyed water.
 */
export function DepthPointLine({ at }: { at: LatLng }) {
  const { status, valueM } = useDepthPointValue(at);
  const imperial = useSettingsStore((s) => s.units === 'imperial');

  if (status === 'error') return null;
  return (
    <MapPointLine
      text={status === 'ready' && valueM !== null ? formatDepthReadout(valueM, imperial) : '…'}
    />
  );
}

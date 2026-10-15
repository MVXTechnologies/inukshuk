/**
 * The bearing from your fix to a point, as the bearing fields print it
 * (to a target, to the cursor).
 *
 * A bearing to a point you are standing on is noise: at a few metres, or
 * inside your fix's own error circle, the GPS jitter turns it at random
 * (QA 2.6.1: "Cursor 143° SE" beside "0 ft"). Below {@link bearingFloorM}
 * the field shows "—": the target is still there (so the field keeps its
 * place and says what it is to, unlike a field with no target, which steps
 * aside), only its direction is unknown, as ETE's "—" below walking speed.
 */
import { haversineMeters, initialBearingDeg } from '@core/geo/geomath';
import { trueToMagnetic } from '@core/geo/wmm';
import type { LatLng } from '@core/models';

import { bearingValue } from '../format';
import type { DepsSnapshot, StripFix, StripValue } from '../types';
import type { NorthReference } from './define';
import { declinationHere } from './position';

/** Closer than this, no bearing whatever the fix's accuracy, metres. */
export const MIN_BEARING_M = 3;

/** The distance under which a bearing from `fix` means nothing: 3 m, or the fix's accuracy if worse. */
export function bearingFloorM(fix: Pick<StripFix, 'accuracyM'>): number {
  const acc = fix.accuracyM;
  return acc !== null && Number.isFinite(acc) ? Math.max(MIN_BEARING_M, acc) : MIN_BEARING_M;
}

/** "042°" + "NE" (true) or "056°M" (magnetic) from you to `to`; "—" when too close to say. */
export function bearingFromYou(
  data: DepsSnapshot,
  you: StripFix,
  to: LatLng,
  reference: NorthReference,
): Pick<StripValue, 'value' | 'unit'> {
  if (haversineMeters(you, to) < bearingFloorM(you)) return { value: '—' };
  const trueDeg = initialBearingDeg(you, to);
  // A fix is in hand, so the declination is too; narrowed rather than asserted.
  const decl = reference === 'magnetic' ? declinationHere(data) : null;
  const deg = decl === null ? trueDeg : trueToMagnetic(trueDeg, decl);
  return bearingValue(deg, decl !== null);
}

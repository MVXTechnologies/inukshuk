import type { DestinationReadout } from '@core/geo/destination';
import { formatDistance, type Units } from '@core/format';
import type { LatLng } from '@core/models';
import { useMemo } from 'react';
import { NavCompass } from './NavCompass';
import type { FollowState } from './useFollowTrail';

/**
 * The bottom column's navigation row (#672/#678): the linear compass for
 * whichever navigation is on — a point (the destination pin) or a followed
 * trail — or nothing. Its own row, just above the ⓘ + scale row, so the
 * column (lifted by the recording panel's measured height) stacks it with
 * no overlap and leaves that row free for other chips.
 */
export function NavigationCompassRow({
  location,
  destination,
  follow,
  units,
}: {
  location: LatLng | null;
  /** The destination pin's live readout; null without a pin or a fix. */
  destination: DestinationReadout | null;
  follow: FollowState | null;
  units: Units;
}) {
  const readout = follow?.readout ?? null;
  const status = useMemo(
    () =>
      readout === null
        ? null
        : readout.onTrail
          ? { text: 'On trail', warn: false }
          : (() => {
              // Short on screen ("Off 120 m" fits the right block whole; the
              // longer "Off trail 1…" was cut), full for screen readers.
              const d = formatDistance(readout.crossTrackM, units);
              return { text: `Off ${d}`, warn: true, spoken: `Off trail, ${d}` };
            })(),
    [readout, units],
  );

  if (follow !== null) {
    if (readout === null || status === null) return null;
    return (
      <NavCompass
        location={location}
        targetBearingDeg={readout.targetBearingDeg}
        trailBearingDeg={readout.trailBearingDeg}
        distance={formatDistance(readout.targetDistanceM, units)}
        detail={`› ${readout.target.name}`}
        status={status}
      />
    );
  }
  if (destination === null) return null;
  return (
    <NavCompass
      location={location}
      targetBearingDeg={destination.bearingDeg}
      distance={destination.distance}
      detail={destination.bearing}
    />
  );
}

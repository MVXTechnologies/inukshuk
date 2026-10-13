import type { DestinationReadout } from '@core/geo/destination';
import { pointChipShiftX } from '@core/map/mapTap';
import type { LatLng } from '@core/models';
import type { CoordinateFormatter } from '@state/useCoordinateFormatter';
import { useEffect, useMemo, useState, type RefObject } from 'react';

/** What MapScreen's map ref offers here: its camera projection. */
interface Projector {
  project: (lngLat: [number, number]) => Promise<readonly [number, number] | null | undefined>;
}

export interface PointChipView {
  /** The readout as one sentence for screen readers. */
  label: string;
  /** Sideways slide of the bubble that keeps it on screen (px). */
  shiftX: number;
}

/**
 * The long-press point chip's presentation (2.5.1 QA): its spoken label
 * ("Point 46.81, -71.21, 120 m, 042° NE") and how far to slide it to stay
 * inside the screen margins near an edge (`pointChipShiftX`).
 *
 * The shift is measured ONCE per opened point, from the point's projected
 * position, not per camera move: a pan after opening moves the chip with
 * the map, as it always did. Per-tick cost: none.
 */
export function usePointChip({
  mapRef,
  mapSizeRef,
  mapLoaded,
  pointAt,
  pointReadout,
  formatCoords,
}: {
  mapRef: RefObject<Projector | null>;
  mapSizeRef: RefObject<{ width: number; height: number } | null>;
  mapLoaded: boolean;
  pointAt: LatLng | null;
  pointReadout: DestinationReadout | null;
  formatCoords: CoordinateFormatter;
}): PointChipView {
  const [shift, setShift] = useState<{ at: LatLng; x: number } | null>(null);
  useEffect(() => {
    // getViewState/project are gated on mapLoaded (native NPE before init).
    if (pointAt === null || !mapLoaded) return;
    let live = true;
    const width = mapSizeRef.current?.width ?? 0;
    void Promise.resolve(mapRef.current?.project([pointAt.longitude, pointAt.latitude]))
      .then((p) => {
        if (live && p != null) setShift({ at: pointAt, x: pointChipShiftX(p[0], width) });
      })
      .catch(() => undefined); // mid-teardown: no shift
    return () => {
      live = false;
    };
  }, [pointAt, mapLoaded, mapRef, mapSizeRef]);

  const label = useMemo(() => {
    if (pointAt === null) return '';
    const where = formatCoords(pointAt.latitude, pointAt.longitude);
    return pointReadout === null
      ? `Point ${where}`
      : `Point ${where}, ${pointReadout.distance}, ${pointReadout.bearing}`;
  }, [pointAt, pointReadout, formatCoords]);

  return { label, shiftX: shift !== null && shift.at === pointAt ? shift.x : 0 };
}

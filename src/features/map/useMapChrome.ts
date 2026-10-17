import { mapChromeAt, type MapChrome } from '@core/map/mapChrome';
import { useDisplayFactor } from '@ui/displayScale';
import { useMemo } from 'react';

/**
 * The map chrome's metrics at the user's Display size (#760): edge insets,
 * the rail's buttons and gap, the column axis the SOS button shares, and the
 * top-centre lane. Positions come from these, never from 100 % constants, so
 * nothing floats in a gap left over from another size.
 */
export function useMapChrome(): MapChrome {
  const factor = useDisplayFactor();
  return useMemo(() => mapChromeAt(factor), [factor]);
}

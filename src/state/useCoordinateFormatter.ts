import { useCallback } from 'react';

import {
  formatCoordinate,
  type CoordinateFormat,
  type FormatOptions,
} from '@core/convert/coordinateDisplay';

import { useSettingsStore } from './settingsStore';

/** Formats a WGS 84 position for display (and for copying, which must match). */
export type CoordinateFormatter = (
  latitude: number,
  longitude: number,
  opts?: FormatOptions,
) => string;

/**
 * THE app-wide coordinate formatter (#677): a position written in the format
 * chosen in Settings › Display › Coordinates (DD by default, DMS, DDM, UTM,
 * MGRS — see `@core/convert/coordinateDisplay`).
 *
 * Subscribed, so a screen re-labels the moment the setting flips; the
 * returned function's identity changes only then, so it is safe in memo and
 * effect dependencies. Copy what you show: format once, display that string
 * and put the same string on the clipboard.
 */
export function useCoordinateFormatter(): CoordinateFormatter {
  const fmt = useSettingsStore((s) => s.coordinateFormat);
  return useCallback(
    (latitude: number, longitude: number, opts?: FormatOptions) =>
      formatCoordinate(latitude, longitude, fmt, opts),
    [fmt],
  );
}

/** The same, read once (for event handlers outside a component render). */
export function formatCoordinateNow(
  latitude: number,
  longitude: number,
  opts?: FormatOptions,
): string {
  const fmt: CoordinateFormat = useSettingsStore.getState().coordinateFormat;
  return formatCoordinate(latitude, longitude, fmt, opts);
}

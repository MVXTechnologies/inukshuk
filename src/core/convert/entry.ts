/**
 * The cards' Convert hook: the one place a tide card turns what it shows into
 * the tool's prefilled request (`./prefill`), opened with
 * `openConvert(router, …)` (`@features/convert/openConvert`).
 *
 * Survey-mark cards use `prefillFromMark` directly. A tidal benchmark's card is
 * a survey-mark card: it converts the mark's published heights, never its
 * height above chart datum (the station's offsets are not on the mark, and
 * Convert refuses rather than guess them).
 */
import { cdKind, tideSourceAt } from '@core/tides/catalog';
import type { TideStation } from '@core/tides/station';
import { prefillFromTideStation, type ConvertRequest } from './prefill';

export type { ConvertRequest } from './prefill';

/** "us-coops" → "us", "ca-chs" → "ca". */
function countryOfSource(key: string | undefined): string | undefined {
  const c = key?.split('-')[0];
  return c && c.length === 2 ? c : undefined;
}

/** A tide station card → Convert on the station's chart datum. */
export function convertFromTideStation(s: TideStation): ConvertRequest {
  const src = tideSourceAt(s.source);
  const country = countryOfSource(src?.key);
  const cdLabel = cdKind(s.cdKind)?.label;
  return prefillFromTideStation({
    id: s.id,
    name: s.name,
    lat: s.lat,
    lng: s.lng,
    ...(src ? { agency: src.name } : {}),
    ...(country ? { country } : {}),
    ...(cdLabel ? { cdName: cdLabel === 'CD' ? 'Chart datum' : cdLabel } : {}),
    national: s.national,
  });
}

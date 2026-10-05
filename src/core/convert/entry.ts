/**
 * The Convert tool's entry hook (PLAN phases C–F, not built yet): the one
 * place a card turns what it shows into the tool's prefilled source, so the
 * cards need no change when Convert lands. Hidden behind
 * `CONVERT_ENABLED` (`@core/features/flags`) until then.
 *
 * The prefill carries the agency's published values verbatim (text) with
 * their system labels; Convert decides what it can do with them.
 */
import type { GeodeticMark } from '@core/geodetic/record';
import type { TideStation } from '@core/tides/station';

export interface ConvertPrefill {
  /** What the user tapped, for the tool's "From …" line. */
  label: string;
  lat: number;
  lng: number;
  /** A published height to convert, with its vertical system as published. */
  height?: { text: string; system: string };
  /** Chart-datum context (tide station or tidal benchmark). */
  chartDatum?: { station: string; kind: string; offsets: { datum: string; text: string }[] };
}

export function convertFromTideStation(s: TideStation): ConvertPrefill {
  return {
    label: `${s.name} (${s.id})`,
    lat: s.lat,
    lng: s.lng,
    chartDatum: { station: `${s.source}:${s.id}`, kind: s.cdKind, offsets: s.national },
  };
}

export function convertFromMark(m: GeodeticMark): ConvertPrefill {
  const out: ConvertPrefill = { label: m.id, lat: m.lat, lng: m.lng };
  if (m.tidal) {
    out.height = { text: m.tidal.cd, system: `chart datum (${m.tidal.cdKind})` };
    out.chartDatum = { station: m.tidal.station, kind: m.tidal.cdKind, offsets: [] };
  }
  return out;
}

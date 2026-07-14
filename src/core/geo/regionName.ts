/**
 * Naming logic for downloaded offline regions: picking a memorable place name
 * out of an OSM Nominatim reverse-geocoding payload, and de-duplicating labels
 * against the regions the user already has ("Sainte-Adèle" → "Sainte-Adèle 2").
 *
 * Pure: callers do the network fetch and pass the parsed JSON payload in.
 */

/**
 * The slice of a Nominatim `format=jsonv2` reverse response that naming reads.
 * (jsonv2 calls the OSM tag class `category`; the v1 format called it `class` —
 * both are accepted so a caller pinned to either format works.)
 */
interface NominatimReverse {
  name?: string;
  category?: string;
  class?: string;
  address?: Record<string, string>;
}

/** Settlement keys, most memorable first. Nominatim puts exactly the matching one in `address`. */
const SETTLEMENT_KEYS = ['village', 'town', 'city', 'hamlet', 'municipality'] as const;

/** Coarser fallbacks when the center is nowhere near a settlement. */
const AREA_KEYS = ['county', 'state_district', 'state'] as const;

/** OSM tag classes whose bearer is a named natural feature worth naming a map after. */
const NATURAL_CATEGORIES = new Set(['natural', 'water', 'waterway']);

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Narrow an unknown parsed payload to the fields we read, or null if it isn't object-shaped. */
function asNominatimReverse(payload: unknown): NominatimReverse | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  // A failed reverse lookup is a 200 with `{ "error": "Unable to geocode" }`.
  if ('error' in p) return null;
  const address =
    p.address !== null && typeof p.address === 'object'
      ? (p.address as Record<string, string>)
      : undefined;
  return {
    name: isNonEmptyString(p.name) ? p.name : undefined,
    category: isNonEmptyString(p.category) ? p.category : undefined,
    class: isNonEmptyString(p.class) ? p.class : undefined,
    address,
  };
}

/**
 * Picks the most memorable place name from a parsed Nominatim reverse-geocoding
 * payload (`format=jsonv2`, `zoom≈12`), or null when the payload has nothing
 * usable (error payloads, mid-ocean coordinates, junk).
 *
 * Preference order:
 * 1. The feature the center actually landed on, when it is a *named natural
 *    feature* (lake, river…): "Lac Tremblant" beats the nearest village.
 * 2. The nearest settlement: village → town → city → hamlet → municipality.
 * 3. Coarser admin areas: county → state district → state.
 */
export function pickNominatimName(payload: unknown): string | null {
  const r = asNominatimReverse(payload);
  if (r === null) return null;

  const category = r.category ?? r.class;
  if (category !== undefined && NATURAL_CATEGORIES.has(category) && r.name !== undefined) {
    return r.name.trim();
  }

  for (const keys of [SETTLEMENT_KEYS, AREA_KEYS] as const) {
    for (const key of keys) {
      const value = r.address?.[key];
      if (isNonEmptyString(value)) return value.trim();
    }
  }
  return null;
}

/**
 * De-duplicates a desired label against existing ones: returns `desired` when
 * free, else the first free "desired N" (N ≥ 2). Comparison is case-insensitive
 * and whitespace-trimmed, so "sainte-adèle" already existing yields
 * "Sainte-Adèle 2" rather than a visually-identical duplicate.
 */
export function dedupeLabel(desired: string, existing: readonly string[]): string {
  const base = desired.trim();
  const taken = new Set(existing.map((label) => label.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

import { formatLatLng } from '@core/geo/formatCoords';
import { parseLatLng } from '@core/geo/parseCoords';
import type { LatLng } from '@core/models';
import type { Place } from './place';

/** Fewer characters than this never reach the index. */
export const MIN_QUERY_LENGTH = 2;
/** Quiet time after the last keystroke before a query goes out. */
export const SEARCH_DEBOUNCE_MS = 250;
/** Results asked of the index; ranking and dedupe trim them to what is shown. */
export const SEARCH_FETCH_LIMIT = 15;

export type ClassifiedQuery =
  | { kind: 'empty' }
  | { kind: 'too-short'; text: string }
  | { kind: 'coordinates'; text: string; at: LatLng }
  | { kind: 'text'; text: string };

/**
 * What the user typed: nothing, too little, a coordinate (decimal, DDM or DMS
 * — the same strict grammar as the coordinates dialog), or a name to look up.
 */
export function classifyQuery(raw: string): ClassifiedQuery {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (text === '') return { kind: 'empty' };
  const at = parseLatLng(text);
  if (at !== null) return { kind: 'coordinates', text, at };
  if ([...text].length < MIN_QUERY_LENGTH) return { kind: 'too-short', text };
  return { kind: 'text', text };
}

/** The result row a coordinate query shows first. */
export function coordinatePlace(at: LatLng): Place {
  return {
    id: `coords:${at.latitude.toFixed(6)},${at.longitude.toFixed(6)}`,
    source: 'coordinates',
    type: 'coordinates',
    name: formatLatLng(at.latitude, at.longitude),
    latitude: at.latitude,
    longitude: at.longitude,
    context: 'Go to these coordinates',
  };
}

/**
 * The location bias sent with a query, rounded to 0.01° (≈ 1.1 km of latitude,
 * less of longitude away from the equator): enough to rank nearby places
 * first, too coarse to say which house the user is in.
 */
export function roundForPrivacy(at: LatLng): { lat: number; lon: number } {
  const r = (v: number) => Math.round(v * 100) / 100;
  return { lat: r(at.latitude), lon: r(at.longitude) };
}

/** Two-letter language for names: French or English, defaulting to English. */
export function searchLanguage(locale: string | null | undefined): 'fr' | 'en' {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/** Query string for our Worker's `GET /search`. */
export function searchQueryString(params: {
  text: string;
  lang: 'fr' | 'en';
  near: LatLng | null;
  limit?: number;
}): string {
  // Built by hand: React Native's URLSearchParams polyfill lacks `set`.
  const pairs: [string, string][] = [
    ['q', params.text],
    ['lang', params.lang],
    ['alt', params.lang === 'fr' ? 'en' : 'fr'],
    ['limit', String(params.limit ?? SEARCH_FETCH_LIMIT)],
  ];
  if (params.near !== null) {
    const { lat, lon } = roundForPrivacy(params.near);
    pairs.push(['lat', lat.toFixed(2)], ['lon', lon.toFixed(2)]);
  }
  return pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

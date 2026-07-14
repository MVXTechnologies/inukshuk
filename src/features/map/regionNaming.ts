import { pickNominatimName } from '@core/geo/regionName';
import * as Location from 'expo-location';

/**
 * Resolves a memorable place name for an offline-region center ("Sainte-Adèle",
 * "Lac Tremblant") at download time — the user is online then by definition.
 *
 * Primary: OSM Nominatim reverse geocoding (zoom 12 ≈ town level). Fallback:
 * the platform geocoder via expo-location. Both are bounded by a short timeout
 * and every failure path returns null — naming must never block or fail a
 * download; the caller keeps its placeholder label in that case.
 */

const TIMEOUT_MS = 5_000;

// Nominatim's usage policy requires an identifiable User-Agent with a way to
// reach the operator (https://operations.osmfoundation.org/policies/nominatim/).
const NOMINATIM_USER_AGENT =
  'Inukshuk-TrailApp/1.0 (offline trail navigation app; https://github.com/marcandrevigneault/inukshuk)';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

async function fetchNominatimName(lat: number, lng: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url =
      'https://nominatim.openstreetmap.org/reverse?format=jsonv2' +
      `&lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}&zoom=12`;
    const res = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return pickNominatimName((await res.json()) as unknown);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPlatformGeocoderName(lat: number, lng: number): Promise<string | null> {
  const results = await withTimeout(
    Location.reverseGeocodeAsync({ latitude: lat, longitude: lng }),
    TIMEOUT_MS,
  );
  const address = results[0];
  if (address === undefined) return null;
  return address.city ?? address.district ?? address.subregion ?? address.region ?? null;
}

/**
 * Best place name for the given region center, or null when neither geocoder
 * produced one. Never throws.
 */
export async function resolveRegionName(center: {
  lat: number;
  lng: number;
}): Promise<string | null> {
  const fromNominatim = await fetchNominatimName(center.lat, center.lng).catch(() => null);
  if (fromNominatim !== null) return fromNominatim;
  return fetchPlatformGeocoderName(center.lat, center.lng).catch(() => null);
}

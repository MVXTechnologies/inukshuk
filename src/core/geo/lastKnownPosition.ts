import type { LatLng } from '@core/models';

/**
 * Cold-start camera seeding + persistence throttling for the "last known map
 * position" (see `settingsStore.lastKnownPosition`).
 *
 * Without a persisted seed, MapLibre's camera defaults to [0, 0] ("null
 * island") on a cold launch until the first GPS fix — indoors or with a slow
 * fix the user stares at the Gulf of Guinea. These pure helpers decide what to
 * seed the camera with and when the position is worth another disk write.
 */

/** Minimum interval between periodic last-position writes while foregrounded.
 * settings.json writes are atomic but not free — never write per-fix. */
export const LAST_POSITION_WRITE_INTERVAL_MS = 60_000;

/**
 * Validate a persisted (or otherwise untrusted) last-known-position value.
 * Junk-tolerant like the rest of the settings migration: anything that isn't a
 * finite, in-range coordinate pair comes back as `null` (= "never saved"), and
 * unknown extra fields are dropped. Never throws.
 */
export function sanitizeLastKnownPosition(value: unknown): LatLng | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { latitude, longitude } = value as Record<string, unknown>;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude)) return null;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

/**
 * Resolve the camera's initial centre as `[lng, lat]` (MapLibre order).
 * Priority: live GPS fix → persisted last known position → `null` (let
 * MapLibre use its default — there is genuinely nothing better to show).
 */
export function resolveInitialCenter(
  live: LatLng | null,
  persisted: LatLng | null,
): [number, number] | null {
  const pos = live ?? persisted;
  return pos ? [pos.longitude, pos.latitude] : null;
}

/**
 * Throttle decision for the foreground write path: persist when the position
 * has never been written this session (`lastWriteAtMs === null`) or the
 * interval has elapsed. Backgrounding bypasses this (one write, always fresh).
 */
export function shouldPersistPosition(
  lastWriteAtMs: number | null,
  nowMs: number,
  intervalMs: number = LAST_POSITION_WRITE_INTERVAL_MS,
): boolean {
  return lastWriteAtMs === null || nowMs - lastWriteAtMs >= intervalMs;
}

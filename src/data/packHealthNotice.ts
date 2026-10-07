import { readJson, writeJson } from './storage';

/**
 * The offline maps the "needs updating" notice last told the user about
 * (sorted group ids — `offlinePackGroup`). Persisted so the notice speaks
 * once per new stale map, not on every cold start.
 */
const ANNOUNCED_FILE = 'offline-stale-announced.json';

export async function readAnnouncedStale(): Promise<string[]> {
  const value = await readJson<unknown>(ANNOUNCED_FILE);
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export async function saveAnnouncedStale(ids: readonly string[]): Promise<void> {
  writeJson(ANNOUNCED_FILE, [...ids].sort());
}

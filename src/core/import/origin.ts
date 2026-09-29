/**
 * Where an imported trail came from (#432/#435): the persisted `origin` on a
 * track, its total sanitizer, and the small queries the Library and Settings
 * ask of it (the source mark, the "From Strava" chip, disconnect cleanup).
 */

import type { ActivitySourceId, TrackOrigin } from './sources';

export const ACTIVITY_SOURCE_IDS: readonly ActivitySourceId[] = [
  'strava',
  'apple-health',
  'health-connect',
];

export function isActivitySourceId(value: unknown): value is ActivitySourceId {
  return typeof value === 'string' && (ACTIVITY_SOURCE_IDS as readonly string[]).includes(value);
}

/** Longest external id kept (Strava ids and UUIDs are far shorter). */
const MAX_EXTERNAL_ID = 200;

/**
 * A persisted origin, or undefined when it is missing or junk. Never throws:
 * a torn index must not take the trail down with it — the trail simply loses
 * its source mark.
 */
export function sanitizeTrackOrigin(raw: unknown): TrackOrigin | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { source, externalId } = raw as Record<string, unknown>;
  if (!isActivitySourceId(source)) return undefined;
  let id: string;
  if (typeof externalId === 'string') id = externalId.trim();
  else if (typeof externalId === 'number' && Number.isFinite(externalId)) id = String(externalId);
  else return undefined;
  if (id === '' || id.length > MAX_EXTERNAL_ID) return undefined;
  return { source, externalId: id };
}

/** One string per origin, for set membership ("already imported?"). */
export function originKey(origin: TrackOrigin): string {
  return `${origin.source}:${origin.externalId}`;
}

/** The name people know the source by. */
export function sourceLabel(source: ActivitySourceId): string {
  switch (source) {
    case 'strava':
      return 'Strava';
    case 'apple-health':
      return 'Apple Health';
    case 'health-connect':
      return 'Health Connect';
  }
}

interface HasOrigin {
  origin?: TrackOrigin;
}

/** How many trails came from each source (sources with none are absent). */
export function countBySource(
  tracks: readonly HasOrigin[],
): Partial<Record<ActivitySourceId, number>> {
  const out: Partial<Record<ActivitySourceId, number>> = {};
  for (const t of tracks) {
    if (!t.origin) continue;
    out[t.origin.source] = (out[t.origin.source] ?? 0) + 1;
  }
  return out;
}

/** The trails imported from `source`. */
export function tracksFromSource<T extends HasOrigin>(
  tracks: readonly T[],
  source: ActivitySourceId,
): T[] {
  return tracks.filter((t) => t.origin?.source === source);
}

/** Keys of every origin in the library, for the importer's "already here" check. */
export function originKeys(tracks: readonly HasOrigin[]): Set<string> {
  const out = new Set<string>();
  for (const t of tracks) if (t.origin) out.add(originKey(t.origin));
  return out;
}

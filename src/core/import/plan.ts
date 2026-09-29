/**
 * Planning a connected-source import (#432/#435), before any route is
 * fetched: what the listing holds that is new, what is already in the
 * Library, and what has nothing to draw. Also the range choices the Import
 * sheet offers and the words it says about them. Pure — the importer
 * (`features/import/runSourceImport`) and the sheet share it.
 */

import { DuplicateIndex, type ActivityFingerprint } from '@core/geo/activityFiles/dedupe';
import { localDate } from '@core/geo/activityFiles/naming';

import { originKey, originKeys, sourceLabel } from './origin';
import type { ActivitySourceId, ImportRange, RemoteActivity, TrackOrigin } from './sources';

/** What the planner needs to know about a Library trail. */
export interface LibraryTrackRef {
  origin?: TrackOrigin;
  startedAt: number;
  stats: { distanceM: number };
}

export interface ImportPlan {
  /** New activities with a route to fetch, newest first. */
  toFetch: RemoteActivity[];
  /** Listed activities already in the Library (same origin, or same start + distance). */
  alreadyHere: number;
  /** Listed activities the source says have no route (manual, indoor). */
  noGps: number;
}

/** A Library trail's duplicate fingerprint. */
export function fingerprintOf(track: LibraryTrackRef): ActivityFingerprint {
  return { startedAt: track.startedAt, distanceM: track.stats.distanceM };
}

/** A duplicate index seeded with every Library trail. */
export function libraryDuplicateIndex(library: readonly LibraryTrackRef[]): DuplicateIndex {
  return new DuplicateIndex(library.map(fingerprintOf));
}

/**
 * Sort a listing into what to fetch and what to skip.
 *
 * - An activity whose origin is already in the Library is "already here",
 *   whatever it looks like now — this is what makes a resumed import (or an
 *   overlapping "since last import") idempotent.
 * - One with the same start (±60 s) and distance (±2 %) as a Library trail —
 *   the same run recorded here, or imported from a file — is "already here"
 *   too. A listing with no distance (0) can't be matched here; the importer
 *   checks again once the route gives it one.
 * - One the source knows has no route is "no GPS".
 * - The same activity listed twice counts once.
 *
 * `only`, when given, restricts the plan to those external ids (a resumed
 * job's remaining work); everything else in the listing is ignored outright.
 */
export function planImport(
  listed: readonly RemoteActivity[],
  library: readonly LibraryTrackRef[],
  only?: ReadonlySet<string>,
): ImportPlan {
  const seen = originKeys(library);
  const index = libraryDuplicateIndex(library);
  const toFetch: RemoteActivity[] = [];
  let alreadyHere = 0;
  let noGps = 0;
  const listedKeys = new Set<string>();
  for (const activity of listed) {
    const key = originKey(activity.origin);
    if (listedKeys.has(key)) continue;
    listedKeys.add(key);
    if (only && !only.has(activity.origin.externalId)) continue;
    if (seen.has(key)) {
      alreadyHere += 1;
    } else if (!activity.hasRoute) {
      noGps += 1;
    } else if (
      activity.distanceM > 0 &&
      index.has({ startedAt: activity.startedAt, distanceM: activity.distanceM })
    ) {
      alreadyHere += 1;
    } else {
      toFetch.push(activity);
    }
  }
  toFetch.sort((a, b) => b.startedAt - a.startedAt);
  return { toFetch, alreadyHere, noGps };
}

/** The imported trail's name: the source's, else "<Sport> <local date>". */
export function remoteActivityName(activity: RemoteActivity): string {
  const explicit = activity.name?.trim();
  if (explicit) return explicit;
  const label = activity.sportLabel?.trim() || 'Activity';
  return `${label} ${localDate(activity.startedAt)}`;
}

// --- the Import sheet's range choices ---------------------------------------

export type RangeChoice = 'since-last' | 'last-30' | 'everything';

export const RANGE_CHOICES: readonly { id: RangeChoice; label: string }[] = [
  { id: 'since-last', label: 'Since last import' },
  { id: 'last-30', label: 'Last 30 days' },
  { id: 'everything', label: 'Everything' },
];

/**
 * "Since last import" reaches this far before the last import: an activity
 * recorded before it but synced to the source after it (a watch that synced
 * late) would otherwise never be seen. Overlap costs nothing — what is
 * already here is skipped.
 */
export const LATE_SYNC_MARGIN_MS = 3 * 86_400_000;

/** The range a choice means. "Since last import" with no import yet is everything. */
export function resolveRange(choice: RangeChoice, lastImportAt: number | null): ImportRange {
  switch (choice) {
    case 'since-last':
      return lastImportAt === null
        ? { kind: 'everything' }
        : { kind: 'since', after: Math.max(0, lastImportAt - LATE_SYNC_MARGIN_MS) };
    case 'last-30':
      return { kind: 'last-days', days: 30 };
    case 'everything':
      return { kind: 'everything' };
  }
}

/** Past this many new Strava activities, "Everything" warns that it takes a while. */
export const STRAVA_SLOW_IMPORT_THRESHOLD = 300;

/** Whether the sheet adds the "Strava imports take a while" heads-up. */
export function showsSlowImportNote(
  source: ActivitySourceId,
  choice: RangeChoice,
  count: number,
): boolean {
  return source === 'strava' && choice === 'everything' && count > STRAVA_SLOW_IMPORT_THRESHOLD;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "12 Sep" (day before month, like the mockup), in local time. Spelled out
 * by hand: engines disagree on short months ("Sep" / "Sept").
 */
export function dayMonth(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ''}`.trim();
}

/**
 * The sheet's preview line, as a bold lead and the rest:
 * **41 new activities** since 12 Sep. Indoor workouts and ones already in
 * your Library are skipped.
 */
export function importPreviewText(args: {
  count: number;
  source: ActivitySourceId;
  choice: RangeChoice;
  lastImportAt: number | null;
}): { lead: string; rest: string } {
  const { count, source, choice, lastImportAt } = args;
  const lead =
    count === 0
      ? 'Nothing new'
      : `${count.toLocaleString('en-US')} new ${count === 1 ? 'activity' : 'activities'}`;
  let when: string;
  if (choice === 'last-30') when = ' in the last 30 days';
  else if (choice === 'since-last' && lastImportAt !== null) {
    when = ` since ${dayMonth(lastImportAt)}`;
  } else when = ` in your ${sourceLabel(source)} history`;
  const skipped =
    source === 'strava'
      ? 'Indoor workouts and ones already in your Library are skipped.'
      : 'Workouts without a route and ones already in your Library are skipped.';
  return { lead, rest: `${when}. ${skipped}` };
}

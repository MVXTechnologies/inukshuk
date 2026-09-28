import { healthConnectSport } from '@core/health/activityTypes';
import {
  HEALTH_CONNECT_INSTALL_URL,
  HEALTH_CONNECT_MIN_API,
  healthConnectAvailability,
  type HealthAvailability,
} from '@core/health/availability';
import {
  hasHealthConnectPermission,
  healthConnectOutcome,
  type HealthPermissionOutcome,
} from '@core/health/permissions';
import {
  classifyHealthConnectRoute,
  healthConnectRouteToActivityRoute,
  type HealthConnectLocation,
} from '@core/health/routes';
import type { ActivityRoute, ActivitySource, RemoteActivity } from '@core/import/sources';
import { Linking, Platform } from 'react-native';
import {
  aggregateRecord,
  getGrantedPermissions,
  getSdkStatus,
  initialize,
  readRecord,
  readRecords,
  requestExerciseRoute,
  requestPermission,
  type Permission,
  type ReadHealthDataHistoryPermission,
} from 'react-native-health-connect';

import { throwIfAborted } from './abort';

/**
 * Health Connect as an import source — read-only: exercise sessions, their
 * routes, and a distance total. Android only; `./platform.android.ts` is the
 * only importer (the library's JS entry resolves a TurboModule eagerly, so it
 * must never be evaluated on iOS). All mapping is pure in `@core/health/*`.
 *
 * Routes recorded by OTHER apps come back as "consent required" unless the
 * user granted all-routes access; `fetchRoute` then shows Health Connect's
 * per-session route dialog, which needs the app in the foreground.
 */

const READ_EXERCISE: Permission = { accessType: 'read', recordType: 'ExerciseSession' };
const READ_DISTANCE: Permission = { accessType: 'read', recordType: 'Distance' };
const READ_HISTORY: ReadHealthDataHistoryPermission = {
  accessType: 'read',
  recordType: 'ReadHealthDataHistory',
};
const REQUESTED = [READ_EXERCISE, READ_DISTANCE, READ_HISTORY];

/** Sessions per page: routes can ride along inline, so keep pages modest. */
const PAGE_SIZE = 50;

let initialized: Promise<boolean> | null = null;

function ensureInitialized(): Promise<boolean> {
  initialized ??= initialize().catch(() => {
    initialized = null;
    return false;
  });
  return initialized;
}

/** For tests: forget the memoized client. */
export function resetHealthConnectForTests(): void {
  initialized = null;
}

function apiLevel(): number {
  return typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
}

export function healthConnectSupportedOs(): boolean {
  return Platform.OS === 'android' && apiLevel() >= HEALTH_CONNECT_MIN_API;
}

export async function healthConnectAvailabilityNow(): Promise<HealthAvailability> {
  if (!healthConnectSupportedOs()) return 'unavailable';
  try {
    return healthConnectAvailability(await getSdkStatus());
  } catch {
    return 'unavailable';
  }
}

/** Open the Play Store on Health Connect (for `needs-install`). */
export async function openHealthConnectInstall(): Promise<void> {
  await Linking.openURL(HEALTH_CONNECT_INSTALL_URL);
}

/**
 * Show Health Connect's permission screen for exercise, distance and full
 * history. `partial` when exercise was granted without distance or history
 * (distances read as 0; only the last 30 days before the first grant are
 * readable).
 */
export async function requestHealthConnectPermissions(): Promise<HealthPermissionOutcome> {
  if ((await healthConnectAvailabilityNow()) !== 'available') return 'denied';
  if (!(await ensureInitialized())) return 'denied';
  try {
    const granted = await requestPermission(REQUESTED);
    return healthConnectOutcome(REQUESTED, granted, READ_EXERCISE);
  } catch {
    return 'denied';
  }
}

async function canReadDistance(): Promise<boolean> {
  try {
    return hasHealthConnectPermission(await getGrantedPermissions(), READ_DISTANCE);
  } catch {
    return false;
  }
}

async function sessionDistanceM(startTime: string, endTime: string): Promise<number> {
  try {
    const agg = await aggregateRecord({
      recordType: 'Distance',
      timeRangeFilter: { operator: 'between', startTime, endTime },
    });
    const m = agg.DISTANCE?.inMeters;
    return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : 0;
  } catch {
    return 0;
  }
}

const EMPTY: ActivityRoute = { points: [], segmentStarts: [] };

export const healthConnectSource: ActivitySource = {
  id: 'health-connect',

  async list(since, signal) {
    throwIfAborted(signal);
    if (!(await ensureInitialized())) return [];
    const withDistance = await canReadDistance();
    const out: RemoteActivity[] = [];
    let pageToken: string | undefined;
    do {
      throwIfAborted(signal);
      const page = await readRecords('ExerciseSession', {
        timeRangeFilter: { operator: 'after', startTime: new Date(since).toISOString() },
        ascendingOrder: false,
        pageSize: PAGE_SIZE,
        pageToken,
      });
      for (const s of page.records) {
        const id = s.metadata?.id;
        const startedAt = Date.parse(s.startTime);
        if (!id || !Number.isFinite(startedAt) || startedAt < since) continue;
        const sport = healthConnectSport(s.exerciseType);
        const title = s.title?.trim();
        out.push({
          origin: { source: 'health-connect', externalId: id },
          name: title ? title : undefined,
          category: sport.category,
          sportLabel: sport.label,
          startedAt,
          distanceM: withDistance ? await sessionDistanceM(s.startTime, s.endTime) : 0,
          hasRoute: classifyHealthConnectRoute(s.exerciseRoute) !== 'no-data',
        });
      }
      pageToken = page.pageToken || undefined;
    } while (pageToken);
    out.sort((a, b) => b.startedAt - a.startedAt);
    return out;
  },

  async fetchRoute(activity, signal) {
    throwIfAborted(signal);
    if (!(await ensureInitialized())) return EMPTY;
    const id = activity.origin.externalId;
    const session = await readRecord('ExerciseSession', id);
    throwIfAborted(signal);
    switch (classifyHealthConnectRoute(session.exerciseRoute)) {
      case 'data':
        return healthConnectRouteToActivityRoute(
          session.exerciseRoute?.route as HealthConnectLocation[] | undefined,
        );
      case 'consent-required':
        try {
          // System dialog, foreground only; rejects when the user declines.
          const route = await requestExerciseRoute(id);
          return healthConnectRouteToActivityRoute(route as HealthConnectLocation[]);
        } catch {
          return EMPTY;
        }
      default:
        return EMPTY;
    }
  },
};

import { appleWorkoutMayHaveRoute, appleWorkoutSport } from '@core/health/activityTypes';
import type { HealthPermissionOutcome } from '@core/health/permissions';
import {
  appleLocationToPoint,
  appleWorkoutPauses,
  quantityToMetres,
  stitchRoutes,
} from '@core/health/routes';
import type { ActivityRoute, ActivitySource, RemoteActivity } from '@core/import/sources';
import type { TrackPoint } from '@core/models';
import {
  WorkoutRouteTypeIdentifier,
  WorkoutTypeIdentifier,
  isHealthDataAvailable,
  queryWorkoutSamples,
  requestAuthorization,
} from '@kingstinct/react-native-healthkit';

import { throwIfAborted } from './abort';

/**
 * Apple Health (HealthKit) as an import source — read-only: workouts and
 * their GPS routes, never a write. iOS only; `./platform.ios.ts` is the only
 * importer, so Android bundles never include this file. All mapping is pure
 * in `@core/health/*`.
 *
 * HealthKit never tells an app whether READ access was granted (a denial
 * looks exactly like an empty store), so a declined sheet surfaces as "no
 * workouts found", not as an error.
 */

const READ_TYPES = [WorkoutTypeIdentifier, WorkoutRouteTypeIdentifier] as const;

/** False on devices without HealthKit (most iPads before iPadOS 17). */
export function appleHealthAvailable(): boolean {
  try {
    return isHealthDataAvailable();
  } catch {
    return false;
  }
}

/**
 * Show the Health read sheet (workouts + workout routes). Resolves `granted`
 * once the sheet was presented or already answered — HealthKit hides the
 * read decision itself — and `denied` when HealthKit refused the request.
 */
export async function requestAppleHealthPermissions(): Promise<HealthPermissionOutcome> {
  if (!appleHealthAvailable()) return 'denied';
  try {
    const ok = await requestAuthorization({ toRead: READ_TYPES });
    return ok ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

export const appleHealthSource: ActivitySource = {
  id: 'apple-health',

  async list(since, signal) {
    throwIfAborted(signal);
    const workouts = await queryWorkoutSamples({
      limit: 0,
      ascending: false,
      filter: { date: { startDate: new Date(since), strictStartDate: true } },
    });
    throwIfAborted(signal);
    const out: RemoteActivity[] = [];
    for (const w of workouts) {
      const sport = appleWorkoutSport(w.workoutActivityType);
      const startedAt = w.startDate.getTime();
      if (startedAt >= since) {
        out.push({
          origin: { source: 'apple-health', externalId: w.uuid },
          category: sport.category,
          sportLabel: sport.label,
          startedAt,
          distanceM: quantityToMetres(w.totalDistance),
          hasRoute: appleWorkoutMayHaveRoute(w.workoutActivityType, w.metadata?.HKIndoorWorkout),
        });
      }
      // Proxies pin their HKWorkout natively; release them eagerly.
      w.dispose();
    }
    out.sort((a, b) => b.startedAt - a.startedAt);
    return out;
  },

  async fetchRoute(activity, signal): Promise<ActivityRoute> {
    throwIfAborted(signal);
    const [workout] = await queryWorkoutSamples({
      limit: 1,
      filter: { uuid: activity.origin.externalId },
    });
    if (!workout) return { points: [], segmentStarts: [] };
    try {
      const routes = await workout.getWorkoutRoutes();
      throwIfAborted(signal);
      const tracks = routes.map((r) => {
        const pts: TrackPoint[] = [];
        for (const loc of r.locations) {
          const p = appleLocationToPoint(loc);
          if (p) pts.push(p);
        }
        return pts;
      });
      return stitchRoutes(tracks, appleWorkoutPauses(workout.events));
    } finally {
      workout.dispose();
    }
  },
};

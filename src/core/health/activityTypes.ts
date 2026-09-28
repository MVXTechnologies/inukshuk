/**
 * Health-store activity types → our categories (`@core/library/categories`)
 * and a human label for the importer's fallback name ("Hike 12 Sep").
 *
 * The codes are the platforms' own integers, copied here so core stays pure
 * (no native package import):
 *
 * - Apple: `HKWorkoutActivityType` raw values, as exposed by
 *   `@kingstinct/react-native-healthkit`'s `WorkoutActivityType` enum.
 * - Health Connect: `ExerciseSessionRecord.EXERCISE_TYPE_*`, as exposed by
 *   `react-native-health-connect`'s `ExerciseType` constants.
 *
 * Neither store has a trail-run type (both call it running) and HealthKit has
 * no snowshoe type (Apple files it under "snow sports").
 */

export interface HealthSport {
  /** Built-in category id, when the sport maps to one. */
  category?: string;
  /** Human label ("Cross-Country Ski"). */
  label: string;
}

// --- Apple Health ------------------------------------------------------------

/** HKWorkoutActivityType raw values we name or reason about. */
export const HK = {
  cycling: 13,
  elliptical: 16,
  functionalStrengthTraining: 20,
  hiking: 24,
  mindAndBody: 29,
  paddleSports: 31,
  preparationAndRecovery: 33,
  rowing: 35,
  running: 37,
  sailing: 38,
  skatingSports: 39,
  snowSports: 40,
  surfingSports: 45,
  swimming: 46,
  traditionalStrengthTraining: 50,
  walking: 52,
  yoga: 57,
  barre: 58,
  coreTraining: 59,
  crossCountrySkiing: 60,
  downhillSkiing: 61,
  flexibility: 62,
  pilates: 66,
  snowboarding: 67,
  stepTraining: 69,
  wheelchairWalkPace: 70,
  wheelchairRunPace: 71,
  handCycling: 74,
  cooldown: 80,
  swimBikeRun: 82,
  other: 3000,
} as const;

const APPLE_SPORTS: ReadonlyMap<number, HealthSport> = new Map<number, HealthSport>([
  [HK.running, { category: 'run', label: 'Run' }],
  [HK.hiking, { category: 'hike', label: 'Hike' }],
  [HK.walking, { category: 'walk', label: 'Walk' }],
  [HK.cycling, { category: 'bike', label: 'Ride' }],
  [HK.handCycling, { category: 'bike', label: 'Hand Cycle' }],
  [HK.downhillSkiing, { category: 'ski', label: 'Ski' }],
  [HK.crossCountrySkiing, { category: 'ski', label: 'Cross-Country Ski' }],
  [HK.snowboarding, { label: 'Snowboard' }],
  [HK.snowSports, { label: 'Snow Sports' }],
  [HK.paddleSports, { label: 'Paddle' }],
  [HK.rowing, { label: 'Row' }],
  [HK.sailing, { label: 'Sail' }],
  [HK.skatingSports, { label: 'Skate' }],
  [HK.surfingSports, { label: 'Surf' }],
  [HK.swimming, { label: 'Swim' }],
  [HK.swimBikeRun, { label: 'Multisport' }],
  [HK.wheelchairWalkPace, { label: 'Wheelchair' }],
  [HK.wheelchairRunPace, { label: 'Wheelchair' }],
]);

/**
 * Workout types that never carry a route: gym and studio work. A workout of
 * any other type may or may not have one — only fetching tells.
 */
const APPLE_INDOOR_ONLY: ReadonlySet<number> = new Set<number>([
  HK.elliptical,
  HK.functionalStrengthTraining,
  HK.traditionalStrengthTraining,
  HK.mindAndBody,
  HK.preparationAndRecovery,
  HK.yoga,
  HK.barre,
  HK.coreTraining,
  HK.flexibility,
  HK.pilates,
  HK.stepTraining,
  HK.cooldown,
]);

/** Category + label for an `HKWorkoutActivityType`. Unknown types are "Workout". */
export function appleWorkoutSport(activityType: number): HealthSport {
  return APPLE_SPORTS.get(activityType) ?? { label: 'Workout' };
}

/**
 * Cheap "might there be a route?" for a HealthKit workout, from what the list
 * query already returned: false for gym types and for workouts flagged
 * `HKIndoorWorkout` (treadmill run, indoor cycle, pool swim). True otherwise —
 * an empty route fetch still counts as "no GPS" downstream.
 */
export function appleWorkoutMayHaveRoute(activityType: number, indoor: unknown): boolean {
  if (indoor === true || indoor === 1) return false;
  return !APPLE_INDOOR_ONLY.has(activityType);
}

// --- Health Connect ----------------------------------------------------------

/** `ExerciseSessionRecord.EXERCISE_TYPE_*` values we name. */
export const HC = {
  BIKING: 8,
  BIKING_STATIONARY: 9,
  HIKING: 37,
  ICE_SKATING: 39,
  PADDLING: 46,
  ROWING: 53,
  RUNNING: 56,
  RUNNING_TREADMILL: 57,
  SAILING: 58,
  SKATING: 60,
  SKIING: 61,
  SNOWBOARDING: 62,
  SNOWSHOEING: 63,
  SURFING: 72,
  SWIMMING_OPEN_WATER: 73,
  WALKING: 79,
  WHEELCHAIR: 82,
} as const;

const HC_SPORTS: ReadonlyMap<number, HealthSport> = new Map<number, HealthSport>([
  [HC.RUNNING, { category: 'run', label: 'Run' }],
  [HC.RUNNING_TREADMILL, { category: 'run', label: 'Treadmill Run' }],
  [HC.HIKING, { category: 'hike', label: 'Hike' }],
  [HC.WALKING, { category: 'walk', label: 'Walk' }],
  [HC.BIKING, { category: 'bike', label: 'Ride' }],
  [HC.BIKING_STATIONARY, { category: 'bike', label: 'Indoor Ride' }],
  [HC.SKIING, { category: 'ski', label: 'Ski' }],
  [HC.SNOWSHOEING, { category: 'snowshoe', label: 'Snowshoe' }],
  [HC.SNOWBOARDING, { label: 'Snowboard' }],
  [HC.PADDLING, { label: 'Paddle' }],
  [HC.ROWING, { label: 'Row' }],
  [HC.SAILING, { label: 'Sail' }],
  [HC.SKATING, { label: 'Skate' }],
  [HC.ICE_SKATING, { label: 'Ice Skate' }],
  [HC.SURFING, { label: 'Surf' }],
  [HC.SWIMMING_OPEN_WATER, { label: 'Open-Water Swim' }],
  [HC.WHEELCHAIR, { label: 'Wheelchair' }],
]);

/** Category + label for a Health Connect exercise type. Unknown types are "Workout". */
export function healthConnectSport(exerciseType: number): HealthSport {
  return HC_SPORTS.get(exerciseType) ?? { label: 'Workout' };
}

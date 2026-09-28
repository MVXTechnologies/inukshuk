import {
  HC,
  HK,
  appleWorkoutMayHaveRoute,
  appleWorkoutSport,
  healthConnectSport,
} from './activityTypes';

describe('appleWorkoutSport', () => {
  it.each([
    [HK.running, 'run', 'Run'],
    [HK.hiking, 'hike', 'Hike'],
    [HK.walking, 'walk', 'Walk'],
    [HK.cycling, 'bike', 'Ride'],
    [HK.downhillSkiing, 'ski', 'Ski'],
    [HK.crossCountrySkiing, 'ski', 'Cross-Country Ski'],
  ])('maps %i to %s', (type, category, label) => {
    expect(appleWorkoutSport(type)).toEqual({ category, label });
  });

  it('labels sports without a category', () => {
    expect(appleWorkoutSport(HK.paddleSports)).toEqual({ label: 'Paddle' });
    expect(appleWorkoutSport(HK.snowSports).category).toBeUndefined();
  });

  it('falls back to "Workout" for unknown and generic types', () => {
    expect(appleWorkoutSport(HK.other)).toEqual({ label: 'Workout' });
    expect(appleWorkoutSport(-1)).toEqual({ label: 'Workout' });
  });
});

describe('appleWorkoutMayHaveRoute', () => {
  it('is true for outdoor-capable types', () => {
    expect(appleWorkoutMayHaveRoute(HK.hiking, undefined)).toBe(true);
    expect(appleWorkoutMayHaveRoute(HK.other, false)).toBe(true);
  });

  it('is false for workouts flagged indoor', () => {
    expect(appleWorkoutMayHaveRoute(HK.running, true)).toBe(false);
    expect(appleWorkoutMayHaveRoute(HK.cycling, 1)).toBe(false);
  });

  it('is false for gym and studio types', () => {
    expect(appleWorkoutMayHaveRoute(HK.yoga, undefined)).toBe(false);
    expect(appleWorkoutMayHaveRoute(HK.traditionalStrengthTraining, undefined)).toBe(false);
  });
});

describe('healthConnectSport', () => {
  it.each([
    [HC.RUNNING, 'run'],
    [HC.HIKING, 'hike'],
    [HC.WALKING, 'walk'],
    [HC.BIKING, 'bike'],
    [HC.SKIING, 'ski'],
    [HC.SNOWSHOEING, 'snowshoe'],
  ])('maps %i to %s', (type, category) => {
    expect(healthConnectSport(type).category).toBe(category);
  });

  it('labels uncategorized sports and falls back to "Workout"', () => {
    expect(healthConnectSport(HC.PADDLING)).toEqual({ label: 'Paddle' });
    expect(healthConnectSport(0)).toEqual({ label: 'Workout' });
  });
});

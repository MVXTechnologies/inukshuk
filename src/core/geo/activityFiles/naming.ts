/**
 * Sport → library category and default track names for imported activities.
 * Sport keys are the normalized ones produced by the FIT/TCX readers
 * (`running`, `trail_running`, `cycling`, …) or by {@link stravaTypeToSport}.
 */

const SPORT_CATEGORY: Record<string, string> = {
  running: 'run',
  treadmill_running: 'run',
  trail_running: 'trail-run',
  cycling: 'bike',
  mountain_biking: 'bike',
  e_biking: 'bike',
  hiking: 'hike',
  mountaineering: 'hike',
  walking: 'walk',
  cross_country_skiing: 'ski',
  backcountry_skiing: 'ski',
  alpine_skiing: 'ski',
  snowboarding: 'ski',
  snowshoeing: 'snowshoe',
};

const SPORT_LABEL: Record<string, string> = {
  running: 'Run',
  treadmill_running: 'Run',
  trail_running: 'Trail Run',
  cycling: 'Ride',
  mountain_biking: 'Mountain Bike Ride',
  e_biking: 'E-Bike Ride',
  hiking: 'Hike',
  mountaineering: 'Mountaineering',
  walking: 'Walk',
  cross_country_skiing: 'Nordic Ski',
  backcountry_skiing: 'Backcountry Ski',
  alpine_skiing: 'Alpine Ski',
  snowboarding: 'Snowboard',
  snowshoeing: 'Snowshoe',
  swimming: 'Swim',
  paddling: 'Paddle',
  kayaking: 'Kayak',
  rowing: 'Row',
  inline_skating: 'Inline Skate',
  rock_climbing: 'Climb',
  stand_up_paddleboarding: 'Stand Up Paddle',
};

/** Strava activity types (CSV `Activity Type`) that differ from a plain slug. */
const STRAVA_TYPES: Record<string, string> = {
  run: 'running',
  'trail run': 'trail_running',
  'virtual run': 'treadmill_running',
  ride: 'cycling',
  'virtual ride': 'cycling',
  'gravel ride': 'cycling',
  'mountain bike ride': 'mountain_biking',
  'e-bike ride': 'e_biking',
  'e-mountain bike ride': 'e_biking',
  hike: 'hiking',
  walk: 'walking',
  'nordic ski': 'cross_country_skiing',
  'backcountry ski': 'backcountry_skiing',
  'alpine ski': 'alpine_skiing',
  snowboard: 'snowboarding',
  snowshoe: 'snowshoeing',
  swim: 'swimming',
  kayaking: 'kayaking',
  rowing: 'rowing',
};

/** Normalize a Strava activity type to a sport key. */
export function stravaTypeToSport(type: string): string {
  const t = type.trim().toLowerCase();
  return STRAVA_TYPES[t] ?? t.replace(/[\s-]+/g, '_');
}

/** The built-in category for a sport key, or undefined (leave uncategorized). */
export function categoryForSport(sport: string | undefined): string | undefined {
  return sport === undefined ? undefined : SPORT_CATEGORY[sport];
}

/** Human label for a sport key, or undefined for generic/unknown sports. */
export function sportLabel(sport: string | undefined): string | undefined {
  return sport === undefined ? undefined : SPORT_LABEL[sport];
}

/** `YYYY-MM-DD` in the device's local time zone. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Strip archive folders and activity extensions (`a/b/123.fit.gz` → `123`). */
export function baseNameOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.(fit|tcx|gpx)(\.gz)?$/i, '').replace(/\.gz$/i, '');
}

/**
 * Track name: the explicit name (Strava CSV, GPX/TCX metadata) when present,
 * else "<Sport> <local date>" (e.g. "Run 2026-09-12"), else the file name.
 */
export function activityTrackName(args: {
  name?: string;
  sport?: string;
  startTime?: number;
  fileName?: string;
}): string {
  const explicit = args.name?.trim();
  if (explicit) return explicit;
  const label = sportLabel(args.sport);
  if (label && args.startTime !== undefined && Number.isFinite(args.startTime)) {
    return `${label} ${localDate(args.startTime)}`;
  }
  const file = args.fileName ? baseNameOf(args.fileName).trim() : '';
  if (file) return file;
  return label ?? 'Imported activity';
}

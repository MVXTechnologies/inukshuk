/**
 * The info strip (#673, mockup 2.6.0 "Info strip" §8): one full-width, dense
 * strip docked at the bottom (or top) edge of the map, rows of fields, plus
 * two map aids drawn on the map (the centre cursor and the pointing line).
 *
 * A strip is rows of field refs. A field is a {@link FieldDescriptor}: a
 * params schema that generates its settings page, the data it depends on,
 * how often it refreshes and a pure `compute()`. The registry
 * (`registry.ts`) is `satisfies`-checked like the extension registry.
 *
 * Pure: no platform imports. The UI phase subscribes to the union of the
 * placed fields' deps at their fastest tick and hands `compute()` a
 * {@link DepsSnapshot}.
 */
import type { CoordinateFormat } from '@core/convert/coordinateDisplay';
import type { AnyExtensionKey } from '@core/extensions/keys';
import type { Units } from '@core/format';
import type { PointingLineSettings } from '@core/map/pointingLineSettings';
import type { LatLng } from '@core/models';
import type { FixKind } from '@core/gnss/quality';
import type { CourseSample } from '@core/nav/headingTape';
import type { HeroData, HeroField } from '@core/recording/panel';

// ------------------------------------------------------------------ strip

/** Where the strip docks: the bottom edge (default) or the top. */
export type Dock = 'bottom' | 'top';

/** One placed field: its id and its params. Unknown ids (a newer build's) are kept, never drawn. */
export interface FieldRef {
  field: string;
  params: Readonly<Record<string, unknown>>;
}

/** The centre cursor's icon (mockup §7). `dot` is 2.5.1's. */
export type CursorKind = 'dot' | 'cross' | 'reticle' | 'ring' | 'x';
export type CursorSize = 'S' | 'M' | 'L' | 'XL';

export interface CursorSettings {
  enabled: boolean;
  kind: CursorKind;
  size: CursorSize;
  /** One of `CURSOR_COLORS`. */
  color: string;
  /** A paper outline so it reads on any map. */
  halo: boolean;
  /** The puck marks the spot while the map follows you. */
  hideWhileFollowing: boolean;
}

export interface MapAids {
  cursor: CursorSettings;
  /**
   * The pointing line a strip turns on (Survey). Absent: the strip leaves the
   * app's own `pointingLine` setting (2.5.1) as it is.
   */
  pointingLine?: PointingLineSettings;
}

export interface InfoStrip {
  /** Name shown in the editor ("Navigation", "Ridge survey"). */
  name: string;
  /** The built-in preset this strip started from (`'navigation'`), for "· edited". */
  basedOn?: string;
  dock: Dock;
  /** At most {@link MAX_ROWS} rows of at most `ROW_SPACES` spaces; row 1 on top, in either dock (mockup §5: moving the dock never reshuffles). */
  rows: FieldRef[][];
  aids: MapAids;
  /** The strip's shared target: every target field follows it unless it picks its own. */
  target: Target;
}

/** The most rows a strip can have (owner Q7: three rows, 99 dp). */
export const MAX_ROWS = 3;

// ------------------------------------------------------------------ targets

/**
 * What a target field measures to (owner Q4: one strip target, overridable
 * per field).
 * - `navTarget`: whatever you navigate to: the followed trail's next target
 *   while following, else the destination pin (the destination chip).
 * - `nextOnTrail`: the next waypoint on the followed trail only.
 * - `waypoint`: a saved waypoint, by id.
 * - `coordinate`: a typed or pasted point (WGS 84), with an optional label.
 */
export type Target =
  | { kind: 'navTarget' }
  | { kind: 'nextOnTrail' }
  | { kind: 'waypoint'; waypointId: string }
  | { kind: 'coordinate'; point: LatLng; label?: string };

/** A target resolved against the live data. */
export interface ResolvedTarget {
  name: string;
  point: LatLng;
  /** The glyph the name field draws: a flag, the trail, a waypoint pin, a mark. */
  glyph: 'flag' | 'route' | 'place' | 'my_location';
  /**
   * The distance along the followed trail (what is left plus the way back to
   * it), when the target is the trail's own; null otherwise.
   */
  alongTrailM: number | null;
}

// ------------------------------------------------------------------ params

/** A params object: plain values only, so it persists as JSON. */
export type Params = Record<string, ParamValue>;
export type ParamValue = string | boolean | Target | null;

export interface ChoiceSpec<V extends string> {
  kind: 'choice';
  label: string;
  hint?: string;
  options: readonly { value: V; label: string }[];
}

export interface ToggleSpec {
  kind: 'toggle';
  label: string;
  hint?: string;
}

/** A target override: null follows the strip's target. */
export interface TargetSpec {
  kind: 'target';
  label: string;
}

/**
 * A tide station (#695): {@link NEAREST_STATION} by default, else a station's
 * key (`@core/tides/station` stationKey). Its options are the stations near
 * you, so the settings page lists them live rather than from the schema.
 */
export interface StationSpec {
  kind: 'station';
  label: string;
  hint?: string;
}

/** The station param's default: the nearest live station to you (or the map centre). */
export const NEAREST_STATION = 'nearest';

/** Any param's spec. */
export type AnyParamSpec = ChoiceSpec<string> | ToggleSpec | TargetSpec | StationSpec;

/** The spec for one param, by its value type (what `defineField` checks). */
export type ParamSpec<V> = [V] extends [boolean]
  ? ToggleSpec
  : [V] extends [Target | null]
    ? TargetSpec
    : [V] extends [string]
      ? ChoiceSpec<V> | StationSpec
      : never;

/**
 * A field's params, described: one spec per key, in settings-page order. The
 * UI phase generates the field's settings page from it; the settings
 * normaliser validates persisted params against it.
 */
export type ParamSchema<P extends Params> = { readonly [K in keyof P]-?: AnyParamSpec };

/** {@link ParamSchema} with each spec checked against its value type (choices list only P's values). */
export type TypedParamSchema<P extends Params> = { readonly [K in keyof P]-?: ParamSpec<P[K]> };

// ------------------------------------------------------------------ data

/**
 * What a field reads. The coordinator subscribes to the union of the placed
 * fields' deps; `ext:*` deps come from an installed extension.
 */
export type DataDep =
  | 'position'
  | 'heading'
  | 'course'
  | 'camera'
  | 'elevation'
  | 'recording'
  | 'follow'
  | 'navTarget'
  | 'waypoints'
  | 'clock'
  | `ext:${AnyExtensionKey}`;

/**
 * How often a field refreshes: on camera idle (never per frame), per fix,
 * heading at 4 Hz, each second, each minute.
 */
export type Tick = 'cameraIdle' | 'position' | 'heading4Hz' | 'second' | 'minute';

/** Ticks, fastest first: a strip refreshes at the fastest of its fields. */
export const TICK_ORDER: readonly Tick[] = [
  'heading4Hz',
  'position',
  'second',
  'cameraIdle',
  'minute',
];

/** A fix, as the strip needs it. */
export interface StripFix extends LatLng {
  /** Metres above the ellipsoid/geoid as the fix reports it, or null. */
  altitudeM: number | null;
  /** Horizontal accuracy, metres (95 % for the receiver), or null. */
  accuracyM: number | null;
  /** Speed over ground, m/s, or null. */
  speedMps: number | null;
}

/** The followed trail's live readout (`@core/nav` FollowReadout, cut to what fields read). */
export interface FollowSnapshot {
  /** What the next target is: a saved waypoint, a trail note or the trail's end (#696 opens it). */
  targetKind: 'waypoint' | 'note' | 'end';
  /** The waypoint's or note's id, or "end". */
  targetId: string;
  targetName: string;
  targetPoint: LatLng;
  /** Along the trail plus the way back to it, metres. */
  targetDistanceM: number;
  crossTrackM: number;
  onTrail: boolean;
}

/** A coordinate in another datum, as the platform's Convert engine produced it. */
export interface DatumView {
  /** "NAD83(CSRS) 2010.0". */
  label: string;
  /** Short tag for the strip ("CSRS"). */
  tag: string;
  centre: LatLng | null;
  you: LatLng | null;
}

/** The external receiver's live state (GNSS extension). */
export interface GnssSnapshot {
  kind: FixKind;
  /** Ellipsoidal height, metres, or null. */
  ellipsoidalHeightM: number | null;
  /** The height's accuracy, metres, or null. */
  heightAccuracyM: number | null;
}

/** A tide station's live level (Tide stations extension). */
export interface TideSnapshot {
  stationName: string;
  /** The latest observed level above chart datum, metres; null when no fresh observation. */
  levelM: number | null;
  trend: 'rising' | 'falling' | 'slack' | null;
  nextHigh: { atMs: number; levelM: number } | null;
}

/**
 * Everything `compute()` may read, as of one tick. Every member is optional
 * or nullable: a field whose data is missing returns null and the row
 * re-fits (never a stale or invented value).
 */
export interface DepsSnapshot {
  nowMs: number;
  /** The settled map centre (WGS 84), or null before the first settle. */
  centre: LatLng | null;
  /** Ground elevation at the centre from the DEM, metres, or null (no tile). */
  centreElevationM: number | null;
  /** The camera follows you: the centre is you (2.5.1). */
  followsUser: boolean;
  position: StripFix | null;
  /** Compass heading, degrees true, or null (no magnetometer). */
  headingDeg: number | null;
  /** The course tracker's latest sample (`@core/nav` createCourseTracker), or null. */
  course: CourseSample | null;
  /** Moving speed over the last 10 min (`movingSpeed.ts`), or null while warming up. */
  movingSpeedMps: number | null;
  /** The destination pin, or null. */
  navTarget: { name: string; point: LatLng } | null;
  /** The followed trail's readout, or null when not following. */
  follow: FollowSnapshot | null;
  /** Saved waypoints the strip's targets name, by id. */
  waypoints: Readonly<Record<string, { name: string; point: LatLng }>>;
  /** The recorder's numbers while recording, else null. */
  recording: HeroData | null;
  /** The app-wide coordinate format (Settings › Display › Coordinates). */
  coordinateFormat: CoordinateFormat;
  /** The centre and you in other datums, when the platform could convert them. */
  datums: { csrs?: DatumView; project?: DatumView };
  gnss: GnssSnapshot | null;
  /**
   * The tide readouts the placed tide fields name, by their `station` param
   * ({@link NEAREST_STATION} or a station key); a station not loaded (no
   * extension, offline, nothing near) is absent and its fields step aside.
   */
  tides: Readonly<Record<string, TideSnapshot>>;
}

// ------------------------------------------------------------------ values

/** What one field draws: glyph or tag, value, unit, tone (mockup `sfield`). */
export interface StripValue {
  /** A Material Symbols name. */
  glyph?: string;
  /** A short text tag before the value ("ETE", "δ", "SOG"). */
  tag?: string;
  value: string;
  unit?: string;
  tone?: 'ok' | 'warn';
}

export type FieldGroup = 'navigation' | 'position' | 'motion' | 'recording' | 'extension';

/** What `compute()` gets besides the data and its params. */
export interface ComputeContext {
  units: Units;
  /** The strip's shared target. */
  target: Target;
}

export interface FieldDescriptor<P extends Params = Params> {
  id: string;
  /** The picker's name ("Distance to target"). */
  label: string;
  /** The picker's hint ("Straight line, or along the trail when following"). */
  summary: string;
  /** Extra search words ("range", "far"). */
  synonyms: readonly string[];
  group: FieldGroup;
  /** Row spaces it takes: most fields 1, coordinates 2 (a row has 4). */
  spaces: 1 | 2;
  /** Listed, and kept when a preset applies, only with this extension installed. */
  requires?: AnyExtensionKey;
  params: ParamSchema<P>;
  defaults: P;
  deps: readonly DataDep[];
  tick: Tick;
  /** Dropped from the strip while the recording panel shows this metric (Q5). */
  recordingMetric?: HeroField;
  /** Null: leave the field out, the row re-fits. Method syntax: params are checked per descriptor. */
  compute(data: DepsSnapshot, params: P, ctx: ComputeContext): StripValue | null;
  /** The picker's preview, without data. */
  sample: StripValue;
}

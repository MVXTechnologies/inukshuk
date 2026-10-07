import type { ClockEstimate } from './clock';
import { describeClock } from './clock';
import type { ImportPlan, PlannedPhoto } from './placement';

/**
 * The words of the Add-photos sheet (#587, mockup 4b), pure so they are
 * tested once: the title and subtitle, the three groups' explanations, the
 * camera-clock rows (one per camera), and the result line.
 *
 * Dates and times go through `DateFormat` so the device's locale and zone do
 * the formatting on the phone while tests stay deterministic.
 */

export interface DateFormat {
  /** "Sun 27 Sep" */
  day(epochMs: number): string;
  /** "09:12" */
  time(epochMs: number): string;
}

export const deviceDateFormat: DateFormat = {
  day: (ms) =>
    new Date(ms).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }),
  time: (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "35 photos selected". */
export function selectedTitle(picked: number): string {
  return `${plural(picked, 'photo', 'photos')} selected`;
}

/**
 * "Matched against your recording · Sun 27 Sep, 09:12 – 12:54", or for a
 * planned route (no times) the reason only GPS can place photos. Duplicates
 * are mentioned ("3 already on this trail").
 */
export function sheetSubtitle(
  recording: { startMs?: number; endMs?: number },
  duplicates: number,
  fmt: DateFormat = deviceDateFormat,
): string {
  const parts: string[] = [];
  if (recording.startMs !== undefined && recording.endMs !== undefined) {
    parts.push(
      `Matched against your recording · ${fmt.day(recording.startMs)}, ${fmt.time(
        recording.startMs,
      )} – ${fmt.time(recording.endMs)}`,
    );
  } else {
    parts.push('This route has no times: photos go where their location says');
  }
  if (duplicates > 0) parts.push(`${duplicates} already on this trail`);
  return parts.join(' · ');
}

export const BY_TIME_TEXT = 'Taken during the outing. Each one goes where you were at that minute.';

/** "By location only": why, and how far from the trail. */
export function byGpsText(group: readonly PlannedPhoto[], timedTrail: boolean): string {
  const offs = group.flatMap((p) => (p.result.kind === 'gps' ? [p.result.offTrackM] : []));
  const why = timedTrail ? 'No time in the file' : 'Placed on the route';
  const max = offs.length > 0 ? Math.round(Math.max(...offs)) : null;
  const where =
    max === null
      ? ''
      : offs.length === 1
        ? `, ${max} m from the trail`
        : `, all within ${max} m of the trail`;
  return timedTrail
    ? `${why}. Placed at ${offs.length === 1 ? 'its' : 'their'} GPS position${where}.`
    : `${why} by ${offs.length === 1 ? 'its' : 'their'} GPS position${where}.`;
}

/**
 * "Not from this outing": "Taken Sat 26 Sep at 18:40 and Mon 28 Sep at 08:05,
 * far from the trail. Left out unless you tick them."
 */
export function outsideText(
  group: readonly PlannedPhoto[],
  fmt: DateFormat = deviceDateFormat,
): string {
  const at = (ms: number) => `${fmt.day(ms)} at ${fmt.time(ms)}`;
  const timed = group
    .map((p) => p.candidate.takenAt)
    .filter((t): t is number => t !== undefined)
    .sort((a, b) => a - b);
  const far = group.some((p) => p.result.kind === 'outside' && p.result.reason === 'far');
  const noData = group.filter(
    (p) => p.result.kind === 'outside' && p.result.reason === 'no-data',
  ).length;
  const parts: string[] = [];
  if (timed.length === 1) parts.push(`Taken ${at(timed[0]!)}`);
  else if (timed.length === 2) parts.push(`Taken ${at(timed[0]!)} and ${at(timed[1]!)}`);
  else if (timed.length > 2) {
    parts.push(`Taken between ${at(timed[0]!)} and ${at(timed[timed.length - 1]!)}`);
  }
  if (far) parts.push('far from the trail');
  else if (timed.length > 0) parts.push('outside this outing');
  if (noData > 0) {
    parts.push(`${plural(noData, 'photo has', 'photos have')} no time or location`);
  }
  const lead = parts.join(', ');
  return `${lead.charAt(0).toUpperCase()}${lead.slice(1)}. Left out unless you tick ${
    group.length === 1 ? 'it' : 'them'
  }.`;
}

/** One line of the camera-clock card. */
export interface ClockRow {
  key: string;
  /** "Camera clock matches your GPS", or with a camera: "Pixel 8: camera clock …". */
  title: string;
  detail: string;
}

function clockDetail(clock: ClockEstimate, manual: boolean): string {
  if (manual) return 'Set by hand with Adjust';
  if (clock.samples === 0) return 'No photo has both a time and a location';
  const checked = `Checked on ${plural(clock.samples, 'photo', 'photos')} that ${
    clock.samples === 1 ? 'has' : 'have'
  } a location`;
  if (clock.status === 'ok') return `${checked} · off by under 1 min`;
  if (clock.status === 'corrected') return `${checked} · corrected`;
  return `${checked} · too few to check, times used as they are`;
}

/**
 * The clock card: one row per camera (EXIF Make + Model) with its own check,
 * plus a row for photos without a camera name. A camera too thin to check
 * on its own uses the batch's estimate, and says so. With a single row the
 * camera's name is left out. A manual Adjust is one row for everything.
 */
export function clockRows(
  plan: Pick<ImportPlan, 'clock' | 'cameraClocks' | 'byTime' | 'byGps' | 'outside'>,
  manual: boolean,
): ClockRow[] {
  if (manual) {
    return [
      { key: 'manual', title: describeClock(plan.clock), detail: clockDetail(plan.clock, true) },
    ];
  }
  // Nothing could be checked at all (common on Android, whose photo picker
  // removes locations): one quiet row, not one "not checked" per camera.
  if (plan.clock.samples === 0 && [...plan.cameraClocks.values()].every((c) => c.samples === 0)) {
    return [
      {
        key: 'batch',
        title: describeClock(plan.clock),
        detail: 'No photo has both a time and a location, so their times are used as they are',
      },
    ];
  }
  const all = [...plan.byTime, ...plan.byGps, ...plan.outside];
  const anonymous = all.some((p) => p.candidate.camera === undefined);
  const rows: (ClockRow & { camera?: string })[] = [];
  for (const camera of [...plan.cameraClocks.keys()].sort()) {
    const own = plan.cameraClocks.get(camera)!;
    // Too thin to check on its own: its photos follow the whole batch's check.
    const borrows = own.status === 'unknown' && plan.clock.status !== 'unknown';
    rows.push({
      key: `camera:${camera}`,
      camera,
      title: describeClock(borrows ? plan.clock : own),
      detail: borrows
        ? `Too few photos with a location · uses the other photos' check`
        : clockDetail(own, false),
    });
  }
  if (anonymous || rows.length === 0) {
    rows.push({
      key: 'batch',
      title: describeClock(plan.clock),
      detail: clockDetail(plan.clock, false),
    });
  }
  // Name the camera only when there is more than one row to tell apart.
  return rows.map(({ camera, ...row }) =>
    rows.length > 1 ? { ...row, detail: `${camera ?? 'Other photos'} · ${row.detail}` } : row,
  );
}

/** How many square thumbnails of `size` fit in one row `width` wide with `gap` between (at least 2). */
export function thumbsPerRow(width: number, size: number, gap: number): number {
  return Math.max(2, Math.floor((width + gap) / (size + gap)));
}

/** Thumbnails to show for a group, and the "+27" overflow. */
export function thumbStrip<T>(items: readonly T[], max = 6): { shown: T[]; more: number } {
  if (items.length <= max) return { shown: [...items], more: 0 };
  return { shown: items.slice(0, max - 1), more: items.length - (max - 1) };
}

/** The result line after "Add N photos". */
export function importOutcomeMessage(r: {
  added: number;
  failed: number;
  chosen: number;
  stopped?: 'cancelled' | 'storage-full';
}): string {
  const added = r.added === 0 ? 'no photos added' : `added ${plural(r.added, 'photo', 'photos')}`;
  if (r.stopped === 'storage-full') return `Stopped: storage is full · ${added}`;
  if (r.stopped === 'cancelled') return `Cancelled · ${added}`;
  if (r.added === 0)
    return r.failed > 0
      ? `No photos added: ${plural(r.failed, 'photo', 'photos')} could not be read`
      : 'No photos added';
  const base =
    r.added === r.chosen
      ? `Added ${plural(r.added, 'photo', 'photos')}`
      : `Added ${r.added} of ${plural(r.chosen, 'photo', 'photos')}`;
  return r.failed > 0 ? `${base} · ${r.failed} could not be read` : base;
}

/** The primary button: "Add 33 photos". */
export function addButtonLabel(n: number): string {
  return n === 0 ? 'Add photos' : `Add ${plural(n, 'photo', 'photos')}`;
}

/** A group's checkbox: all of its photos picked, some, or none. */
export function groupCheck(
  keys: readonly string[],
  selected: ReadonlySet<string>,
): 'checked' | 'mixed' | 'unchecked' {
  const n = keys.filter((k) => selected.has(k)).length;
  if (n === 0 || keys.length === 0) return 'unchecked';
  return n === keys.length ? 'checked' : 'mixed';
}

/** Tick a group's checkbox: a fully picked group is cleared, anything else is filled. */
export function toggleGroup(selected: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const next = new Set(selected);
  if (groupCheck(keys, selected) === 'checked') for (const k of keys) next.delete(k);
  else for (const k of keys) next.add(k);
  return next;
}

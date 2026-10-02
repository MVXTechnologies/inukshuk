import {
  createFormatters,
  formatClockTime,
  formatDuration,
  formatSpan,
  type Units,
} from '@core/format';
import type { ElevationExtremes, Split, TimelineEvent, TrailTiming } from '@core/geo/track';
import type { TrackStats } from '@core/models';

/**
 * The words and numbers of the trail view (#511), kept pure so every label,
 * unit and edge case (untimed routes, imperial units, merged events) is
 * unit-tested rather than eyeballed. The screen only lays these out.
 */

const MILE_M = 1609.344;

/** Split length for the user's units: a kilometre or a mile. */
export function splitUnit(units: Units): { unitM: number; label: 'km' | 'mi' } {
  return units === 'imperial' ? { unitM: MILE_M, label: 'mi' } : { unitM: 1000, label: 'km' };
}

/** Signed whole-percent grade with a thin gap: "+24 %", "−8 %", "0 %". */
export function formatGradePct(g: number): string {
  const r = Math.round(g);
  if (r === 0 || !Number.isFinite(r)) return '0 %';
  return `${r > 0 ? '+' : '−'}${Math.abs(r)} %`;
}

export interface StatTile {
  label: string;
  value: string;
  /** A small line under the value ("of 4:28:00 total"). */
  sub?: string;
}

/**
 * Overview tiles. Recorded trail: Distance, Climb / descent, Moving time (of
 * total), Moving pace or speed (by activity), Highest point, Total time.
 * Untimed route: Distance, Climb / descent, Highest and Lowest point.
 * With heart-rate data, Avg heart rate takes the last slot (#511, board C2).
 */
export function overviewTiles(
  stats: Pick<TrackStats, 'distanceM' | 'ascentM' | 'descentM'>,
  timing: TrailTiming | null,
  extremes: ElevationExtremes | null,
  units: Units,
  avgHeartRateBpm: number | null = null,
): StatTile[] {
  const fmt = createFormatters(units);
  const tiles: StatTile[] = [
    { label: 'Distance', value: fmt.formatDistance(stats.distanceM) },
    {
      label: 'Climb / descent',
      value: `↑ ${fmt.formatElevation(stats.ascentM)}`,
      sub: `↓ ${fmt.formatElevation(stats.descentM)}`,
    },
  ];
  const high: StatTile = {
    label: 'Highest point',
    value: extremes ? fmt.formatElevation(extremes.highM) : '—',
  };
  const hr: StatTile | null =
    avgHeartRateBpm !== null ? { label: 'Avg heart rate', value: `${avgHeartRateBpm} bpm` } : null;
  if (!timing) {
    tiles.push(high, {
      label: 'Lowest point',
      value: extremes ? fmt.formatElevation(extremes.lowM) : '—',
    });
    if (hr) tiles.push(hr);
    return tiles;
  }
  const speed = timing.display === 'speed';
  const avg = (mps: number) => (speed ? fmt.formatSpeed(mps) : fmt.formatPace(mps));
  tiles.push(
    {
      label: 'Moving time',
      value: formatDuration(timing.movingTimeS),
      sub: `of ${formatDuration(timing.elapsedS)} total`,
    },
    {
      label: speed ? 'Moving speed' : 'Moving pace',
      value: avg(timing.movingSpeedMps),
      sub: `${avg(timing.elapsedSpeedMps)} overall`,
    },
    high,
    // The total already rides under Moving time; with a watch, HR earns the slot.
    hr ?? { label: 'Total time', value: formatDuration(timing.elapsedS) },
  );
  return tiles;
}

export interface SplitRow {
  /** "1", "2"… or the partial last one's length ("0.45"). */
  label: string;
  /** Pace / speed (timed), or null for a route. */
  pace: string | null;
  climb: string;
  descent: string;
  /** The dominant change, for a single column: the climb, or the descent when it's bigger. */
  net: string;
  /** Bar length 0..1: speed relative to the fastest split (timed) or climb relative to the biggest (route). */
  ratio: number;
  /** For screen readers: "Kilometre 2: 21:30 per km, up 160 m". */
  a11y: string;
}

/** Rows for the Splits tab. */
export function splitRows(
  splits: readonly Split[],
  units: Units,
  display: 'pace' | 'speed',
): SplitRow[] {
  const fmt = createFormatters(units);
  const { unitM, label: unitLabel } = splitUnit(units);
  const unitName = units === 'imperial' ? 'Mile' : 'Kilometre';
  const timed = splits.some((s) => s.speedMps !== null);
  let maxSpeed = 0;
  let maxClimb = 0;
  for (const s of splits) {
    if (s.speedMps !== null && s.speedMps > maxSpeed) maxSpeed = s.speedMps;
    if (s.ascentM > maxClimb) maxClimb = s.ascentM;
  }
  return splits.map((s) => {
    const label = s.partial ? (s.distanceM / unitM).toFixed(2) : String(s.index + 1);
    const pace =
      s.speedMps === null
        ? null
        : display === 'speed'
          ? fmt.formatSpeed(s.speedMps)
          : fmt.formatPace(s.speedMps);
    const raw = timed
      ? maxSpeed > 0 && s.speedMps !== null
        ? s.speedMps / maxSpeed
        : 0
      : maxClimb > 0
        ? s.ascentM / maxClimb
        : 0;
    const climb = `↑ ${fmt.formatElevation(s.ascentM)}`;
    const descent = `↓ ${fmt.formatElevation(s.descentM)}`;
    const name = s.partial ? `Last ${label} ${unitLabel}` : `${unitName} ${label}`;
    return {
      label,
      pace,
      climb,
      descent,
      net: s.descentM > s.ascentM ? descent : climb,
      ratio: Math.max(0.06, Math.min(1, raw)),
      a11y: `${name}: ${pace ? `${pace}, ` : ''}up ${fmt.formatElevation(s.ascentM)}, down ${fmt.formatElevation(s.descentM)}`,
    };
  });
}

export interface TimelineText {
  title: string;
  sub: string;
  /** Clock time ("9:12") on a recorded trail, null on a route. */
  time: string | null;
}

/** Totals the Finish line quotes. */
export interface FinishTotals {
  distanceM: number;
  timing: TrailTiming | null;
}

function firstLine(text: string, max: number): { head: string; rest: string } {
  const t = text.trim();
  const nl = t.indexOf('\n');
  const line = (nl >= 0 ? t.slice(0, nl) : t).trim();
  const rest = nl >= 0 ? t.slice(nl + 1).trim() : '';
  if (line.length <= max) return { head: line, rest };
  return { head: `${line.slice(0, max - 1).trimEnd()}…`, rest };
}

/** Title, subtitle and time for one Timeline event. */
export function timelineEventText(
  e: TimelineEvent,
  units: Units,
  totals: FinishTotals,
): TimelineText {
  const fmt = createFormatters(units);
  const time = e.at.time !== undefined ? formatClockTime(e.at.time) : null;
  const where = fmt.formatDistance(e.at.distanceM);
  const elev = e.at.elevation !== undefined ? fmt.formatElevation(e.at.elevation) : null;
  const stopped = e.stoppedS !== undefined ? `Stopped ${formatSpan(e.stoppedS)}` : null;
  const join = (...parts: (string | null | undefined | false)[]) =>
    parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');
  const high =
    e.highPointM !== undefined ? `high point ${fmt.formatElevation(e.highPointM)}` : null;

  switch (e.kind) {
    case 'start':
      return {
        title: 'Start',
        sub:
          join(elev ?? null, high, stopped) ||
          `${e.at.latitude.toFixed(4)}, ${e.at.longitude.toFixed(4)}`,
        time,
      };
    case 'note': {
      const { head, rest } = firstLine(e.noteText ?? '', 40);
      const excerpt = rest
        ? `“${rest.length > 60 ? `${rest.slice(0, 59).trimEnd()}…` : rest}”`
        : null;
      return {
        title: head || `Note ${e.noteNum ?? ''}`.trim(),
        sub: join(`Note ${e.noteNum ?? ''}`.trim(), where, excerpt, stopped),
        time,
      };
    }
    case 'stop':
      return { title: `Stopped ${formatSpan(e.stoppedS ?? 0)}`, sub: join(where, elev), time };
    case 'pause':
      return { title: `Paused ${formatSpan(e.pausedS ?? 0)}`, sub: join(where, elev), time };
    case 'steep':
      return {
        title: (e.gradePct ?? 0) < 0 ? 'Steepest descent' : 'Steepest climb',
        sub: join(
          `${formatGradePct(e.gradePct ?? 0)} over ${fmt.formatDistance(e.lengthM ?? 0)}`,
          where,
        ),
        time,
      };
    case 'summit':
      return {
        title: `Summit · ${fmt.formatElevation(e.highPointM ?? e.at.elevation ?? 0)}`,
        sub: join(stopped, where),
        time,
      };
    case 'finish': {
      const t = totals.timing;
      const moving = t
        ? `moving ${formatDuration(t.movingTimeS)} of ${formatDuration(t.elapsedS)}`
        : null;
      return {
        title: high ? `Finish · ${high}` : 'Finish',
        sub: join(fmt.formatDistance(totals.distanceM), moving, stopped),
        time,
      };
    }
  }
}

/** "Hike · Saturday, September 28 · 9:12 → 13:40" (parts that exist). */
export function trailSubtitle(
  categoryName: string | null,
  startedAt: number | undefined,
  endedAt: number | undefined,
  timed: boolean,
): string {
  const parts: string[] = [];
  if (categoryName) parts.push(categoryName);
  if (timed && startedAt !== undefined && Number.isFinite(startedAt) && startedAt > 0) {
    parts.push(
      new Date(startedAt).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }),
    );
    parts.push(
      endedAt !== undefined && endedAt > startedAt
        ? `${formatClockTime(startedAt)} → ${formatClockTime(endedAt)}`
        : formatClockTime(startedAt),
    );
  } else if (!timed) {
    parts.push('Route');
  }
  return parts.join(' · ');
}

/**
 * The cursor badge on the map: "2.73 km · 800 m · +4 %", or "· summit" when
 * the cursor sits on the high point. Parts that don't exist are left out.
 */
export function cursorReadout(
  at: { distanceM: number; elevation?: number },
  gradePct: number | null,
  atSummit: boolean,
  units: Units,
): string {
  const fmt = createFormatters(units);
  const parts = [fmt.formatDistance(at.distanceM)];
  if (at.elevation !== undefined && Number.isFinite(at.elevation)) {
    parts.push(fmt.formatElevation(at.elevation));
  }
  if (atSummit) parts.push('summit');
  else if (gradePct !== null) parts.push(formatGradePct(gradePct));
  return parts.join(' · ');
}

import { useEffect, useMemo, useRef, useState } from 'react';

import { buildElevationProfile, scrubProfileAtRatio, type TrackPointAt } from '@core/geo/track';
import type { TrackNote, TrackPoint } from '@core/models';
import { formatDistance, formatElevation, formatPace } from '@lib/format';

import { IconChart, IconHeart, IconMountain, IconShoe } from '@/ui/Icons';

/**
 * The elevation profile, ported from
 * `src/features/common/components/ElevationProfile.tsx`.
 *
 * The app draws it with `react-native-svg`, which is the same element tree as
 * DOM SVG, so this is a near-literal port and every constant is the app's:
 * 140 px plot + 30 px tick band, a 38 px elevation gutter and a 34 px right
 * margin, 64 distance-even samples from `@core/geo/track#buildElevationProfile`,
 * Catmull-Rom smoothing, the four-stop grade ramp over ±25 %, the pace and
 * heart-rate curves at `#4E97C9` / `#E0526A` with their dotted averages, and
 * `scrubProfileAtRatio` resolving a touch to a sample and an on-trail point.
 *
 * What is NOT the app's: theme colours come from the playground's CSS variables
 * (`--accent`, `--danger`, …) instead of the Paper theme, and the gesture is
 * pointer events with pointer capture instead of a `PanResponder`. Both are the
 * same decision expressed in the other platform's vocabulary.
 */

const H = 140;
const X_AXIS_H = 30;
const AXIS_LEFT = 38;
const AXIS_RIGHT = 34;
const TOP_PAD = 14;
const BOTTOM_PAD = 6;

const PACE_COLOR = '#4E97C9';
const HR_COLOR = '#E0526A';
const TOGGLE_ON = '#6FB1DC';

/** Blue → sage → amber → red, the app's `GRADE_STOPS`. */
const GRADE_STOPS: readonly [number, number, number][] = [
  [59, 124, 184],
  [138, 176, 108],
  [224, 161, 60],
  [198, 47, 47],
];
const GRADE_LIMIT = 25;

function gradeColor(gradePercent: number): string {
  const t = Math.max(0, Math.min(1, (gradePercent + GRADE_LIMIT) / (2 * GRADE_LIMIT)));
  const span = GRADE_STOPS.length - 1;
  const i = Math.min(span - 1, Math.floor(t * span));
  const local = t * span - i;
  const a = GRADE_STOPS[i]!;
  const b = GRADE_STOPS[i + 1]!;
  const mix = (k: 0 | 1 | 2) => Math.round(a[k] + (b[k] - a[k]) * local);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

/** Catmull-Rom through the points, emitted as cubic Béziers. */
function smoothPath(pts: readonly [number, number][]): string {
  if (pts.length === 0) return '';
  const f = (n: number) => n.toFixed(1);
  let d = `M${f(pts[0]![0])},${f(pts[0]![1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`;
  }
  return d;
}

/** Runs of consecutive defined values — a curve must not bridge a data gap. */
function curveRuns(values: readonly (number | undefined)[]): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  values.forEach((v, i) => {
    if (v === undefined || !Number.isFinite(v)) {
      if (run.length >= 2) runs.push(run);
      run = [];
    } else {
      run.push(i);
    }
  });
  if (run.length >= 2) runs.push(run);
  return runs;
}

/** Up to four "nice" elevation gridlines across the visible range. */
function gridLevels(min: number, max: number): number[] {
  const range = max - min || 1;
  const step = range / 4;
  const nice = 10 ** Math.floor(Math.log10(step));
  const inc = Math.max(nice, Math.ceil(step / nice) * nice);
  const out: number[] = [];
  for (let e = Math.ceil(min / inc) * inc; e <= max && out.length < 4; e += inc) out.push(e);
  return out;
}

const TICK_STEPS = [100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000];

function distanceTicks(total: number): number[] {
  const step = TICK_STEPS.find((s) => total / s <= 8) ?? 100_000;
  const out: number[] = [];
  for (let d = 0; d < total; d += step) out.push(d);
  const last = out[out.length - 1] ?? 0;
  if (total - last > 0.4 * step) out.push(total);
  return out;
}

const formatGrade = (g: number): string => {
  const r = Math.round(g);
  const n = Object.is(r, -0) ? 0 : r;
  return `${n > 0 ? '+' : ''}${n}%`;
};

export interface TrimWindow {
  /** Distance along the trail, metres, of the first kept point. */
  fromM: number;
  /** Distance along the trail, metres, of the last kept point. */
  toM: number;
}

export function ElevationProfile({
  points,
  ascentM,
  descentM,
  notes,
  onScrub,
  trim,
}: {
  points: readonly TrackPoint[];
  ascentM: number;
  descentM: number;
  notes?: readonly TrackNote[];
  onScrub?: (at: TrackPointAt | null) => void;
  /** When set, the cut ends are dimmed in place instead of the chart being
   *  swapped out for the trim slider (see TrailFocus for why). */
  trim?: TrimWindow | null;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);
  const [showAlt, setShowAlt] = useState(true);
  const [showPace, setShowPace] = useState(true);
  const [showHr, setShowHr] = useState(true);
  const [scrub, setScrub] = useState<{ index: number; at: TrackPointAt } | null>(null);

  useEffect(() => {
    const el = holder.current;
    if (el === null) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const profile = useMemo(() => buildElevationProfile(points), [points]);
  const { samples, totalDistanceM, minElevationM, maxElevationM, hasElevation } = profile;

  // Pace and HR are read at each sample's distance from the ORIGINAL points, so
  // the three series share one x axis without resampling them separately.
  const series = useMemo(() => {
    if (samples.length === 0) return { pace: [], hr: [] };
    const cum: number[] = new Array(points.length);
    let acc = 0;
    for (let i = 0; i < points.length; i++) {
      if (i > 0) {
        const a = points[i - 1]!;
        const b = points[i]!;
        // Cheap equirectangular step: this only positions a lookup cursor, and
        // haversine over 90 000 points per render would be the wrong price.
        const dx = (b.longitude - a.longitude) * Math.cos((b.latitude * Math.PI) / 180) * 111_320;
        const dy = (b.latitude - a.latitude) * 111_320;
        acc += Math.hypot(dx, dy);
      }
      cum[i] = acc;
    }
    let cursor = 0;
    const pace: (number | undefined)[] = [];
    const hr: (number | undefined)[] = [];
    for (const s of samples) {
      const target = (s.distanceM / (totalDistanceM || 1)) * acc;
      while (cursor < points.length - 2 && cum[cursor + 1]! < target) cursor++;
      const p = points[cursor]!;
      pace.push(p.speed !== undefined && p.speed > 0.2 ? p.speed : undefined);
      hr.push(p.heartRateBpm);
    }
    return { pace, hr };
  }, [points, samples, totalDistanceM]);

  const plotW = Math.max(40, width - AXIS_LEFT - AXIS_RIGHT);
  const range = maxElevationM - minElevationM || 1;
  const xFor = (d: number) =>
    AXIS_LEFT + (Math.max(0, Math.min(totalDistanceM, d)) / (totalDistanceM || 1)) * plotW;
  const yFor = (e: number) => H - ((e - minElevationM) / range) * (H - TOP_PAD) - BOTTOM_PAD;

  const paceRange = extent(series.pace);
  const hrRange = extent(series.hr);
  const bandY = (t: number) => H - TOP_PAD - t * (H - 40) - BOTTOM_PAD;

  if (!hasElevation) {
    return (
      <div className="profile" ref={holder}>
        <div className="empty small">No elevation data was recorded for this trail.</div>
      </div>
    );
  }

  const altPoints = samples.map((s): [number, number] => [xFor(s.distanceM), yFor(s.elevationM)]);

  const move = (clientX: number) => {
    const box = holder.current?.getBoundingClientRect();
    if (box === undefined) return;
    const ratio = (clientX - box.left - AXIS_LEFT) / plotW;
    const hit = scrubProfileAtRatio(points, samples, ratio);
    if (hit === null) return;
    setScrub({ index: hit.sampleIndex, at: hit.at });
    onScrub?.(hit.at);
  };

  const sample = scrub === null ? undefined : samples[scrub.index];
  const scrubPace = scrub === null ? undefined : series.pace[scrub.index];
  const scrubHr = scrub === null ? undefined : series.hr[scrub.index];
  const scrubGrade =
    scrub === null || sample === undefined ? undefined : gradeAt(samples, scrub.index);

  return (
    <div className="profile" ref={holder}>
      <div className="profile-head">
        <span className="stat up num">↑ {formatElevation(ascentM)}</span>
        <span className="stat down num">↓ {formatElevation(descentM)}</span>
        <span className="profile-band num">
          {formatElevation(minElevationM)}–{formatElevation(maxElevationM)}
        </span>
        <span className="spacer" />
        <Toggle on={showAlt} label="Altitude curve" onClick={() => setShowAlt((v) => !v)}>
          <IconMountain size={13} />
        </Toggle>
        {paceRange === null ? null : (
          <Toggle on={showPace} label="Pace curve" onClick={() => setShowPace((v) => !v)}>
            <IconShoe size={13} />
          </Toggle>
        )}
        {hrRange === null ? null : (
          <Toggle on={showHr} label="Heart-rate curve" onClick={() => setShowHr((v) => !v)}>
            <IconHeart size={13} />
          </Toggle>
        )}
      </div>

      <div
        className="profile-chart"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          move(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons !== 0 || e.pointerType === 'mouse') move(e.clientX);
        }}
        onPointerLeave={() => {
          setScrub(null);
          onScrub?.(null);
        }}
      >
        <svg width="100%" height={H + X_AXIS_H} viewBox={`0 0 ${width} ${H + X_AXIS_H}`}>
          <defs>
            <linearGradient id="elevFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0.06" />
            </linearGradient>
          </defs>

          {showAlt
            ? gridLevels(minElevationM, maxElevationM).map((e) => (
                <g key={e}>
                  <line
                    x1={AXIS_LEFT}
                    x2={width}
                    y1={yFor(e)}
                    y2={yFor(e)}
                    stroke="currentColor"
                    strokeWidth={0.5}
                    opacity={0.12}
                  />
                  <text
                    x={AXIS_LEFT - 5}
                    y={yFor(e) + 2.5}
                    fontSize={8}
                    textAnchor="end"
                    fill="currentColor"
                    opacity={0.55}
                  >
                    {formatElevation(e)}
                  </text>
                </g>
              ))
            : null}

          {showAlt ? (
            <>
              <path
                d={`${smoothPath(altPoints)} L${xFor(totalDistanceM)},${H} L${AXIS_LEFT},${H} Z`}
                fill="url(#elevFill)"
              />
              {/* One stroked segment per sample pair, coloured by that
                  segment's grade — the reason the profile reads as terrain and
                  not as a line. */}
              {altPoints.slice(0, -1).map((p, i) => {
                const q = altPoints[i + 1]!;
                return (
                  <line
                    key={i}
                    x1={p[0]}
                    y1={p[1]}
                    x2={q[0]}
                    y2={q[1]}
                    stroke={gradeColor(gradeAt(samples, i))}
                    strokeWidth={3.5}
                    strokeLinecap="round"
                  />
                );
              })}
            </>
          ) : null}

          {showPace && paceRange !== null
            ? curve(series.pace, paceRange, PACE_COLOR, 2.2, 0.95, xFor, samples, bandY)
            : null}
          {showHr && hrRange !== null
            ? curve(series.hr, hrRange, HR_COLOR, 2, 0.9, xFor, samples, bandY)
            : null}

          {showPace && paceRange !== null ? (
            <AverageLine
              values={series.pace}
              range={paceRange}
              color={PACE_COLOR}
              bandY={bandY}
              width={width}
              side="right"
              format={(v) => formatPace(v).replace(/\/km$|\/mi$/, '')}
            />
          ) : null}
          {showHr && hrRange !== null ? (
            <AverageLine
              values={series.hr}
              range={hrRange}
              color={HR_COLOR}
              bandY={bandY}
              width={width}
              side="left"
              format={(v) => `${Math.round(v)} bpm`}
            />
          ) : null}

          {/* Trim: the cut ends stay drawn but greyed, so the shape of what is
              being thrown away is visible while the handles move. */}
          {trim == null ? null : (
            <>
              {trim.fromM > 0 ? (
                <rect
                  x={AXIS_LEFT}
                  y={0}
                  width={Math.max(0, xFor(trim.fromM) - AXIS_LEFT)}
                  height={H}
                  fill="var(--panel-solid)"
                  opacity={0.68}
                />
              ) : null}
              {trim.toM < totalDistanceM ? (
                <rect
                  x={xFor(trim.toM)}
                  y={0}
                  width={Math.max(0, xFor(totalDistanceM) - xFor(trim.toM))}
                  height={H}
                  fill="var(--panel-solid)"
                  opacity={0.68}
                />
              ) : null}
              {[trim.fromM, trim.toM].map((d, i) => (
                <line
                  key={i}
                  x1={xFor(d)}
                  x2={xFor(d)}
                  y1={0}
                  y2={H}
                  stroke="var(--accent)"
                  strokeWidth={1.5}
                />
              ))}
            </>
          )}

          <line
            x1={AXIS_LEFT}
            x2={width}
            y1={H}
            y2={H}
            stroke="currentColor"
            strokeWidth={0.5}
            opacity={0.2}
          />
          {distanceTicks(totalDistanceM).map((d) => (
            <g key={d}>
              <line
                x1={xFor(d)}
                x2={xFor(d)}
                y1={H}
                y2={H + 4}
                stroke="currentColor"
                opacity={0.35}
              />
              <text
                x={xFor(d)}
                y={H + 14}
                fontSize={8}
                textAnchor="middle"
                fill="currentColor"
                opacity={0.55}
              >
                {formatDistance(d)}
              </text>
            </g>
          ))}

          {(notes ?? []).map((n, i) => (
            <g key={n.id}>
              <line
                x1={xFor(n.distanceM)}
                x2={xFor(n.distanceM)}
                y1={16}
                y2={H}
                stroke="var(--accent)"
                opacity={0.25}
              />
              <circle cx={xFor(n.distanceM)} cy={10} r={8} fill="var(--accent)" />
              <text
                x={xFor(n.distanceM)}
                y={13.5}
                fontSize={9}
                fontWeight="bold"
                textAnchor="middle"
                fill="var(--accent-ink)"
              >
                {i + 1}
              </text>
            </g>
          ))}

          {sample === undefined ? null : (
            <>
              <line
                x1={xFor(sample.distanceM)}
                x2={xFor(sample.distanceM)}
                y1={0}
                y2={H}
                stroke="var(--accent)"
                strokeWidth={1}
                opacity={0.5}
              />
              <circle
                cx={xFor(sample.distanceM)}
                cy={yFor(sample.elevationM)}
                r={5.5}
                fill="var(--accent)"
                stroke="var(--accent-ink)"
                strokeWidth={1.5}
              />
            </>
          )}
        </svg>
      </div>

      <div className="profile-readout">
        {sample === undefined ? (
          <span className="dim">
            <IconChart size={11} /> Move across the graph to read the trail
          </span>
        ) : (
          <span className="num">
            {formatElevation(sample.elevationM)} @ {formatDistance(sample.distanceM)}
            {scrubGrade === undefined ? null : (
              <span style={{ color: gradeColor(scrubGrade) }}> · {formatGrade(scrubGrade)}</span>
            )}
            {scrubPace === undefined ? null : (
              <span style={{ color: PACE_COLOR }}> · {formatPace(scrubPace)}</span>
            )}
            {scrubHr === undefined ? null : (
              <span style={{ color: HR_COLOR }}> · {Math.round(scrubHr)} bpm</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/** Grade in percent of the segment starting at `i`. */
function gradeAt(samples: readonly { distanceM: number; elevationM: number }[], i: number): number {
  const a = samples[i];
  const b = samples[i + 1] ?? samples[i];
  if (a === undefined || b === undefined) return 0;
  const run = b.distanceM - a.distanceM;
  if (run <= 0) return 0;
  return ((b.elevationM - a.elevationM) / run) * 100;
}

function extent(values: readonly (number | undefined)[]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  let n = 0;
  for (const v of values) {
    if (v === undefined || !Number.isFinite(v)) continue;
    n++;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return n >= 2 && hi > lo ? [lo, hi] : null;
}

function curve(
  values: readonly (number | undefined)[],
  [lo, hi]: [number, number],
  color: string,
  strokeWidth: number,
  strokeOpacity: number,
  xFor: (d: number) => number,
  samples: readonly { distanceM: number }[],
  bandY: (t: number) => number,
) {
  return curveRuns(values).map((run, i) => {
    const pts = run.map((idx): [number, number] => [
      xFor(samples[idx]!.distanceM),
      bandY((values[idx]! - lo) / (hi - lo)),
    ]);
    return (
      <path
        key={i}
        d={smoothPath(pts)}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeOpacity={strokeOpacity}
        strokeLinecap="round"
      />
    );
  });
}

function AverageLine({
  values,
  range: [lo, hi],
  color,
  bandY,
  width,
  side,
  format,
}: {
  values: readonly (number | undefined)[];
  range: [number, number];
  color: string;
  bandY: (t: number) => number;
  width: number;
  side: 'left' | 'right';
  format: (v: number) => string;
}) {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v === undefined || !Number.isFinite(v)) continue;
    sum += v;
    n++;
  }
  if (n === 0) return null;
  const avg = sum / n;
  const y = bandY((avg - lo) / (hi - lo));
  return (
    <>
      <line
        x1={AXIS_LEFT}
        x2={width - AXIS_RIGHT}
        y1={y}
        y2={y}
        stroke={color}
        strokeWidth={1}
        strokeDasharray="2,4"
        strokeOpacity={0.85}
      />
      <text
        x={side === 'right' ? width - AXIS_RIGHT + 3 : AXIS_LEFT - 3}
        y={y + 3}
        fontSize={8}
        textAnchor={side === 'right' ? 'start' : 'end'}
        fill={color}
      >
        {format(avg)}
      </text>
    </>
  );
}

function Toggle({
  on,
  label,
  onClick,
  children,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="prof-toggle"
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      style={on ? { borderColor: TOGGLE_ON, color: TOGGLE_ON } : undefined}
    >
      {children}
    </button>
  );
}

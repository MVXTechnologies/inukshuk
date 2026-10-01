import { walk } from './__fixtures__/walk';
import type { Stop } from './highlights';
import { buildOutingTimeline, type TimelineNote } from './timeline';
import { buildTrackAxis } from './trackAxis';

// 0–3 km climbing 300 m, 3–6 km back down: summit at 3 km (index 300).
const pts = walk(
  [
    { m: 3000, s: 3000, rise: 300 },
    { m: 3000, s: 3000, rise: -300 },
  ],
  { stepS: 10 },
);
const axis = buildTrackAxis(pts);
const idxAt = (m: number) => Math.round(m / 10);
const extremes = { highIndex: idxAt(3000), lowIndex: 0, highM: 500, lowM: 200 };

const build = (over: {
  notes?: TimelineNote[];
  stops?: Stop[];
  steepest?: Parameters<typeof buildOutingTimeline>[0]['steepest'];
  extremes?: Parameters<typeof buildOutingTimeline>[0]['extremes'];
}) =>
  buildOutingTimeline({
    points: pts,
    axis,
    notes: over.notes ?? [],
    stops: over.stops ?? [],
    steepest: over.steepest ?? { climb: null, descent: null },
    extremes: over.extremes === undefined ? extremes : over.extremes,
  });

describe('buildOutingTimeline', () => {
  it('runs start → landmarks in trail order → finish', () => {
    const ev = build({
      notes: [
        { id: 'a', distanceM: 1000, text: 'Spring', photoUri: 'file:///a.jpg' },
        { id: 'b', distanceM: 4500, text: 'Lookout' },
      ],
      steepest: {
        climb: { startIndex: idxAt(2000), endIndex: idxAt(2400), gradePct: 18, lengthM: 400 },
        descent: { startIndex: idxAt(5000), endIndex: idxAt(5300), gradePct: -14, lengthM: 300 },
      },
    });
    expect(ev.map((e) => e.kind)).toEqual([
      'start',
      'note',
      'steep',
      'summit',
      'note',
      'steep',
      'finish',
    ]);
    expect(ev[1]).toMatchObject({
      noteId: 'a',
      noteNum: 1,
      noteText: 'Spring',
      photoUri: 'file:///a.jpg',
    });
    expect(ev[1]!.at.distanceM).toBeCloseTo(1000, 3);
    expect(ev[2]).toMatchObject({ gradePct: 18, lengthM: 400 });
    expect(ev[3]!.highPointM).toBe(500);
    expect(ev[4]!.noteNum).toBe(2);
    expect(ev[5]).toMatchObject({ gradePct: -14 });
    expect(ev[6]!.at.time).toBe(pts[pts.length - 1]!.time);
  });

  it('folds a stop at the summit into the summit', () => {
    const ev = build({
      stops: [{ kind: 'stop', startIndex: idxAt(3010), endIndex: idxAt(3020), durationS: 1080 }],
    });
    expect(ev.map((e) => e.kind)).toEqual(['start', 'summit', 'finish']);
    expect(ev[1]!.stoppedS).toBe(1080);
  });

  it('prefers the summit over a note when a stop is near both', () => {
    const ev = build({
      notes: [{ id: 'n', distanceM: 3050, text: 'Top cairn' }],
      stops: [{ kind: 'stop', startIndex: idxAt(3000), endIndex: idxAt(3010), durationS: 600 }],
    });
    expect(ev.find((e) => e.kind === 'summit')!.stoppedS).toBe(600);
    expect(ev.find((e) => e.kind === 'note')!.stoppedS).toBeUndefined();
  });

  it('keeps a stop away from everything as its own event, adding up close ones', () => {
    const ev = build({
      stops: [
        { kind: 'stop', startIndex: idxAt(1500), endIndex: idxAt(1500), durationS: 200 },
        { kind: 'stop', startIndex: idxAt(1550), endIndex: idxAt(1560), durationS: 300 },
        { kind: 'stop', startIndex: idxAt(4500), endIndex: idxAt(4500), durationS: 240 },
      ],
    });
    const stops = ev.filter((e) => e.kind === 'stop');
    expect(stops.map((s) => s.stoppedS)).toEqual([500, 240]);
  });

  it('folds stops at the trailhead into start and finish', () => {
    const ev = build({
      stops: [
        { kind: 'stop', startIndex: 0, endIndex: 2, durationS: 300 },
        { kind: 'stop', startIndex: pts.length - 3, endIndex: pts.length - 1, durationS: 400 },
      ],
    });
    expect(ev[0]!.stoppedS).toBe(300);
    expect(ev[ev.length - 1]!.stoppedS).toBe(400);
  });

  it('lists a recording pause on its own', () => {
    const ev = build({
      stops: [
        { kind: 'pause', startIndex: idxAt(3000), endIndex: idxAt(3000) + 1, durationS: 900 },
      ],
    });
    expect(ev.find((e) => e.kind === 'pause')!.pausedS).toBe(900);
    expect(ev.find((e) => e.kind === 'summit')!.stoppedS).toBeUndefined();
  });

  it('puts a high point at the finish on the finish, not a separate summit', () => {
    const ev = build({
      extremes: { highIndex: pts.length - 2, lowIndex: 0, highM: 520, lowM: 200 },
    });
    expect(ev.map((e) => e.kind)).toEqual(['start', 'finish']);
    expect(ev[1]!.highPointM).toBe(520);
    const ev2 = build({ extremes: { highIndex: 1, lowIndex: 100, highM: 520, lowM: 200 } });
    expect(ev2[0]!.highPointM).toBe(520);
  });

  it('shows no summit on a flat outing', () => {
    const ev = build({ extremes: { highIndex: 300, lowIndex: 0, highM: 210, lowM: 200 } });
    expect(ev.map((e) => e.kind)).toEqual(['start', 'finish']);
    expect(build({ extremes: null }).map((e) => e.kind)).toEqual(['start', 'finish']);
  });

  it('works on an untimed route: positions without clock times', () => {
    const route = walk([{ m: 2000, s: 2000, rise: 200 }], { timed: false, stepS: 10 });
    const ev = buildOutingTimeline({
      points: route,
      axis: buildTrackAxis(route),
      notes: [{ id: 'x', distanceM: 500, text: 'Bridge' }],
      stops: [],
      steepest: { climb: null, descent: null },
      extremes: { highIndex: route.length - 1, lowIndex: 0, highM: 400, lowM: 200 },
    });
    expect(ev.map((e) => e.kind)).toEqual(['start', 'note', 'finish']);
    expect(ev.every((e) => e.at.time === undefined)).toBe(true);
  });

  it('is empty for a trail of fewer than two points', () => {
    const one = pts.slice(0, 1);
    expect(
      buildOutingTimeline({
        points: one,
        axis: buildTrackAxis(one),
        notes: [],
        stops: [],
        steepest: { climb: null, descent: null },
        extremes: null,
      }),
    ).toEqual([]);
  });
});

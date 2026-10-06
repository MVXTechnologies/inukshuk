import { lineTrack, offset, outAndBack, T0 } from './__fixtures__/tracks';
import {
  choosePass,
  placeForced,
  placePhoto,
  planPhotoImport,
  type ImportCandidate,
} from './placement';
import { indexTrack, passesNear } from './trackIndex';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('placePhoto', () => {
  const line = indexTrack(lineTrack({ lengthM: 2000 }));

  it('places by time first, and reports how far its GPS is from that spot', () => {
    const r = placePhoto(line, { takenAt: T0 + 800_000, lngLat: offset(805, 6) });
    expect(r.kind).toBe('time');
    if (r.kind !== 'time') return;
    expect(r.position.distanceM).toBeCloseTo(800, 1);
    expect(r.gpsOffM).toBeCloseTo(Math.hypot(5, 6), 0);
    expect(r.takenAt).toBe(T0 + 800_000);
  });

  it('applies the clock offset before the lookup', () => {
    const r = placePhoto(line, { takenAt: T0 + 800_000 - HOUR }, { clockOffsetMs: HOUR });
    expect(r.kind === 'time' && r.position.distanceM).toBeCloseTo(800, 1);
  });

  it('a time outside the outing is "not from this outing", even with GPS on the trail', () => {
    const r = placePhoto(line, { takenAt: T0 + 24 * HOUR, lngLat: offset(800) });
    expect(r).toEqual({ kind: 'outside', reason: 'time' });
  });

  it('falls back to GPS when the photo has no time', () => {
    const r = placePhoto(line, { lngLat: offset(1234, 20) });
    expect(r.kind).toBe('gps');
    if (r.kind !== 'gps') return;
    expect(r.position.distanceM).toBeCloseTo(1234, 0);
    expect(r.offTrackM).toBeCloseTo(20, 0);
  });

  it('places by GPS on an untimed (planned) route, even when the photo has a time', () => {
    const route = indexTrack(lineTrack({ lengthM: 2000, untimed: true }));
    const r = placePhoto(route, { takenAt: T0, lngLat: offset(400, -10) });
    expect(r.kind === 'gps' && r.position.distanceM).toBeCloseTo(400, 0);
  });

  it('rejects a GPS fix far from the trail, and a photo with nothing to go on', () => {
    expect(placePhoto(line, { lngLat: offset(500, 350) })).toEqual({
      kind: 'outside',
      reason: 'far',
    });
    expect(placePhoto(line, { lngLat: offset(500, 350) }, { maxGpsM: 400 }).kind).toBe('gps');
    expect(placePhoto(line, {})).toEqual({ kind: 'outside', reason: 'no-data' });
  });

  describe('out-and-back', () => {
    const oab = indexTrack(outAndBack({ lengthM: 1000, pauseS: 600 }));

    it('time tells the way up from the way down', () => {
      const up = placePhoto(oab, { takenAt: T0 + 300_000, lngLat: offset(300) });
      const down = placePhoto(oab, {
        takenAt: T0 + 1_000_000 + 600_000 + 700_000,
        lngLat: offset(300),
      });
      expect(up.kind === 'time' && Math.round(up.position.distanceM)).toBe(300);
      expect(down.kind === 'time' && Math.round(down.position.distanceM)).toBe(1700);
    });

    it('GPS alone takes the first pass', () => {
      const r = placePhoto(oab, { lngLat: offset(300, 4) });
      expect(r.kind === 'gps' && Math.round(r.position.distanceM)).toBe(300);
    });
  });
});

describe('choosePass', () => {
  const oab = indexTrack(outAndBack({ lengthM: 1000 }));
  const passes = passesNear(oab, offset(300, 3), 50);

  it('picks the pass the recording reached closest to the time hint', () => {
    expect(Math.round(choosePass(oab, passes, T0 + 1_690_000)!.distanceM)).toBe(1700);
    expect(Math.round(choosePass(oab, passes, T0 + 100_000)!.distanceM)).toBe(300);
  });

  it('prefers a clearly closer pass over the time hint', () => {
    // Two passes 40 m apart in offset: the closer one wins whatever the time.
    const near = { ...passes[1]!, offTrackM: 2 };
    const far = { ...passes[0]!, offTrackM: 42 };
    expect(choosePass(oab, [far, near], T0)).toBe(near);
  });

  it('is undefined with no passes, and the first without a time hint', () => {
    expect(choosePass(oab, [], T0)).toBeUndefined();
    expect(choosePass(oab, passes, undefined)).toBe(passes[0]);
  });

  it('a hint on an untimed route keeps the first tied pass', () => {
    const route = indexTrack(
      outAndBack({ lengthM: 1000 }).map((p) => ({ ...p, time: 0, hasTime: false })),
    );
    const routePasses = passesNear(route, offset(300, 3), 50);
    expect(Math.round(choosePass(route, routePasses, T0)!.distanceM)).toBe(300);
  });
});

describe('placeForced', () => {
  const line = indexTrack(lineTrack({ lengthM: 1000 }));

  it('uses the GPS pass at any distance', () => {
    const r = placeForced(line, { lngLat: offset(600, 900) });
    expect(r!.placement).toBe('gps');
    expect(r!.position.distanceM).toBeCloseTo(600, 0);
  });

  it('falls back to the given distance (the profile cursor)', () => {
    const r = placeForced(line, { takenAt: T0 + 99 * HOUR }, 250);
    expect(r!.placement).toBe('manual');
    expect(r!.position.distanceM).toBeCloseTo(250, 3);
    expect(placeForced(line, {})!.position.distanceM).toBe(0);
  });

  it('is null on an empty trail', () => {
    expect(placeForced(indexTrack([]), {})).toBeNull();
  });
});

describe('planPhotoImport', () => {
  const idx = indexTrack(lineTrack({ lengthM: 3000 }));
  const at = (m: number) => T0 + m * 1000;

  const candidates: ImportCandidate[] = [
    { key: 'c', takenAt: at(2000), lngLat: offset(2000, 8) },
    { key: 'a', takenAt: at(500), lngLat: offset(500, -5) },
    { key: 'b', takenAt: at(1200), lngLat: offset(1200, 3) },
    { key: 'gps-only', lngLat: offset(2500, 9) },
    { key: 'next-day', takenAt: at(1000) + 24 * HOUR, lngLat: offset(40_000) },
    { key: 'day-before', takenAt: at(0) - 20 * HOUR },
    { key: 'nothing' },
  ];

  it('groups by time / by location / outside, each in trail order', () => {
    const plan = planPhotoImport(idx, candidates);
    expect(plan.clock.status).toBe('ok');
    expect(plan.clock.samples).toBe(4);
    expect(plan.byTime.map((p) => p.candidate.key)).toEqual(['a', 'b', 'c']);
    expect(plan.byGps.map((p) => p.candidate.key)).toEqual(['gps-only']);
    expect(plan.outside.map((p) => p.candidate.key)).toEqual(['day-before', 'next-day', 'nothing']);
  });

  it('detects a camera an hour behind and places with the correction', () => {
    const behind = candidates.slice(0, 3).map((c) => ({ ...c, takenAt: c.takenAt! - HOUR }));
    const plan = planPhotoImport(idx, behind);
    expect(plan.clock.status).toBe('corrected');
    expect(plan.clock.offsetMs).toBe(HOUR);
    expect(plan.byTime.map((p) => p.candidate.key)).toEqual(['a', 'b', 'c']);
    const a = plan.byTime[0]!.result;
    expect(a.kind === 'time' && a.position.distanceM).toBeCloseTo(500, 0);
  });

  it('uses a manual Adjust offset instead of the estimate', () => {
    const plan = planPhotoImport(idx, candidates.slice(0, 3), { manualClockOffsetMs: 2 * MIN });
    expect(plan.clock).toEqual({ status: 'corrected', offsetMs: 2 * MIN, samples: 3 });
    const zero = planPhotoImport(idx, candidates.slice(0, 3), { manualClockOffsetMs: 0 });
    expect(zero.clock.status).toBe('ok');
  });

  it('checks each camera clock on its own photos', () => {
    // The phone is right; the DSLR (with a GPS dongle) is an hour behind.
    const phone = [500, 1200, 2000].map((m, i) => ({
      key: `p${i}`,
      takenAt: at(m),
      lngLat: offset(m, 4),
      camera: 'samsung SM-S918B',
    }));
    const dslr = [700, 1500, 2600].map((m, i) => ({
      key: `d${i}`,
      takenAt: at(m) - HOUR,
      lngLat: offset(m, 4),
      camera: 'Canon EOS R6',
    }));
    // No make/model: falls back to the batch estimate.
    const anon = { key: 'anon', takenAt: at(900) };
    const plan = planPhotoImport(idx, [...phone, ...dslr, anon]);
    expect(plan.cameraClocks.get('samsung SM-S918B')).toMatchObject({ status: 'ok', offsetMs: 0 });
    expect(plan.cameraClocks.get('Canon EOS R6')).toMatchObject({
      status: 'corrected',
      offsetMs: HOUR,
    });
    expect(plan.byTime.map((p) => [p.candidate.key, p.clockOffsetMs])).toEqual([
      ['p0', 0],
      ['d0', HOUR],
      ['anon', plan.clock.offsetMs],
      ['p1', 0],
      ['d1', HOUR],
      ['p2', 0],
      ['d2', HOUR],
    ]);
    for (const p of plan.byTime.filter((x) => x.candidate.key !== 'anon')) {
      const r = p.result;
      const m = [500, 1200, 2000, 700, 1500, 2600][
        ['p0', 'p1', 'p2', 'd0', 'd1', 'd2'].indexOf(p.candidate.key)
      ]!;
      expect(r.kind === 'time' && r.position.distanceM).toBeCloseTo(m, 0);
    }
  });

  it('falls back to the batch estimate for a camera with too few samples', () => {
    const behind = candidates.slice(0, 3).map((c) => ({ ...c, takenAt: c.takenAt! - HOUR }));
    const lone = { key: 'lone', takenAt: at(1500) - HOUR, camera: 'Old Cam' };
    const plan = planPhotoImport(idx, [...behind, lone]);
    expect(plan.cameraClocks.get('Old Cam')).toMatchObject({ status: 'unknown' });
    expect(plan.byTime.find((p) => p.candidate.key === 'lone')!.clockOffsetMs).toBe(HOUR);
  });

  it('a manual Adjust applies to every camera', () => {
    const plan = planPhotoImport(
      idx,
      candidates.slice(0, 3).map((c) => ({ ...c, camera: 'X' })),
      { manualClockOffsetMs: 2 * MIN },
    );
    expect(plan.byTime.every((p) => p.clockOffsetMs === 2 * MIN)).toBe(true);
    expect(plan.cameraClocks.size).toBe(0);
  });

  it('breaks distance ties by key so the order is stable', () => {
    const twins: ImportCandidate[] = [
      { key: 'z', takenAt: at(100) },
      { key: 'y', takenAt: at(100) },
      { key: 'x2', takenAt: at(5000) + 24 * HOUR },
      { key: 'x1', takenAt: at(5000) + 24 * HOUR },
    ];
    const plan = planPhotoImport(idx, twins);
    expect(plan.byTime.map((p) => p.candidate.key)).toEqual(['y', 'z']);
    expect(plan.outside.map((p) => p.candidate.key)).toEqual(['x1', 'x2']);
  });
});

/** Positions, shares and alerts: the team UI's readings of the data view. */
import {
  addMember,
  device,
  exchange,
  joinReplica,
  MIN,
  newWorld,
  T0,
} from '@core/team/testing/fixtures';

import { alertFor } from './alerts';
import {
  ageBand,
  compassPoint,
  rangeAndBearing,
  shortAge,
  teammatePositions,
  teammatesGeoJson,
} from './positions';
import {
  decodePolyline,
  encodePolyline,
  parseTrack,
  parseWaypoint,
  teamShares,
  TRACK_POLYLINE_BUDGET,
  trackFields,
  waypointFields,
} from './shares';
import { nameText, SYS_PROFILE } from './system';
import { buildTeamView } from './view';

function pair() {
  const w = newWorld();
  const d = device();
  addMember(w.root, d, 'member', T0 + 1);
  const other = joinReplica(w, d, w.root, T0 + 2);
  return { owner: w.root, other };
}

describe('positions', () => {
  it('bands ages and formats them', () => {
    expect([0, 2 * MIN, 2 * MIN + 1, 15 * MIN, 16 * MIN].map(ageBand)).toEqual([
      'fresh',
      'fresh',
      'recent',
      'recent',
      'stale',
    ]);
    expect([0, 59_000, 4 * MIN, 120 * MIN, 50 * 60 * MIN].map(shortAge)).toEqual([
      'now',
      'now',
      '4 min',
      '2 h',
      '2 d',
    ]);
    expect([0, 44, 46, 90, 181, 359, -90].map(compassPoint)).toEqual([
      'N',
      'NE',
      'NE',
      'E',
      'S',
      'N',
      'W',
    ]);
  });

  it("lists the other members' last fixes as GeoJSON, never mine", () => {
    const { owner, other } = pair();
    owner.position(T0 + MIN, { la: 47.07, lo: -70.9, at: T0 + MIN });
    other.position(T0 + MIN, { la: 47.08, lo: -70.91, ac: 5, at: T0 + MIN });
    exchange(owner, other, T0 + MIN);
    other.write(T0 + MIN, 'msg', { id: 'p1', th: SYS_PROFILE, tx: nameText('Julie') });
    exchange(owner, other, T0 + MIN);
    const now = T0 + 20 * MIN;
    const data = owner.data(now);
    const view = buildTeamView({
      state: owner.state,
      data,
      me: owner.id,
      now,
      labels: () => undefined,
    });
    const list = teammatePositions(data.positions, view.members, now);
    expect(list.map((p) => [p.name, p.band, p.accuracy])).toEqual([['Julie', 'stale', 5]]);
    const fc = teammatesGeoJson(list);
    expect(fc.features[0]!.properties).toMatchObject({
      member: other.id,
      initials: 'J',
      ring: 'member',
      band: 'stale',
      label: 'Julie · 19 min',
    });
    expect(fc.features[0]!.geometry).toEqual({ type: 'Point', coordinates: [-70.91, 47.08] });
  });

  it('measures range and bearing to a teammate', () => {
    const r = rangeAndBearing({ latitude: 47, longitude: -71 }, { lat: 47.01, lon: -71 });
    expect(r.meters).toBeGreaterThan(1100);
    expect(r.meters).toBeLessThan(1120);
    expect(r.compass).toBe('N');
  });
});

describe('polyline', () => {
  it("matches Google's reference vector and round-trips", () => {
    const pts: [number, number][] = [
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ];
    expect(encodePolyline(pts)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual(pts);
  });

  it('refuses malformed text without throwing', () => {
    for (const bad of ['_p~iF~ps|U_', ' ', '\u0001\u0002', '~~~~~~~~~~~~~~']) {
      expect(decodePolyline(bad)).toBeNull();
    }
    expect(decodePolyline('')).toEqual([]);
  });
});

describe('shares', () => {
  it('round-trips a waypoint and drops junk', () => {
    const f = waypointFields(
      {
        latitude: 47.1234567,
        longitude: -70.9,
        label: 'Culvert km 3.2',
        icon: 'hazard',
        note: 'Washed out',
      },
      'me',
      T0,
    );
    expect(parseWaypoint('w1', f)).toEqual({
      id: 'w1',
      name: 'Culvert km 3.2',
      lat: 47.123457,
      lon: -70.9,
      note: 'Washed out',
      icon: 'hazard',
      by: 'me',
      at: T0,
    });
    expect(parseWaypoint('w', { ...f, la: 91 })).toBeNull();
    expect(parseWaypoint('w', { ...f, ic: 'rocket' })?.icon).toBeNull();
  });

  it('fits a long recording into one op and keeps its segments', () => {
    // 40 000 fixes, ~2 m apart, zig-zagging: far over the budget unsimplified.
    const points = Array.from({ length: 40_000 }, (_, i) => ({
      latitude: 47 + i * 0.00002,
      longitude: -71 + Math.sin(i / 7) * 0.0004,
    }));
    const f = trackFields({
      name: 'Long day',
      points,
      segmentStarts: [20_000],
      distanceM: 80_000,
      ascentM: 1200,
      startedAt: T0,
      endedAt: T0 + 3_600_000,
      category: 'hike',
    })!;
    expect((f['p'] as string).length).toBeLessThanOrEqual(TRACK_POLYLINE_BUDGET);
    const t = parseTrack('t1', 'owner', f)!;
    expect(t.parts).toHaveLength(2);
    expect(t).toMatchObject({
      name: 'Long day',
      distanceM: 80_000,
      ascentM: 1200,
      category: 'hike',
    });
    expect(
      trackFields({ name: 'x', points: [], distanceM: 0, ascentM: 0, startedAt: T0 }),
    ).toBeNull();
    expect(parseTrack('t', 'o', { p: '###' })).toBeNull();
  });

  it('reads shared waypoints and tracks from the replica', () => {
    const { owner, other } = pair();
    owner.write(T0 + MIN, 'e.set', {
      k: 'wpt',
      id: 'w1',
      f: waypointFields({ latitude: 47, longitude: -71, label: 'Camp' }, owner.id, T0 + MIN),
    });
    const tf = trackFields({
      name: 'Loop',
      points: [
        { latitude: 47, longitude: -71 },
        { latitude: 47.01, longitude: -71.01 },
      ],
      distanceM: 1400,
      ascentM: 20,
      startedAt: T0,
    })!;
    other.write(T0 + MIN, 'e.set', { k: 'track', id: 't1', f: tf });
    exchange(owner, other, T0 + 2 * MIN);
    const shares = teamShares(owner.data(T0 + 2 * MIN));
    expect(shares.waypoints.map((w) => w.name)).toEqual(['Camp']);
    expect(shares.tracks.map((t) => [t.name, t.owner])).toEqual([['Loop', other.id]]);
  });
});

describe('alerts', () => {
  it('alerts on team messages per the core routing, never on sys: threads', () => {
    const { owner, other } = pair();
    const plain = { id: 'a', th: 'team', tx: 'On arrive' };
    const op = other.write(T0 + MIN, 'msg', plain)!;
    const urgentBody = { id: 'b', th: 'team', tx: 'Blessé au km 4' };
    const urgent = other.write(T0 + MIN, 'msg', urgentBody, { pr: 2 })!;
    const sysBody = { id: 'c', th: SYS_PROFILE, tx: nameText('Julie') };
    const sys = other.write(T0 + MIN, 'msg', sysBody)!;
    exchange(owner, other, T0 + MIN);
    expect(alertFor(owner.state, op, plain, owner.id)).toMatchObject({
      level: 'badge',
      text: 'On arrive',
    });
    expect(alertFor(owner.state, urgent, urgentBody, owner.id)).toMatchObject({
      level: 'alert',
      priority: 2,
    });
    expect(alertFor(owner.state, sys, sysBody, owner.id)).toBeNull();
    expect(alertFor(owner.state, op, plain, other.id)).toBeNull(); // my own
    expect(alertFor(owner.state, op, undefined, owner.id)).toBeNull();
  });
});

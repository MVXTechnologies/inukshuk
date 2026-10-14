import {
  destinationName,
  destinationWaypoint,
  effectiveTarget,
  nearestWaypoints,
  resolveTarget,
  targetOpen,
} from './target';
import { QC, snapshot } from './testUtils';
import type { FollowSnapshot } from './types';

const PIN = { name: 'Camp lac', point: { latitude: 46.82, longitude: -71.2 } };
const FOLLOW: FollowSnapshot = {
  targetKind: 'note',
  targetId: 'n1',
  targetName: 'Source',
  targetPoint: { latitude: 46.815, longitude: -71.205 },
  targetDistanceM: 620,
  crossTrackM: 4,
  onTrail: true,
};

describe('effectiveTarget', () => {
  it("follows the strip's target unless the field picks its own", () => {
    const strip = { kind: 'navTarget' } as const;
    expect(effectiveTarget(null, strip)).toBe(strip);
    expect(effectiveTarget(undefined, strip)).toBe(strip);
    const own = { kind: 'waypoint', waypointId: 'w' } as const;
    expect(effectiveTarget(own, strip)).toBe(own);
  });
});

describe('resolveTarget', () => {
  it('nav target: the destination pin, or nothing', () => {
    expect(resolveTarget({ kind: 'navTarget' }, snapshot())).toBeNull();
    expect(resolveTarget({ kind: 'navTarget' }, snapshot({ navTarget: PIN }))).toEqual({
      ...PIN,
      glyph: 'flag',
      alongTrailM: null,
    });
  });

  it("nav target while following: the trail's next target, along the trail", () => {
    expect(
      resolveTarget({ kind: 'navTarget' }, snapshot({ navTarget: PIN, follow: FOLLOW })),
    ).toEqual({ name: 'Source', point: FOLLOW.targetPoint, glyph: 'route', alongTrailM: 620 });
  });

  it('next on trail: only while following', () => {
    expect(resolveTarget({ kind: 'nextOnTrail' }, snapshot({ navTarget: PIN }))).toBeNull();
    expect(resolveTarget({ kind: 'nextOnTrail' }, snapshot({ follow: FOLLOW }))?.name).toBe(
      'Source',
    );
  });

  it('a waypoint by id, gone when it is deleted', () => {
    const waypoints = { w1: PIN };
    expect(resolveTarget({ kind: 'waypoint', waypointId: 'w1' }, snapshot({ waypoints }))).toEqual({
      ...PIN,
      glyph: 'place',
      alongTrailM: null,
    });
    expect(
      resolveTarget({ kind: 'waypoint', waypointId: 'w2' }, snapshot({ waypoints })),
    ).toBeNull();
  });

  it('a coordinate: its label, or the point in the Settings format', () => {
    expect(
      resolveTarget({ kind: 'coordinate', point: QC, label: 'Borne 23A' }, snapshot())?.name,
    ).toBe('Borne 23A');
    const t = resolveTarget({ kind: 'coordinate', point: QC }, snapshot());
    expect(t).toEqual({
      name: '46.8139, -71.2076',
      point: QC,
      glyph: 'my_location',
      alongTrailM: null,
    });
  });
});

describe('targetOpen (#696: a tap on the target name)', () => {
  it('a saved waypoint opens its card, while it exists', () => {
    const waypoints = { w1: PIN };
    const t = { kind: 'waypoint', waypointId: 'w1' } as const;
    expect(targetOpen(t, snapshot({ waypoints }))).toEqual({ kind: 'waypoint', waypointId: 'w1' });
    expect(targetOpen(t, snapshot())).toBeNull();
  });

  it("the followed trail's next target: a waypoint's card, else the point chip on it", () => {
    const onWaypoint = { ...FOLLOW, targetKind: 'waypoint' as const, targetId: 'w9' };
    const end = { ...FOLLOW, targetKind: 'end' as const, targetId: 'end' };
    for (const kind of ['navTarget', 'nextOnTrail'] as const) {
      expect(targetOpen({ kind }, snapshot({ navTarget: PIN, follow: onWaypoint }))).toEqual({
        kind: 'waypoint',
        waypointId: 'w9',
      });
      expect(targetOpen({ kind }, snapshot({ follow: FOLLOW }))).toEqual({
        kind: 'point',
        point: FOLLOW.targetPoint,
      });
      expect(targetOpen({ kind }, snapshot({ follow: end }))).toEqual({
        kind: 'point',
        point: FOLLOW.targetPoint,
      });
    }
    expect(targetOpen({ kind: 'nextOnTrail' }, snapshot({ navTarget: PIN }))).toBeNull();
  });

  it('the destination pin, or a typed coordinate: the point chip there', () => {
    expect(targetOpen({ kind: 'navTarget' }, snapshot({ navTarget: PIN }))).toEqual({
      kind: 'point',
      point: PIN.point,
    });
    expect(targetOpen({ kind: 'navTarget' }, snapshot())).toBeNull();
    expect(targetOpen({ kind: 'coordinate', point: QC }, snapshot())).toEqual({
      kind: 'point',
      point: QC,
    });
  });
});

describe('targetOpen: a destination set on a saved waypoint (#696 QA 11a)', () => {
  it("opens the waypoint's card, never the bare point chip (no duplicate Waypoint)", () => {
    const onWaypoint = { ...PIN, waypointId: 'w7' };
    expect(targetOpen({ kind: 'navTarget' }, snapshot({ navTarget: onWaypoint }))).toEqual({
      kind: 'waypoint',
      waypointId: 'w7',
    });
  });
});

describe('destinationWaypoint', () => {
  it('the saved waypoint within 2 m of the destination, else undefined', () => {
    const camp = { id: 'c', latitude: 46.82, longitude: -71.2 };
    expect(destinationWaypoint({ latitude: 46.82001, longitude: -71.2 }, [camp])).toBe(camp);
    expect(destinationWaypoint({ latitude: 46.8201, longitude: -71.2 }, [camp])).toBeUndefined();
  });
});

describe('destinationName', () => {
  const camp = { latitude: 46.82, longitude: -71.2, label: 'Camp lac' };
  it("takes the saved waypoint's name it was set on, else Destination", () => {
    expect(destinationName({ latitude: 46.82, longitude: -71.2 }, [camp])).toBe('Camp lac');
    // ~1 m off still is that waypoint; ~11 m is not.
    expect(destinationName({ latitude: 46.82001, longitude: -71.2 }, [camp])).toBe('Camp lac');
    expect(destinationName({ latitude: 46.8201, longitude: -71.2 }, [camp])).toBe('Destination');
    expect(destinationName(QC, [])).toBe('Destination');
  });
});

describe('nearestWaypoints (the target picker)', () => {
  const far = { id: 'far', latitude: 47.5, longitude: -70, label: 'Far' };
  const mid = { id: 'mid', latitude: 46.9, longitude: -71.2, label: 'Mid' };
  const near = { id: 'near', latitude: 46.814, longitude: -71.208, label: 'Near' };

  it('nearest first, cut to the limit', () => {
    expect(nearestWaypoints([far, mid, near], QC, 2).map((w) => w.id)).toEqual(['near', 'mid']);
  });

  it('without a place: as stored', () => {
    expect(nearestWaypoints([far, mid, near], null, 2).map((w) => w.id)).toEqual(['far', 'mid']);
  });
});

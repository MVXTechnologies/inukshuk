import { spokenDirection, waypointRowDetail, waypointsByDistance } from './waypointsByDistance';

const HERE = { latitude: 46.8139, longitude: -71.2082 };
/** A point `dn` metres north and `de` metres east of HERE (small offsets). */
const off = (id: string, dn: number, de: number) => ({
  id,
  latitude: HERE.latitude + dn / 111_195,
  longitude: HERE.longitude + de / (111_195 * Math.cos((HERE.latitude * Math.PI) / 180)),
});

describe('waypointsByDistance', () => {
  it('lists the pins nearest first, with distance and bearing', () => {
    const list = waypointsByDistance(
      [off('far', 900, 0), off('near', 0, 100), off('mid', -400, 0)],
      HERE,
    );
    expect(list.map((n) => n.item.id)).toEqual(['near', 'mid', 'far']);
    expect(list[0]?.distanceM).toBeCloseTo(100, 0);
    expect(list[0]?.bearingDeg).toBeCloseTo(90, 0);
    expect(list[1]?.bearingDeg).toBeCloseTo(180, 0);
    expect(list[2]?.bearingDeg).toBeCloseTo(0, 0);
  });

  it('keeps the input order for pins at the same spot', () => {
    const list = waypointsByDistance([off('b', 50, 0), off('a', 50, 0), off('c', 10, 0)], HERE);
    expect(list.map((n) => n.item.id)).toEqual(['c', 'b', 'a']);
  });

  it('leaves out a pin whose coordinate is not a place', () => {
    const bad = { id: 'bad', latitude: Number.NaN, longitude: -71 };
    const list = waypointsByDistance([bad, off('ok', 10, 0)], HERE);
    expect(list.map((n) => n.item.id)).toEqual(['ok']);
  });

  it('is empty for no pins, and a pin on the origin is 0 m with bearing 0', () => {
    expect(waypointsByDistance([], HERE)).toEqual([]);
    const [only] = waypointsByDistance([{ id: 'x', ...HERE }], HERE);
    expect(only).toMatchObject({ distanceM: 0, bearingDeg: 0 });
  });
});

describe('spokenDirection', () => {
  it.each([
    [0, 'north'],
    [44, 'north-east'],
    [90, 'east'],
    [135, 'south-east'],
    [180, 'south'],
    [225, 'south-west'],
    [270, 'west'],
    [315, 'north-west'],
    [350, 'north'],
    [-90, 'west'],
    [720, 'north'],
  ])('%s° is %s', (deg, word) => {
    expect(spokenDirection(deg)).toBe(word);
  });
});

describe('waypointRowDetail', () => {
  it('reads distance and direction', () => {
    expect(waypointRowDetail('120 m', { item: null, distanceM: 120, bearingDeg: 50 })).toBe(
      '120 m north-east',
    );
  });

  it('says "here" for a pin under you', () => {
    expect(waypointRowDetail('0 m', { item: null, distanceM: 0.4, bearingDeg: 0 })).toBe('here');
  });
});

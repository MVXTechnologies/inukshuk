import {
  groupTrails,
  matchesActivity,
  nearScore,
  rankTrails,
  sortRanked,
  trailDistanceM,
  trailsNearYou,
} from './rank';
import { QUEBEC_CITY, sampleIndex, trailById } from './__fixtures__/trails';

const index = sampleIndex();
const ids = (list: { trail: { id: string } }[]) => list.map((r) => r.trail.id);

describe('near-you ranking', () => {
  it('measures to the trail line, not its bbox corner', () => {
    const caps = trailById(index, 'r8730405');
    const d = trailDistanceM(caps, QUEBEC_CITY);
    expect(d).toBeGreaterThan(35_000);
    expect(d).toBeLessThan(60_000);
    // Inside the bbox, still off the line.
    expect(trailDistanceM(caps, [-70.74, 47.3])).toBeGreaterThan(5_000);
    expect(trailDistanceM({ ...caps, thumb: [] }, QUEBEC_CITY)).toBeGreaterThan(30_000);
  });

  it('mixes popularity and proximity', () => {
    expect(nearScore(0.8, 60_000)).toBeGreaterThan(nearScore(0.45, 45_000));
    // A regional trail next door beats a famous one on another continent.
    expect(nearScore(1, 5_000_000)).toBeLessThan(nearScore(0.4, 10_000));
  });

  it('keeps near trails and tops up to three', () => {
    const ranked = rankTrails(index.trails, QUEBEC_CITY);
    const near = trailsNearYou(ranked);
    // Route Verte 5 and the Caps are within 300 km; the Long Trail (~250 km) too.
    expect(ids(near)).toEqual(['r416109', 'r391736', 'r8730405']);
    // A tighter radius keeps two, then the nearest other fills the third slot.
    const tight = trailsNearYou(ranked, { radiusKm: 100 });
    expect(ids(tight).slice(0, 2).sort()).toEqual(['r416109', 'r8730405']);
    expect(tight).toHaveLength(3);
    expect(trailsNearYou(ranked, { limit: 0 })).toEqual([]);
    expect(ids(trailsNearYou(ranked, { activity: 'cycling' }))).toEqual(['r416109']);
  });

  it('falls back to the most popular worldwide without a position', () => {
    const ranked = rankTrails(index.trails, null);
    expect(ranked.every((r) => r.distanceM === null)).toBe(true);
    expect(ids(trailsNearYou(ranked, { limit: 2 }))).toEqual(['r9454', 'r391736']);
  });

  it('filters by activity', () => {
    expect(matchesActivity(trailById(index, 'r416109'), 'hiking')).toBe(false);
    expect(matchesActivity(trailById(index, 'r416109'), null)).toBe(true);
  });

  it('sorts four ways', () => {
    const ranked = rankTrails(index.trails, QUEBEC_CITY);
    expect(ids(sortRanked(ranked, 'nearest'))[0]).toBe('r416109');
    expect(ids(sortRanked(ranked, 'popular'))[0]).toBe('r9454');
    expect(ids(sortRanked(ranked, 'longest'))[0]).toBe('r416109');
    expect(ids(sortRanked(ranked, 'name'))[0]).toBe('r391736');
  });
});

describe('groupTrails', () => {
  it('leads with popular near you, then home-continent countries, then other continents', () => {
    const ranked = rankTrails(index.trails, QUEBEC_CITY);
    const groups = groupTrails(ranked, index, 'nearest', { popularCount: 1 });
    expect(groups.map((g) => g.title)).toEqual([
      'POPULAR NEAR YOU',
      'CANADA',
      'UNITED STATES',
      'EUROPE',
    ]);
    expect(ids(groups[1]!.entries)).toEqual(['r8730405']);
    expect(ids(groups[3]!.entries)).toEqual(['r9454']);
  });

  it('says MOST POPULAR without a position and parks unknown countries last', () => {
    const noCountry = { ...trailById(index, 'r8730405'), id: 'rX', countries: [] };
    const ranked = rankTrails([...index.trails, noCountry], null);
    const groups = groupTrails(ranked, index, 'popular', {
      popularCount: 1,
      homeContinent: 'Europe',
    });
    expect(groups[0]?.title).toBe('MOST POPULAR');
    expect(groups[groups.length - 1]?.title).toBe('OTHER');
    expect(groups.map((g) => g.title)).toContain('NORTH AMERICA');
  });
});

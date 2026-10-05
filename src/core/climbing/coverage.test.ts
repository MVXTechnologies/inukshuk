import { coverageSummary, parseClimbingCoverage } from './coverage';

const desc = JSON.stringify({
  crags: 10550,
  routes: 231937,
  version: '202610052200',
  ordered: 312,
  sources: {
    ob: { crags: 10000, routes: 225000 },
    osm: { crags: 900, routes: 7000 },
    c2c: { crags: 3, routes: 0 },
  },
});

describe('climbing coverage', () => {
  it('reads the TileJSON description', () => {
    const c = parseClimbingCoverage({ tilejson: '3.0.0', description: desc })!;
    expect(c.version).toBe('202610052200');
    expect(c.sources.map((s) => [s.key, s.crags])).toEqual([
      ['ob', 10000],
      ['osm', 900],
      ['c2c', 3],
    ]);
    expect(coverageSummary(c)).toBe('10,550 crags · 231,937 routes, from 3 open sources');
    expect(coverageSummary(null)).toBe('Counts load when you are online');
  });

  it('rejects anything else', () => {
    expect(parseClimbingCoverage({ description: 'not json' })).toBeNull();
    expect(parseClimbingCoverage({ description: '{"crags":1}' })).toBeNull();
    expect(parseClimbingCoverage({ description: '{"version":"../x"}' })).toBeNull();
    expect(parseClimbingCoverage(null)).toBeNull();
    const bare = parseClimbingCoverage({ version: 'v1' })!;
    expect(bare.crags).toBe(0);
    expect(coverageSummary(bare)).toBe('0 crags · 0 routes, from 0 open sources');
  });
});

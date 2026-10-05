import { parseTideCoverage, tideCoverageRows, tideCoverageSummary } from './coverage';

// The live archive's TileJSON description (2026-10-05 build).
const TILEJSON = {
  description: '{"v":1,"updated":"2026-10-05","counts":{"0":2142,"1":446,"2":33,"3":239}}',
};

describe('tide coverage', () => {
  it('lists Canada (live, no count) first, then our sources by station count', () => {
    const c = parseTideCoverage(TILEJSON);
    expect(tideCoverageRows(c).map((r) => [r.source.key, r.stations])).toEqual([
      ['ca-chs', null],
      ['us-coops', 2142],
      ['fr-shom', 446],
      ['jp-jma', 239],
      ['no-kartverket', 33],
    ]);
    expect(tideCoverageSummary(c)).toBe(
      '2,860 stations + Canada live from CHS · updated 2026-10-05',
    );
  });

  it('works offline with no counts', () => {
    expect(parseTideCoverage({ description: 'junk' })).toBeNull();
    expect(tideCoverageRows(null)).toHaveLength(5);
    expect(tideCoverageSummary(null)).toContain('Canada (live from CHS)');
  });
});

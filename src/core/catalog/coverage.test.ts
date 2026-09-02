import {
  dedupeByCoverage,
  ntsCoverageKey,
  SOURCE_RANK_CANMATRIX,
  SOURCE_RANK_CANTOPO,
} from './coverage';

const cantopo = (sheet: string) => ({
  id: `cantopo-${sheet.toLowerCase()}`,
  coverageKey: ntsCoverageKey(sheet),
  sourceRank: SOURCE_RANK_CANTOPO,
});
const canmatrix = (sheet: string, half?: 'e' | 'w') => ({
  id: `canmatrix-${sheet.toLowerCase()}${half ?? ''}`,
  coverageKey: ntsCoverageKey(sheet),
  sourceRank: SOURCE_RANK_CANMATRIX,
});

describe('ntsCoverageKey', () => {
  it('names the ground, not the product', () => {
    expect(ntsCoverageKey('021l14')).toBe('nts50k:021L14');
    expect(ntsCoverageKey('021L14')).toBe(ntsCoverageKey('021l14'));
  });
});

describe('dedupeByCoverage', () => {
  it('keeps the modern GeoPDF and drops the scan of the same sheet', () => {
    const { kept, dropped } = dedupeByCoverage([canmatrix('031G05'), cantopo('031G05')]);
    expect(kept.map((i) => i.id)).toEqual(['cantopo-031g05']);
    expect(dropped).toEqual([
      { id: 'canmatrix-031g05', coverageKey: 'nts50k:031G05', supersededBy: 'cantopo-031g05' },
    ]);
  });

  it('keeps the scan where no GeoPDF exists — Québec City', () => {
    // 021L14 has no CanTopo edition; without CanMatrix the city is uncovered.
    const { kept, dropped } = dedupeByCoverage([canmatrix('021L14'), cantopo('031G05')]);
    expect(kept.map((i) => i.id).sort()).toEqual(['canmatrix-021l14', 'cantopo-031g05']);
    expect(dropped).toEqual([]);
  });

  it('keeps BOTH halves of a half-sheet, and drops both when a GeoPDF supersedes them', () => {
    // A few dozen sheets were printed in two halves. They share a coverage
    // key, so keeping "one item per key" would silently lose half the map.
    const halves = [canmatrix('013D04', 'e'), canmatrix('013D04', 'w')];
    expect(dedupeByCoverage(halves).kept).toHaveLength(2);

    const withModern = dedupeByCoverage([...halves, cantopo('013D04')]);
    expect(withModern.kept.map((i) => i.id)).toEqual(['cantopo-013d04']);
    expect(withModern.dropped.map((d) => d.id)).toEqual(['canmatrix-013d04e', 'canmatrix-013d04w']);
  });

  it('never thins a source that does not opt in', () => {
    const plain = [{ id: 'ustopo-a' }, { id: 'ustopo-b' }, { id: 'austopo-c', coverageKey: '' }];
    expect(dedupeByCoverage(plain).kept).toHaveLength(3);
  });

  it('preserves input order among the winners', () => {
    const items = [cantopo('031G05'), canmatrix('021L14'), cantopo('021L15')];
    expect(dedupeByCoverage(items).kept.map((i) => i.id)).toEqual([
      'cantopo-031g05',
      'canmatrix-021l14',
      'cantopo-021l15',
    ]);
  });

  it('is order-independent: the same set in, the same winners out', () => {
    const forward = dedupeByCoverage([canmatrix('031G05'), cantopo('031G05')]);
    const reverse = dedupeByCoverage([cantopo('031G05'), canmatrix('031G05')]);
    expect(forward.kept.map((i) => i.id)).toEqual(reverse.kept.map((i) => i.id));
  });

  it('treats a missing rank as zero, so an untagged source loses to a ranked one', () => {
    const untagged = { id: 'other-021l14', coverageKey: ntsCoverageKey('021L14') };
    const { kept } = dedupeByCoverage([untagged, canmatrix('021L14')]);
    expect(kept.map((i) => i.id)).toEqual(['canmatrix-021l14']);
  });

  it('ranks CanTopo above CanMatrix, with room to slot a source between them', () => {
    expect(SOURCE_RANK_CANTOPO).toBeGreaterThan(SOURCE_RANK_CANMATRIX);
    expect(SOURCE_RANK_CANTOPO - SOURCE_RANK_CANMATRIX).toBeGreaterThan(1);
  });
});

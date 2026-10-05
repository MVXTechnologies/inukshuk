import { coverageRows, coverageSummary, formatCount, parseGeodeticCoverage } from './coverage';

/** The live archive's TileJSON on 2026-10-05 (trimmed). */
const TILEJSON = {
  name: 'Inukshuk geodetic points',
  description:
    '{"v":1,"updated":"2026-10-05","counts":{"0":80322,"2":632695,"3":0},"vd":{"0":31000,"2":350000}}',
  attribution: '© Gouvernement du Québec (MRNF) · CC BY 4.0 · NOAA National Geodetic Survey',
};

describe('geodetic coverage', () => {
  it('reads the build date and per-source counts from the TileJSON', () => {
    const c = parseGeodeticCoverage(TILEJSON);
    expect(c?.updated).toBe('2026-10-05');
    expect([...(c?.counts ?? new Map())]).toEqual([
      [0, 80322],
      [2, 632695],
    ]);
    expect([...(c?.vdatums ?? new Map())]).toEqual([
      [0, 31000],
      [2, 350000],
    ]);
    // archives built before the vd counts: none, not an error
    expect(parseGeodeticCoverage('{"updated":"2026-10-05","counts":{}}')?.vdatums.size).toBe(0);
  });

  it('lists sources with marks, most first, and sums them up', () => {
    const c = parseGeodeticCoverage(TILEJSON);
    if (!c) throw new Error('no coverage');
    expect(coverageRows(c).map((r) => [r.source.key, r.marks])).toEqual([
      ['us-ngs', 632695],
      ['qc-mrnf', 80322],
    ]);
    expect(coverageSummary(c)).toBe('2 agencies · 713 k marks · updated 2026-10-05');
    expect(coverageSummary(null)).toBe('Official survey agencies + OpenStreetMap');
  });

  it('rejects anything that is not ours', () => {
    expect(parseGeodeticCoverage(null)).toBeNull();
    expect(parseGeodeticCoverage({ description: 'Inukshuk peaks' })).toBeNull();
    expect(parseGeodeticCoverage({ description: '{"updated":"yesterday"}' })).toBeNull();
    expect(
      parseGeodeticCoverage('{"updated":"2026-10-05","counts":{"x":1,"1":-5}}')?.counts.size,
    ).toBe(0);
  });

  it('formats counts', () => {
    expect(formatCount(950)).toBe('950');
    expect(formatCount(80322)).toBe('80 k');
    expect(formatCount(1_234_000)).toBe('1.2 M');
    expect(formatCount(12_000_000)).toBe('12 M');
  });
});

/**
 * The 2026-10-05 NAS run, frozen (`__fixtures__/validation-2026-10-05.json`):
 * every ellipsoidal chart datum checked against an agency oracle
 * (`infra/tiles/nas/tides/derive.py`) and every tidal benchmark checked
 * against the geodetic agency's levelled height (`join_geodetic.py`).
 *
 * The rule under test, for field use: a derived value is shown only when its
 * oracle agrees within tolerance; a value the oracle contradicts — or that no
 * oracle could check — is hidden. The summaries are recomputed from the rows
 * so the report can't drift from the data.
 */
import run from './__fixtures__/validation-2026-10-05.json';

type EllRow = [string, number | null, number | null, number | null, boolean | null, string?];
type BmRow = [string, number, boolean];

const ell = run.ellipsoid as EllRow[];
const bms = run.benchmarks as BmRow[];
const src = (station: string) => station.split(':')[0] ?? '';

describe('ellipsoidal chart datum vs agency oracles (2026-10-05)', () => {
  it('shows a value exactly when its oracle agrees within 5 cm', () => {
    for (const [station, value, oracle, delta, pass] of ell) {
      if (pass === null) continue; // no oracle answer → hidden, never guessed
      expect(value).not.toBeNull();
      expect(oracle).not.toBeNull();
      expect(Math.abs((value ?? 0) - (oracle ?? 0) - (delta ?? 0))).toBeLessThan(1e-3);
      expect([station, pass]).toEqual([station, Math.abs(delta ?? 1) <= run.tolerance.ellipsoidM]);
    }
  });

  it.each([
    ['us-coops', 606, 51, 286],
    ['fr-shom', 73, 38, 148],
    ['no-kartverket', 32, 0, 0],
  ])(
    '%s: %i shown, %i hidden on disagreement, %i hidden unchecked',
    (key, shown, fail, unchecked) => {
      const rows = ell.filter((r) => src(r[0]) === key);
      expect(rows.filter((r) => r[4] === true)).toHaveLength(shown);
      expect(rows.filter((r) => r[4] === false)).toHaveLength(fail);
      expect(rows.filter((r) => r[4] === null)).toHaveLength(unchecked);
      const worstShown = Math.max(
        ...rows.filter((r) => r[4] === true).map((r) => Math.abs(r[3] ?? 0)),
      );
      expect(worstShown).toBeLessThanOrEqual(0.05);
      const summary = run.summary.ellipsoid[key as keyof typeof run.summary.ellipsoid];
      expect(summary.maxAbsDeltaShownM).toBeCloseTo(worstShown, 4);
    },
  );
});

describe('tidal benchmarks: CD height + station offset vs the levelled height (2026-10-05)', () => {
  it('joins only marks within 10 cm, and lists every rejection', () => {
    for (const [, delta, pass] of bms)
      expect(pass).toBe(Math.abs(delta) <= run.tolerance.benchmarkM);
    const failures = bms.filter((r) => !r[2]);
    expect(failures).toHaveLength(run.benchmarkFailures.length);
    expect(failures).toHaveLength(112);
  });

  it.each([
    ['us-coops', 3340, 0.094],
    ['fr-shom', 146, 0.016],
  ])('%s: %i checked marks joined, worst |Δ| %f m', (key, joined, worst) => {
    const s = run.summary.benchmarks[key as keyof typeof run.summary.benchmarks];
    expect(s.pass).toBe(joined);
    expect(s.maxAbsDeltaShownM).toBe(worst);
    expect(s.medianAbsDeltaM).toBeLessThanOrEqual(0.002);
  });
});

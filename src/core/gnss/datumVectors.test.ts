/**
 * CI gate for the GNSS output datum (geodesy field-grade rule): every
 * scenario must still plan the exact validated pipeline, PROJ's frozen
 * result must agree with the official tool within tolerance, and every
 * validation pair named must exist in Convert's official-tool suite. A
 * drift in any of them fails here; the host runner re-runs PROJ itself
 * (`datumVectors.host.test.ts`).
 */
import reference from '../convert/fixtures/reference.json';
import { deltas, withinTolerance, type Suite } from '../convert/suite';
import vectorFile from './fixtures/datum-vectors.json';
import {
  epochToMs,
  planVector,
  VECTOR_COMPARE,
  type DatumVector,
  type DatumVectorFile,
} from './datumVectors';

const file = vectorFile as unknown as DatumVectorFile;
const suite = reference as unknown as Suite;

describe('GNSS datum validation vectors', () => {
  it('cover the official tools named by the geodesy rule', () => {
    const tools = new Set(file.vectors.map((v) => v.source.tool.split(' (')[0]));
    expect(tools).toEqual(
      new Set(['NRCan TRX web service', 'NRCan GPS·H web service', 'NOAA NCAT llh']),
    );
    for (const v of file.vectors) expect(v.source.date).toMatch(/^2026-\d\d-\d\dT/);
  });

  it.each(file.vectors.map((v) => [v.id, v] as const))(
    '%s: plans the frozen pipeline',
    (_id, v: DatumVector) => {
      const r = planVector(v);
      if (!r.ok) throw new Error(r.refusal.message);
      expect(r.out.plan?.pipeline).toBe(v.pipeline);
      expect(r.out.plan?.inDim).toBe(v.inDim);
      expect(r.out.validation).toEqual(v.validation);
      if (v.inDim === 4) expect(r.out.plan?.tValue).toBeCloseTo(v.obsEpoch, 9);
    },
  );

  it.each(file.vectors.map((v) => [v.id, v] as const))(
    '%s: frozen PROJ agrees with the official tool',
    (_id, v: DatumVector) => {
      const d = deltas(VECTOR_COMPARE, v.proj, v.expected, v.expected[1] ?? v.input[1]);
      expect(withinTolerance(d, v.tol)).toBe(true);
      // and the comparison is not vacuous
      expect(d.horizontalM !== null || d.verticalM !== null).toBe(true);
    },
  );

  it('every validation pair exists and is validated in the Convert reference suite', () => {
    const pairs = new Map(suite.pairs.map((p) => [p.id, p]));
    for (const v of file.vectors) {
      for (const id of v.validation) {
        expect(pairs.get(id)?.status).toMatch(/^validated-/);
      }
    }
  });

  it('epochToMs inverts decimalYear', () => {
    expect(epochToMs(2026.75)).toBe(Date.UTC(2026, 0, 1) + 273.75 * 86_400_000);
  });
});

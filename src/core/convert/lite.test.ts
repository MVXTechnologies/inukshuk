/**
 * lite.ts (proj4js) must reproduce every grid-free pair of the official-tool
 * reference suite (CONVERT §5.5): `pass` points within the pair tolerance,
 * known gaps (GN 7-2 print errors) within 1 mm of the frozen PROJ value.
 */
import reference from './fixtures/reference.json';
import { compileLite, liteEngine } from './lite';
import { deltas, fillPipeline, pointInput, refLatOf, withinTolerance, type Suite } from './suite';

const suite = reference as unknown as Suite;
const gridFree = suite.pairs.filter(
  (p) => p.pipeline && compileLite(fillPipeline(p.pipeline)) !== null,
);

describe('lite engine on the reference suite', () => {
  it('covers the projection and geocentric pairs', () => {
    const ids = gridFree.map((p) => p.id);
    for (const must of [
      'CA-PROJ-EPSG2949',
      'CA-PROJ-EPSG6622',
      'CA-PROJ-EPSG2953',
      'US-SPC-EPSG6423',
      'US-UTM-EPSG6339',
      'FR-L93',
      'FR-CC44-Circe',
      'NO-UTM-EPSG25833',
      'US-ECEF',
      'GN72-Geocentric-inverse',
      'GN72-HotineB',
      'GN72-ObliqueStereo',
      'GN72-LCC2SP',
    ]) {
      expect(ids).toContain(must);
    }
    // Grids and Helmerts are never "lite".
    expect(
      ids.some((id) => id.startsWith('CA-H-') || id.startsWith('CA-NTV2') || id.startsWith('CH-')),
    ).toBe(false);
  });

  const cases = gridFree.flatMap((p) =>
    p.points.filter((q) => q.status !== 'informational').map((q) => [p.id, q.id, p, q] as const),
  );
  it.each(cases)('%s / %s', (_pid, _qid, pair, pt) => {
    const { coords, dim } = pointInput(pt);
    const r = liteEngine.transform({
      pipeline: fillPipeline(pair.pipeline as string, pt.params),
      coords,
      dim,
    });
    if (!r.ok) throw new Error(r.message);
    const got = r.coords;
    if (pt.status === 'fail-known') {
      const d = deltas(pair.compare, got, pt.proj ?? [], refLatOf(pair, pt));
      expect(Math.max(d.horizontalM ?? 0, d.verticalM ?? 0)).toBeLessThan(0.001);
    } else {
      const d = deltas(pair.compare, got, pt.expected, refLatOf(pair, pt));
      expect({ ...d, ok: withinTolerance(d, pair.tol) }).toMatchObject({ ok: true });
    }
  });

  it('refuses anything with a grid or a datum shift', () => {
    const r = liteEngine.transform({
      pipeline:
        '+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +inv +proj=vgridshift +grids=x.tif +multiplier=1 +step +proj=unitconvert +xy_in=rad +xy_out=deg',
      coords: [0, 0, 0],
      dim: 3,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('lite-unsupported');
    expect(compileLite('not a pipeline')).toBeNull();
    expect(compileLite('+proj=pipeline +step +proj=helmert +x=1')).toBeNull();
  });
});

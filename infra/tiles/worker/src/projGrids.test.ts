/**
 * @jest-environment node
 */
import {
  GRID_CACHE,
  INDEX_CACHE,
  isProjGridPath,
  PROJ_GRID_UPLOAD_KEY,
  serveProjGrids,
  type GridBucket,
} from './projGrids';

function bucket(objects: Record<string, string>): GridBucket & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async get(key, options) {
      calls.push([key, options]);
      const v = objects[key];
      if (v === undefined) return null;
      const bytes = new TextEncoder().encode(v);
      const slice = options?.range
        ? bytes.slice(
            options.range.offset,
            options.range.length !== undefined
              ? options.range.offset + options.range.length
              : undefined,
          )
        : bytes;
      return { body: new Response(slice).body, size: bytes.length, httpEtag: '"e1"' };
    },
  };
}

const cors = { 'Access-Control-Allow-Origin': '*' };
const req = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://x${path}`, { headers });

describe('proj-grids routes', () => {
  it('recognises only the three shapes', () => {
    expect(isProjGridPath('/proj-grids/index.json')).toBe(true);
    expect(isProjGridPath('/proj-grids/ca-qc/manifest.json')).toBe(true);
    expect(isProjGridPath('/proj-grids/ca-qc/ca_nrc_CGG2013an83.tif')).toBe(true);
    expect(isProjGridPath('/proj-grids/ca-qc/../secret.tif')).toBe(false);
    expect(isProjGridPath('/proj-grids/CA/x.tif')).toBe(false);
    expect(isProjGridPath('/proj-grids/ca-qc/x.exe')).toBe(false);
  });

  it('serves the index and manifests as short-cached JSON', async () => {
    const b = bucket({ 'proj-grids/index.json': '{"packs":[]}' });
    const r = await serveProjGrids(
      b,
      req('/proj-grids/index.json'),
      '/proj-grids/index.json',
      cors,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe(INDEX_CACHE);
    expect(await r.text()).toBe('{"packs":[]}');
  });

  it('serves a grid, whole or by range', async () => {
    const b = bucket({ 'proj-grids/ca-qc/g.tif': '0123456789' });
    const whole = await serveProjGrids(
      b,
      req('/proj-grids/ca-qc/g.tif'),
      '/proj-grids/ca-qc/g.tif',
      cors,
    );
    expect(whole.headers.get('Cache-Control')).toBe(GRID_CACHE);
    expect(await whole.text()).toBe('0123456789');
    const part = await serveProjGrids(
      b,
      req('/proj-grids/ca-qc/g.tif', { Range: 'bytes=2-4' }),
      '/proj-grids/ca-qc/g.tif',
      cors,
    );
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 2-4/10');
    expect(await part.text()).toBe('234');
  });

  it('answers 404 for anything missing', async () => {
    const b = bucket({});
    expect(
      (
        await serveProjGrids(
          b,
          req('/proj-grids/x/manifest.json'),
          '/proj-grids/x/manifest.json',
          cors,
        )
      ).status,
    ).toBe(404);
    expect(
      (await serveProjGrids(b, req('/proj-grids/x/g.tif'), '/proj-grids/x/g.tif', cors)).status,
    ).toBe(404);
  });

  it('lets the NAS upload only proj-grids keys', () => {
    expect(PROJ_GRID_UPLOAD_KEY.test('proj-grids/index.json')).toBe(true);
    expect(PROJ_GRID_UPLOAD_KEY.test('proj-grids/us-tx/us_noaa_g2018u0.tif')).toBe(true);
    expect(PROJ_GRID_UPLOAD_KEY.test('proj-grids/us-tx/manifest.json')).toBe(true);
    expect(PROJ_GRID_UPLOAD_KEY.test('basemap.pmtiles')).toBe(false);
    expect(PROJ_GRID_UPLOAD_KEY.test('proj-grids/../basemap.pmtiles')).toBe(false);
  });
});

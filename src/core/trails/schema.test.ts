import { decodePolyline, encodePolyline } from './polyline';
import {
  activityFromOsm,
  networkLevelFromOsm,
  parseTrailDetail,
  parseTrailIndex,
  trailDisplayName,
  trailThumb,
} from './schema';
import { CAPS_LINE, rawDetail, rawIndex } from './__fixtures__/trails';

describe('polyline', () => {
  it('round-trips at both precisions', () => {
    const back5 = decodePolyline(encodePolyline(CAPS_LINE, 5), 5);
    back5.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(CAPS_LINE[i]![0], 5);
      expect(p[1]).toBeCloseTo(CAPS_LINE[i]![1], 5);
    });
    const back4 = decodePolyline(encodePolyline(CAPS_LINE, 4), 4);
    expect(back4[4]![0]).toBeCloseTo(-70.571, 4);
  });

  it("decodes Google's reference string", () => {
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  it('stops at damage instead of throwing', () => {
    expect(decodePolyline('_p~iF~ps|U_ulL')).toEqual([[-120.2, 38.5]]);
    expect(decodePolyline('\u0001\u0002')).toEqual([]);
    expect(decodePolyline('')).toEqual([]);
  });
});

describe('OSM tag mapping', () => {
  it('maps route values to activities', () => {
    expect(activityFromOsm('foot')).toBe('hiking');
    expect(activityFromOsm('mtb')).toBe('cycling');
    expect(activityFromOsm('ski')).toBe('skiing');
    expect(activityFromOsm('canoe')).toBe('paddling');
    expect(activityFromOsm('horse')).toBeNull();
    expect(activityFromOsm(3)).toBeNull();
  });

  it('maps networks to levels', () => {
    expect(networkLevelFromOsm('iwn')).toBe('i');
    expect(networkLevelFromOsm('ncn')).toBe('n');
    expect(networkLevelFromOsm('r')).toBe('r');
    expect(networkLevelFromOsm('lwn')).toBe('o');
    expect(networkLevelFromOsm(undefined)).toBe('o');
  });
});

describe('parseTrailIndex', () => {
  it('parses the compact rows', () => {
    const { value, warnings } = parseTrailIndex(rawIndex());
    expect(warnings).toEqual([]);
    expect(value?.detailsVersion).toBe('pilot1');
    expect(value?.countries.FR).toEqual({ name: 'France', continent: 'Europe' });
    const caps = value?.trails[0];
    expect(caps).toMatchObject({
      id: 'r8730405',
      name: 'Sentier des Caps de Charlevoix',
      activities: ['hiking'],
      network: 'o',
      lengthKm: 43.3,
      countries: ['CA'],
      region: 'Québec',
      stageCount: 4,
    });
    const tmb = value?.trails.find((t) => t.id === 'r9454');
    expect(tmb?.activities).toEqual(['hiking']); // 'foot' folded into hiking
    expect(value?.trails.find((t) => t.id === 'r416109')).toMatchObject({
      activities: ['cycling'],
      from: 'Québec',
      to: 'Montréal',
    });
  });

  it('drops bad rows and duplicates with warnings', () => {
    const raw = rawIndex();
    const trails = raw.trails as unknown[];
    trails.push({ id: 'r1', n: 'No bbox', a: ['hiking'], km: 50, c: [0, 0] });
    trails.push({ ...(trails[0] as object) });
    trails.push('junk');
    trails.push({ id: 'r2', n: 'Walk', a: ['horse'], km: 50, b: [0, 0, 1, 1], c: [0, 0] });
    const { value, warnings } = parseTrailIndex(raw);
    expect(value?.trails).toHaveLength(4);
    expect(warnings).toHaveLength(4);
  });

  it('refuses documents of another shape', () => {
    expect(parseTrailIndex(null).value).toBeNull();
    expect(parseTrailIndex({ schema: 2, trails: [] }).value).toBeNull();
    expect(parseTrailIndex({ schema: 1, trails: [], details: '../x' }).value).toBeNull();
  });

  it('clamps popularity and rejects out-of-range boxes', () => {
    const raw = rawIndex();
    const trails = raw.trails as Record<string, unknown>[];
    trails[0]!.p = 7;
    trails[1]!.b = [10, 0, 5, 1];
    const { value } = parseTrailIndex(raw);
    expect(value?.trails[0]?.popularity).toBe(1);
    expect(value?.trails.some((t) => t.id === 'r391736')).toBe(false);
  });
});

describe('trail helpers', () => {
  it('decodes thumbnails once', () => {
    const trail = parseTrailIndex(rawIndex()).value!.trails[0]!;
    const a = trailThumb(trail);
    expect(a[0]).toHaveLength(5);
    expect(trailThumb(trail)).toBe(a);
  });

  it('picks the name for the language', () => {
    const t = { name: 'Sentier', nameEn: 'Trail', nameFr: undefined };
    expect(trailDisplayName(t, 'en-CA')).toBe('Trail');
    expect(trailDisplayName(t, 'fr-CA')).toBe('Sentier');
    expect(trailDisplayName({ name: 'X', nameFr: 'Y' }, 'fr')).toBe('Y');
  });
});

describe('parseTrailDetail', () => {
  it('parses stages and derives the whole geometry from them', () => {
    const d = parseTrailDetail(rawDetail(true));
    expect(d?.stages).toHaveLength(4);
    expect(d?.stages[1]?.name).toBe('Étape 2');
    expect(d?.geometry).toHaveLength(4);
    expect(d?.names).toEqual({ en: 'Charlevoix Capes Trail' });
    expect(d?.operator).toBe('Sentier des Caps');
    expect(d?.roundtrip).toBe(false);
  });

  it('uses its own geometry without stages', () => {
    const d = parseTrailDetail(rawDetail(false));
    expect(d?.stages).toEqual([]);
    expect(d?.geometry[0]).toHaveLength(5);
  });

  it('skips empty stages, names the unnamed, and refuses a geometry-less trail', () => {
    const raw = rawDetail(true);
    const stages = raw.stages as Record<string, unknown>[];
    stages[0]!.geom = [];
    delete stages[1]!.name;
    delete stages[1]!.id;
    stages.push('junk' as unknown as Record<string, unknown>);
    const d = parseTrailDetail(raw);
    expect(d?.stages).toHaveLength(3);
    expect(d?.stages[0]?.name).toBe('Stage 2');
    expect(d?.stages[0]?.id).toBe('r8730405-2');
    expect(parseTrailDetail({ ...rawDetail(false), geom: [] })).toBeNull();
    expect(parseTrailDetail({ schema: 1, id: 'x' })).toBeNull();
    expect(parseTrailDetail('x')).toBeNull();
  });
});

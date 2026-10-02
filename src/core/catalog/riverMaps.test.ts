import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { classifyActivities } from './classify';
import {
  lastModifiedDate,
  parseRiverMapList,
  publishableRiverMaps,
  riverMapBbox,
  riverMapItem,
  riverMapSources,
  type RiverMapEntry,
} from './riverMaps';
import { parseCatalogManifest } from './schema';

const granted = {
  id: 'pub-a',
  name: 'Publisher A',
  licence: 'Written permission (2026-10-10)',
  attribution: 'Publisher A',
  homepage: 'https://example.org/',
  permission: { status: 'granted', evidence: 'Email from Publisher A, 2026-10-10: "Oui."' },
};

const pending = {
  id: 'pub-b',
  name: 'Publisher B',
  licence: 'All rights reserved',
  attribution: 'Publisher B',
  permission: { status: 'pending', evidence: 'Asked 2026-10-02 to link our fiches' },
};

const map = {
  slug: 'victoria',
  publisherId: 'pub-a',
  title: 'Rivière Victoria — parcours canotable',
  river: 'Rivière Victoria',
  url: 'https://example.org/victoria.pdf',
  format: 'geopdf',
  bbox: [-71.0447, 45.4759, -70.9221, 45.5621],
  bboxEvidence: 'union of the route sheets’ /GPTS',
  lang: 'fr',
};

const list = (maps: unknown[], publishers: unknown[] = [granted, pending]) =>
  parseRiverMapList({ publishers, maps });

describe('parseRiverMapList', () => {
  it('keeps well-formed publishers and maps', () => {
    const { list: parsed, warnings } = list([
      map,
      { ...map, slug: 'b', url: 'https://b.org/b.pdf', publisherId: 'pub-b' },
    ]);
    expect(warnings).toEqual([]);
    expect(parsed.publishers.map((p) => p.permission.status)).toEqual(['granted', 'pending']);
    expect(parsed.maps[0]).toEqual(map);
  });

  it('never throws on junk', () => {
    expect(parseRiverMapList(null).warnings).toEqual(['list is not an object']);
    expect(parseRiverMapList([]).list.maps).toEqual([]);
    expect(parseRiverMapList({ publishers: 'x', maps: 3 }).list).toEqual({
      publishers: [],
      maps: [],
    });
  });

  it.each([
    [{ ...granted, permission: undefined }],
    [{ ...granted, permission: { status: 'granted', evidence: ' ' } }],
    [{ ...granted, permission: { status: 'maybe', evidence: 'x' } }],
  ])('refuses a publisher without a recorded permission state, and then its maps (%#)', (pub) => {
    const { list: parsed, warnings } = list([map], [pub]);
    expect(parsed.publishers).toEqual([]);
    expect(parsed.maps).toEqual([]);
    expect(warnings).toEqual([
      'dropped publisher "pub-a": permission needs a status (granted|pending) and evidence',
      'dropped map "victoria": unknown publisher "pub-a"',
    ]);
  });

  it('drops malformed publishers', () => {
    const { warnings } = list(
      [],
      [7, { ...granted, id: 'Bad Id' }, { ...granted, licence: '' }, granted, granted],
    );
    expect(warnings).toEqual([
      'dropped publisher is not an object',
      'dropped publisher with an unusable id "Bad Id"',
      'dropped publisher "pub-a": name, licence and attribution are required',
      'dropped duplicate publisher "pub-a"',
    ]);
  });

  it('omits a non-https homepage rather than dropping the publisher', () => {
    const { list: parsed } = list([], [{ ...granted, homepage: 'http://example.org/' }]);
    expect(parsed.publishers[0]).not.toHaveProperty('homepage');
  });

  const bboxWarning =
    'dropped map "victoria": bbox must be [w, s, e, n] inside Québec, at most 3° across';
  it.each([
    [{ ...map, slug: 'Nope!' }, 'dropped map with an unusable slug "Nope!"'],
    [{ ...map, title: '' }, 'dropped map "victoria": title and river are required'],
    [
      { ...map, url: 'http://example.org/x.pdf' },
      'dropped map "victoria": missing or non-https url',
    ],
    [{ ...map, format: 'tiff' }, 'dropped map "victoria": format must be "pdf" or "geopdf"'],
    [{ ...map, bbox: [-71, 45, -70] }, bboxWarning],
    [{ ...map, bbox: [-71, 45, -70, 'x'] }, bboxWarning],
    [{ ...map, bbox: [-70, 45, -71, 46] }, bboxWarning],
    // Lat/lon swapped — a classic transcription error lands outside Québec.
    [{ ...map, bbox: [45.47, -71.04, 45.56, -70.92] }, bboxWarning],
    // A regional locator inset, not a route.
    [{ ...map, bbox: [-72, 45.2, -68.8, 46.8] }, bboxWarning],
    [{ ...map, bboxEvidence: '' }, 'dropped map "victoria": bboxEvidence is required'],
    ['nope', 'dropped map is not an object'],
  ])('drops a bad map row (%#)', (row, warning) => {
    const { list: parsed, warnings } = list([row]);
    expect(parsed.maps).toEqual([]);
    expect(warnings).toEqual([warning]);
  });

  it('drops duplicate slugs and duplicate urls', () => {
    const { list: parsed, warnings } = list([map, map, { ...map, slug: 'other' }]);
    expect(parsed.maps).toHaveLength(1);
    expect(warnings).toEqual([
      'dropped duplicate map "victoria"',
      'dropped map "other": its url is already listed',
    ]);
  });

  it('ignores an unknown lang and keeps an edition', () => {
    const { list: parsed } = list([{ ...map, lang: 'de', edition: '2021' }]);
    expect(parsed.maps[0]).not.toHaveProperty('lang');
    expect(parsed.maps[0]?.edition).toBe('2021');
  });
});

describe('riverMapBbox', () => {
  it('accepts a route extent inside Québec', () => {
    expect(riverMapBbox([-71.3115, 46.6379, -71.2029, 46.7127])).toEqual([
      -71.3115, 46.6379, -71.2029, 46.7127,
    ]);
  });

  it('rejects anything else', () => {
    expect(riverMapBbox(null)).toBeNull();
    expect(riverMapBbox([-71, 46, -71, 47])).toBeNull();
    expect(riverMapBbox([-90, 46, -89, 47])).toBeNull();
    expect(riverMapBbox([-71, 46, -67, 47])).toBeNull();
    expect(riverMapBbox([-71, 46, -70, Infinity])).toBeNull();
  });
});

describe('publishableRiverMaps', () => {
  it('emits only maps whose publisher granted permission', () => {
    const { list: parsed } = list([
      map,
      { ...map, slug: 'b', url: 'https://b.org/b.pdf', publisherId: 'pub-b' },
    ]);
    const { maps, pending: waiting } = publishableRiverMaps(parsed);
    expect(maps.map((m) => m.slug)).toEqual(['victoria']);
    expect(waiting).toBe(1);
  });

  it('emits nothing while every publisher is pending', () => {
    const { list: parsed } = list([{ ...map, publisherId: 'pub-b' }]);
    expect(publishableRiverMaps(parsed)).toEqual({ maps: [], pending: 1 });
  });
});

describe('riverMapItem', () => {
  const entry = list([map]).list.maps[0] as RiverMapEntry;

  it('builds a paddling river row the app parser accepts', () => {
    const item = riverMapItem(entry, { sizeBytes: 3576227, updatedAt: '2021-07-07' });
    expect(item).toEqual({
      id: 'qcriv-victoria',
      sourceId: 'pub-a',
      title: 'Rivière Victoria — parcours canotable',
      category: 'river',
      kind: 'trail',
      activities: ['paddling'],
      region: 'CA-QC',
      format: 'geopdf',
      packaging: 'none',
      url: 'https://example.org/victoria.pdf',
      bbox: [-71.0447, 45.4759, -70.9221, 45.5621],
      sizeBytes: 3576227,
      updatedAt: '2021-07-07',
      lang: 'fr',
    });
    const parsed = list([map]).list;
    const { manifest, warnings } = parseCatalogManifest({
      schemaVersion: 1,
      sources: riverMapSources(parsed),
      items: [item],
    });
    expect(warnings).toEqual([]);
    expect(manifest?.items).toEqual([item]);
  });

  it('agrees with the classifier: the river category is paddling evidence', () => {
    const item = riverMapItem(entry);
    expect(
      classifyActivities({
        kind: item.kind ?? 'trail',
        category: item.category,
        title: item.title,
      }),
    ).toContain('paddling');
  });

  it('falls back to the printed edition when the HEAD has no date', () => {
    expect(riverMapItem({ ...entry, edition: '2020' }).updatedAt).toBe('2020');
    expect(riverMapItem(entry)).not.toHaveProperty('updatedAt');
    expect(riverMapItem(entry)).not.toHaveProperty('sizeBytes');
  });

  it('omits lang when the entry has none', () => {
    const { lang: _lang, ...noLang } = entry;
    expect(riverMapItem(noLang)).not.toHaveProperty('lang');
  });
});

describe('riverMapSources', () => {
  it('strips the permission record and can be limited to some publishers', () => {
    const parsed = list([]).list;
    expect(riverMapSources(parsed, new Set(['pub-a']))).toEqual([
      {
        id: 'pub-a',
        name: 'Publisher A',
        licence: 'Written permission (2026-10-10)',
        attribution: 'Publisher A',
        homepage: 'https://example.org/',
      },
    ]);
    expect(riverMapSources(parsed).map((s) => s.id)).toEqual(['pub-a', 'pub-b']);
  });
});

describe('lastModifiedDate', () => {
  it('turns an HTTP date into an ISO date', () => {
    expect(lastModifiedDate('Wed, 07 Jul 2021 03:00:46 GMT')).toBe('2021-07-07');
  });

  it('is undefined when absent or garbage', () => {
    expect(lastModifiedDate(null)).toBeUndefined();
    expect(lastModifiedDate(undefined)).toBeUndefined();
    expect(lastModifiedDate('not a date')).toBeUndefined();
  });
});

describe('the checked-in curated list', () => {
  const raw: unknown = JSON.parse(
    readFileSync(join(__dirname, '../../../scripts/catalog/sources/quebec-rivers.json'), 'utf8'),
  );
  const { list: curated, warnings } = parseRiverMapList(raw);

  it('validates without dropping a row', () => {
    expect(warnings).toEqual([]);
    expect(curated.publishers.length).toBeGreaterThan(0);
    expect(curated.maps.length).toBeGreaterThan(0);
  });

  it('publishes a map only for a publisher recorded as granted', () => {
    const grantedIds = new Set(
      curated.publishers.filter((p) => p.permission.status === 'granted').map((p) => p.id),
    );
    const { maps, pending: waiting } = publishableRiverMaps(curated);
    expect(maps.every((m) => grantedIds.has(m.publisherId))).toBe(true);
    expect(maps.length + waiting).toBe(curated.maps.length);
  });
});

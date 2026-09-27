import {
  catalogItemCountry,
  catalogRowMeta,
  catalogSourceCaption,
  formatDistanceAway,
  nearbySections,
  sortCatalogItemsCanadianFirst,
} from './nearbySections';
import type { CatalogCategory, CatalogItem } from './schema';

function sheet(
  id: string,
  sourceId: string,
  lat: number,
  lon: number,
  extra: Partial<CatalogItem> = {},
): CatalogItem {
  return {
    id,
    sourceId,
    title: id,
    category: 'topo' as CatalogCategory,
    bbox: [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05],
    format: 'geopdf',
    packaging: 'none',
    url: `https://example.test/${id}.pdf`,
    ...extra,
  };
}

const QUEBEC_CITY = { latitude: 46.8139, longitude: -71.2082 };

describe('catalogItemCountry', () => {
  it('reads the ISO region first', () => {
    expect(catalogItemCountry({ sourceId: 'x', region: 'CA-QC' })).toBe('CA');
    expect(catalogItemCountry({ sourceId: 'x', region: 'US-ME' })).toBe('US');
    expect(catalogItemCountry({ sourceId: 'nrcan-cantopo', region: 'AU' })).toBe('other');
    expect(catalogItemCountry({ sourceId: 'x', region: 'us' })).toBe('US');
  });

  it('falls back to the source for region-less items (CanTopo carries none)', () => {
    expect(catalogItemCountry({ sourceId: 'nrcan-cantopo' })).toBe('CA');
    expect(catalogItemCountry({ sourceId: 'usgs-ustopo' })).toBe('US');
    expect(catalogItemCountry({ sourceId: 'noaa-bookletchart' })).toBe('US');
    expect(catalogItemCountry({ sourceId: 'ga-austopo' })).toBe('other');
    expect(catalogItemCountry({ sourceId: 'inukshuk-fixtures' })).toBe('other');
  });
});

describe('nearbySections', () => {
  it('is empty without a known position', () => {
    expect(nearbySections([sheet('a', 'nrcan-cantopo', 46.8, -71.2)], null)).toEqual([]);
  });

  it('puts Canadian sheets first from Québec City even when Maine quads are nearer (the bug)', () => {
    // Real geography: CanTopo skips NTS 021L, so the nearest sheet is in New
    // Brunswick (~318 km) while Maine's US Topo quads start near 100 km.
    const maine1 = sheet('usgs-burntland', 'usgs-ustopo', 45.85, -70.3, { region: 'US-ME' });
    const maine2 = sheet('usgs-hardwood', 'usgs-ustopo', 45.8, -70.4, { region: 'US-ME' });
    const nb = sheet('cantopo-021g14', 'nrcan-cantopo', 45.9, -67.4);
    const lsj = sheet('cantopo-032a01', 'nrcan-cantopo', 48.1, -72.2);

    const sections = nearbySections([maine1, nb, maine2, lsj], QUEBEC_CITY);

    expect(sections.map((s) => s.country)).toEqual(['CA', 'US']);
    expect(sections[0]?.title).toBe('Near you · Canadian sources first');
    expect(sections[1]?.title).toBe('Nearest USGS quads · across the border');
    // Each group nearest-first.
    expect(sections[0]?.entries.map((e) => e.item.id)).toEqual([
      'cantopo-032a01',
      'cantopo-021g14',
    ]);
    expect(sections[1]?.entries.map((e) => e.item.id)).toEqual(['usgs-burntland', 'usgs-hardwood']);
    // …and the US group really is nearer, which is why ranking alone failed.
    expect(sections[1]!.entries[0]!.distanceMeters).toBeLessThan(
      sections[0]!.entries[1]!.distanceMeters,
    );
  });

  it('names a mixed US group generically (a NOAA chart is not a USGS quad)', () => {
    const sections = nearbySections(
      [
        sheet('cantopo-a', 'nrcan-cantopo', 46.9, -71.2),
        sheet('chart', 'noaa-bookletchart', 46.8, -71.3, { category: 'nautical' }),
      ],
      QUEBEC_CITY,
    );
    expect(sections[1]?.title).toBe('Nearest US maps · across the border');
  });

  it('titles the first group "Near you" when there is nothing Canadian around', () => {
    const sections = nearbySections(
      [
        sheet('usgs-a', 'usgs-ustopo', 44.0, -110.0),
        sheet('au', 'ga-austopo', -35.3, 149.1, { region: 'AU' }),
      ],
      { latitude: 44.0, longitude: -110.1 },
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ country: 'US', title: 'Near you' });
  });

  it('keeps other countries last, as "Also nearby" after a titled group', () => {
    const sections = nearbySections(
      [
        sheet('fixture', 'inukshuk-fixtures', 46.82, -71.2),
        sheet('cantopo-a', 'nrcan-cantopo', 46.9, -71.2),
      ],
      QUEBEC_CITY,
    );
    expect(sections.map((s) => [s.country, s.title])).toEqual([
      ['CA', 'Near you · Canadian sources first'],
      ['other', 'Also nearby'],
    ]);
  });

  it('caps each group and drops groups beyond the radius', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      sheet(`cantopo-${i}`, 'nrcan-cantopo', 46.8 + i * 0.05, -71.2),
    );
    const far = sheet('usgs-far', 'usgs-ustopo', 30, -90);
    const sections = nearbySections([...many, far], QUEBEC_CITY, { limits: { CA: 3 } });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.entries).toHaveLength(3);
  });

  it('honours an explicit radius', () => {
    const sections = nearbySections(
      [sheet('cantopo-a', 'nrcan-cantopo', 47.5, -71.2)],
      QUEBEC_CITY,
      { radiusMeters: 10_000 },
    );
    expect(sections).toEqual([]);
  });
});

describe('formatDistanceAway', () => {
  it('rounds to whole kilometres', () => {
    expect(formatDistanceAway(12_345, 'metric')).toBe('12 km away');
    expect(formatDistanceAway(106_499, 'metric')).toBe('106 km away');
    expect(formatDistanceAway(1_500, 'metric')).toBe('2 km away');
  });

  it('never says "0 km"', () => {
    expect(formatDistanceAway(0, 'metric')).toBe('< 1 km away');
    expect(formatDistanceAway(499, 'metric')).toBe('< 1 km away');
    expect(formatDistanceAway(Number.NaN, 'metric')).toBe('< 1 km away');
  });

  it('groups thousands and supports miles', () => {
    expect(formatDistanceAway(1_250_400, 'metric')).toBe('1,250 km away');
    expect(formatDistanceAway(16_093.44, 'imperial')).toBe('10 mi away');
    expect(formatDistanceAway(500, 'imperial')).toBe('< 1 mi away');
  });
});

describe('catalogRowMeta', () => {
  it('joins size and distance', () => {
    expect(catalogRowMeta(31 * 1024 * 1024, 12_000, 'metric')).toBe('31 MB · 12 km away');
  });

  it('shows whichever half is known', () => {
    expect(catalogRowMeta(undefined, 12_000, 'metric')).toBe('12 km away');
    expect(catalogRowMeta(22 * 1024 * 1024, null, 'metric')).toBe('22 MB');
    expect(catalogRowMeta(undefined, undefined, 'metric')).toBe('');
  });
});

describe('catalogSourceCaption', () => {
  it('adds the named region', () => {
    expect(catalogSourceCaption('USGS US Topo', 'US-ME')).toBe('USGS US Topo · Maine');
    expect(catalogSourceCaption('NRCan CanTopo', 'ca-qc')).toBe('NRCan CanTopo · Québec');
  });

  it('leaves out what it cannot name', () => {
    expect(catalogSourceCaption('NRCan CanTopo', undefined)).toBe('NRCan CanTopo');
    expect(catalogSourceCaption('GA', 'AU')).toBe('GA');
    expect(catalogSourceCaption(undefined, 'US-ME')).toBe('Maine');
    expect(catalogSourceCaption(undefined, undefined)).toBe('');
  });
});

describe('sortCatalogItemsCanadianFirst', () => {
  const maine = sheet('usgs-me', 'usgs-ustopo', 45.85, -70.3, { title: 'A Maine quad' });
  const nb = sheet('cantopo-nb', 'nrcan-cantopo', 45.9, -67.4, { title: 'B New Brunswick' });
  const near = sheet('cantopo-near', 'nrcan-cantopo', 47.0, -71.2, { title: 'C Near' });
  const au = sheet('au', 'ga-austopo', 46.81, -71.2, { region: 'AU', title: 'D fixture' });

  it('groups Canada, then the US, then the rest, nearest-first within each', () => {
    expect(
      sortCatalogItemsCanadianFirst([maine, au, nb, near], QUEBEC_CITY).map((i) => i.id),
    ).toEqual(['cantopo-near', 'cantopo-nb', 'usgs-me', 'au']);
  });

  it('stays alphabetical and ungrouped without a position', () => {
    expect(sortCatalogItemsCanadianFirst([near, au, nb, maine], null).map((i) => i.id)).toEqual([
      'usgs-me',
      'cantopo-nb',
      'cantopo-near',
      'au',
    ]);
  });
});

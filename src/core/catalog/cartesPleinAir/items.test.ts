import { parseCatalogShard } from '../schema';
import { assetVersion, cpaItem, cpaItemId, CPA_SOURCE, CPA_SOURCE_ID } from './items';
import type { CpaMap } from './listing';

const MAP: CpaMap = {
  id: '41AD13F6-5F4E-471B-9C7B-A8B36224BD95',
  slug: 'aigle-desert-auteur-2022',
  title: 'Aigle-Désert',
  author: 'Auteur Exemple',
  year: 2022,
  sections: [],
  rivers: [],
  regions: ['qc:07'],
};

const ASSET = {
  url: 'https://assets.cartespleinair.org/maps/aigle-desert-auteur-2022-e06f583d13bd.pdf',
  version: 'd0357cf364417ee3ad0fd108d4828eac',
  sizeBytes: 2156252,
  updatedAt: '2026-05-25',
};

describe('cpaItem', () => {
  it('links the publisher’s file, credits the author, and lists a plain PDF', () => {
    const item = cpaItem(MAP, ASSET, {
      bbox: [-76.3, 46.3, -75.9, 46.7],
      precision: 'river',
      evidence: 'x',
    });
    expect(item).toEqual({
      id: 'cpa-41ad13f6-5f4e-471b-9c7b-a8b36224bd95',
      sourceId: 'cartes-plein-air',
      title: 'Aigle-Désert',
      category: 'river',
      kind: 'trail',
      activities: ['paddling'],
      format: 'pdf',
      packaging: 'none',
      url: ASSET.url,
      pageUrl: 'https://cartespleinair.org/cartes/aigle-desert-auteur-2022',
      author: 'Auteur Exemple',
      year: 2022,
      version: 'd0357cf364417ee3ad0fd108d4828eac',
      region: 'CA-QC',
      bbox: [-76.3, 46.3, -75.9, 46.7],
      bboxPrecision: 'river',
      sizeBytes: 2156252,
      updatedAt: '2026-05-25',
    });
    // The app's own parser keeps every field.
    const parsed = parseCatalogShard([item], new Set([CPA_SOURCE_ID]));
    expect(parsed.warnings).toEqual([]);
    expect(parsed.items[0]).toEqual(item);
  });

  it('leaves out what it does not know', () => {
    const { year: _year, ...noYear } = MAP;
    const item = cpaItem({ ...noYear, regions: [] }, { url: ASSET.url, version: 'v' }, null);
    expect(item).not.toHaveProperty('bbox');
    expect(item).not.toHaveProperty('year');
    expect(item).not.toHaveProperty('region');
    expect(item).not.toHaveProperty('sizeBytes');
  });

  it('declares a source that says the maps are free there, never naming an author', () => {
    expect(CPA_SOURCE.freeAt).toBe('cartespleinair.org');
    expect(CPA_SOURCE.attribution).not.toMatch(/Leduc|Dionne/);
    expect(cpaItemId('ABC')).toBe('cpa-abc');
  });
});

describe('assetVersion', () => {
  it('prefers the ETag, then the content hash in the name, then the URL', () => {
    expect(assetVersion(ASSET.url, '"d0357cf3"')).toBe('d0357cf3');
    expect(assetVersion(ASSET.url, 'W/"abc"')).toBe('abc');
    expect(assetVersion(ASSET.url, null)).toBe('e06f583d13bd');
    expect(assetVersion(ASSET.url, '  ')).toBe('e06f583d13bd');
    expect(assetVersion('https://x.org/a.pdf', undefined)).toBe('https://x.org/a.pdf');
  });
});

import type { MapDocument } from '@core/models';

import { provenanceBackfill } from './provenance';
import type { CatalogItem, CatalogSource } from './schema';

const cpa: CatalogSource = {
  id: 'cartes-plein-air',
  name: 'Cartes Plein-air',
  licence: '© each map’s author',
  attribution: 'cartespleinair.org',
  freeAt: 'cartespleinair.org',
};
const nrcan: CatalogSource = { id: 'nrcan', name: 'NRCan', licence: 'OGL', attribution: 'NRCan' };

const item = (overrides: Partial<CatalogItem> = {}): CatalogItem => ({
  id: 'cpa-1',
  sourceId: 'cartes-plein-air',
  title: 'Aigle-Désert',
  category: 'river',
  format: 'pdf',
  packaging: 'none',
  url: 'https://assets.cartespleinair.org/maps/a.pdf',
  pageUrl: 'https://cartespleinair.org/cartes/a',
  author: 'Charles Leduc',
  year: 2023,
  version: 'v2',
  updatedAt: '2026-05-25',
  ...overrides,
});

/** A CPA map as 2.5.1 rewrites it: the 2.5.2 fields gone, the older ones kept. */
const rolledBack = (overrides: Partial<MapDocument> = {}): MapDocument => ({
  id: 'm1',
  name: 'Aigle-Désert',
  fileUri: 'file://maps/m1.pdf',
  importedAt: 1,
  pageCount: 1,
  georeferences: [],
  activePages: [],
  sourceItemId: 'cpa-1',
  sourceUpdatedAt: '2026-05-25',
  ...overrides,
});

describe('provenanceBackfill (2.5.2 review: a rollback to 2.5.1 strips the credits)', () => {
  it('puts back the credit, the free-at host, the page and the version of the same revision', () => {
    expect(provenanceBackfill([rolledBack()], [item()], [cpa, nrcan])).toEqual([
      {
        id: 'm1',
        patch: {
          sourceCredit: 'Charles Leduc · 2023',
          sourceFreeAt: 'cartespleinair.org',
          sourcePageUrl: 'https://cartespleinair.org/cartes/a',
          sourceVersion: 'v2',
        },
      },
    ]);
  });

  it('never fills the version from a newer revision (the Update stays due)', () => {
    const newer = item({ updatedAt: '2026-09-01', version: 'v3' });
    const [p] = provenanceBackfill([rolledBack()], [newer], [cpa]);
    expect(p?.patch.sourceVersion).toBeUndefined();
    expect(p?.patch.sourceCredit).toBe('Charles Leduc · 2023');
  });

  it('never overwrites what is there, and skips maps that lack nothing', () => {
    const whole = rolledBack({
      sourceCredit: 'Someone · 2020',
      sourceFreeAt: 'x.org',
      sourcePageUrl: 'https://x.org/a',
      sourceVersion: 'v1',
    });
    expect(provenanceBackfill([whole], [item()], [cpa])).toEqual([]);
    const partial = rolledBack({ sourceCredit: 'Someone · 2020' });
    expect(provenanceBackfill([partial], [item()], [cpa])[0]?.patch.sourceCredit).toBeUndefined();
  });

  it('nothing for local maps, unloaded items, or a source without such terms', () => {
    const local = rolledBack({ sourceItemId: undefined });
    expect(provenanceBackfill([local], [item()], [cpa])).toEqual([]);
    expect(provenanceBackfill([rolledBack()], [item({ id: 'other' })], [cpa])).toEqual([]);
    expect(provenanceBackfill([rolledBack()], [], [cpa])).toEqual([]);
    const plain = item({ sourceId: 'nrcan', author: undefined, pageUrl: undefined });
    expect(provenanceBackfill([rolledBack()], [plain], [cpa, nrcan])).toEqual([
      { id: 'm1', patch: { sourceVersion: 'v2' } },
    ]);
  });
});

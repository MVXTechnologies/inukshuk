import type { MapDocument } from '@core/models';
import { findInstalledMap, installStatusFor } from './installStatus';
import type { CatalogItem } from './schema';

const item = (overrides: Partial<CatalogItem> = {}): CatalogItem => ({
  id: 'cantopo-021l14',
  sourceId: 'nrcan-cantopo',
  title: 'CanTopo 021L14',
  category: 'topo',
  format: 'geopdf',
  packaging: 'zip',
  url: 'https://example.com/x.zip',
  updatedAt: '2020-01-01',
  ...overrides,
});

const doc = (overrides: Partial<MapDocument> = {}): MapDocument => ({
  id: 'abc123',
  name: 'CanTopo 021L14',
  fileUri: 'file://maps/abc123.pdf',
  importedAt: 1,
  pageCount: 1,
  georeferences: [],
  activePages: [],
  sourceItemId: 'cantopo-021l14',
  sourceUpdatedAt: '2020-01-01',
  ...overrides,
});

describe('findInstalledMap', () => {
  it('finds the map by sourceItemId, not by name', () => {
    const renamed = doc({ name: 'My favourite sheet' });
    expect(findInstalledMap([renamed], 'cantopo-021l14')).toBe(renamed);
    expect(findInstalledMap([renamed], 'cantopo-021l15')).toBeUndefined();
  });

  it('ignores locally imported maps (no sourceItemId)', () => {
    const local = doc();
    delete local.sourceItemId;
    expect(findInstalledMap([local], 'cantopo-021l14')).toBeUndefined();
  });
});

describe('installStatusFor', () => {
  it('is not-installed when no library map came from the item', () => {
    expect(installStatusFor(item(), [])).toBe('not-installed');
    expect(installStatusFor(item(), [doc({ sourceItemId: 'other' })])).toBe('not-installed');
  });

  it('is installed when revisions match', () => {
    expect(installStatusFor(item(), [doc()])).toBe('installed');
  });

  it('is update-available only when the manifest revision is strictly newer', () => {
    expect(installStatusFor(item({ updatedAt: '2021-05-05' }), [doc()])).toBe('update-available');
    expect(installStatusFor(item({ updatedAt: '2019-01-01' }), [doc()])).toBe('installed');
  });

  it('never nags when either side lacks a parseable revision date', () => {
    expect(installStatusFor(item({ updatedAt: undefined }), [doc()])).toBe('installed');
    expect(installStatusFor(item(), [doc({ sourceUpdatedAt: undefined })])).toBe('installed');
    expect(installStatusFor(item({ updatedAt: 'sometime soon' }), [doc()])).toBe('installed');
    expect(installStatusFor(item(), [doc({ sourceUpdatedAt: 'junk' })])).toBe('installed');
  });
});

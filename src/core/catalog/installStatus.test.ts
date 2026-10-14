import type { MapDocument } from '@core/models';
import {
  findInstalledMap,
  indexInstallStatus,
  installStatusFor,
  mapsWithNewerVersion,
  NEWER_VERSION_NOTICE,
} from './installStatus';
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

describe('installStatusFor — file versions (#680)', () => {
  it('a different publisher file version is an update, whatever the dates say', () => {
    expect(
      installStatusFor(item({ version: 'v2', updatedAt: '2019-01-01' }), [
        doc({ sourceVersion: 'v1' }),
      ]),
    ).toBe('update-available');
    expect(
      installStatusFor(item({ version: 'v1', updatedAt: '2030-01-01' }), [
        doc({ sourceVersion: 'v1' }),
      ]),
    ).toBe('installed');
  });

  it('falls back to the dates when either side has no version', () => {
    expect(installStatusFor(item({ version: 'v2', updatedAt: '2021-01-01' }), [doc()])).toBe(
      'update-available',
    );
    expect(installStatusFor(item(), [doc({ sourceVersion: 'v1' })])).toBe('installed');
  });

  it('lists the Library maps with a newer file among the loaded items', () => {
    const maps = [
      doc({ id: 'old', sourceVersion: 'v1' }),
      doc({ id: 'local', sourceItemId: undefined }),
      doc({ id: 'gone', sourceItemId: 'not-loaded' }),
    ];
    expect([...mapsWithNewerVersion(maps, [item({ version: 'v2' })])]).toEqual(['old']);
    expect(mapsWithNewerVersion(maps, []).size).toBe(0);
    expect(NEWER_VERSION_NOTICE).toBe('A newer version is available');
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

describe('indexInstallStatus', () => {
  it('agrees with installStatusFor for every item', () => {
    const items = [
      item(),
      item({ id: 'cantopo-021l15', updatedAt: '2021-05-05' }),
      item({ id: 'cantopo-021l16' }),
    ];
    const maps = [doc(), doc({ id: 'def456', sourceItemId: 'cantopo-021l15' })];
    const index = indexInstallStatus(items, maps);
    for (const it of items) {
      expect(index.get(it.id)).toBe(installStatusFor(it, maps));
    }
    expect([...index.values()]).toEqual(['installed', 'update-available', 'not-installed']);
  });

  it('keeps the FIRST duplicate, exactly like findInstalledMap', () => {
    // Two Library maps for one catalog item — a repeat download, or an Update
    // that added rather than replaced. Their revisions disagree, so last-wins
    // would report 'installed' here and flip the row on Library order alone.
    const first = doc({ id: 'first', sourceUpdatedAt: '2020-01-01' });
    const second = doc({ id: 'second', sourceUpdatedAt: '2021-05-05' });
    const it = item({ updatedAt: '2021-05-05' });

    expect(indexInstallStatus([it], [first, second]).get(it.id)).toBe(
      installStatusFor(it, [first, second]),
    );
    expect(indexInstallStatus([it], [first, second]).get(it.id)).toBe('update-available');
    // ...and the mirrored order still agrees with the find-based answer.
    expect(indexInstallStatus([it], [second, first]).get(it.id)).toBe(
      installStatusFor(it, [second, first]),
    );
  });

  it('ignores locally imported maps (no sourceItemId)', () => {
    const local = doc();
    delete local.sourceItemId;
    expect(indexInstallStatus([item()], [local]).get('cantopo-021l14')).toBe('not-installed');
  });
});

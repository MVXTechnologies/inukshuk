import type { CatalogItem } from '../schema';
import { diffCatalogItems, diffIsEmpty, diffSummaryMarkdown, massRemovalGuard } from './diff';

function item(id: string, extra: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id,
    sourceId: 'cartes-plein-air',
    title: `Rivière ${id}`,
    category: 'river',
    format: 'pdf',
    packaging: 'none',
    url: `https://assets.cartespleinair.org/maps/${id}-aaa.pdf`,
    pageUrl: `https://cartespleinair.org/cartes/${id}`,
    author: 'Auteur',
    year: 2020,
    version: 'v1',
    ...extra,
  };
}

describe('diffCatalogItems', () => {
  const before = [item('a'), item('b'), item('c'), item('d')];
  const after = [
    item('a'),
    item('b', { version: 'v2', url: 'https://assets.cartespleinair.org/maps/b-bbb.pdf' }),
    item('d', { author: 'Autre', bbox: [-71, 46, -70, 47], bboxPrecision: 'river' }),
    item('e', { year: undefined }),
  ];
  const diff = diffCatalogItems(before, after);

  it('finds added, withdrawn, republished and changed maps', () => {
    expect(diff.added.map((i) => i.id)).toEqual(['e']);
    expect(diff.removed.map((i) => i.id)).toEqual(['c']);
    expect(diff.republished.map((c) => [c.after.id, c.fields])).toEqual([
      ['b', ['version', 'url']],
    ]);
    expect(diff.changed.map((c) => [c.after.id, c.fields])).toEqual([
      ['d', ['author', 'bbox', 'bboxPrecision']],
    ]);
    expect(diff.unchanged).toBe(1);
    expect(diffIsEmpty(diff)).toBe(false);
    expect(diffIsEmpty(diffCatalogItems(before, before))).toBe(true);
  });

  it('summarises for the pull request, with credit and page link', () => {
    const md = diffSummaryMarkdown(diff, after.length);
    expect(md).toContain(
      '**4 maps** · 1 added · 1 withdrawn · 1 republished · 1 details changed · 1 unchanged',
    );
    expect(md).toContain('### Added\n\n- Rivière e (Auteur) — https://cartespleinair.org/cartes/e');
    expect(md).toContain('### Withdrawn\n\n- Rivière c (Auteur, 2020)');
    expect(md).toContain('### Republished (new file)\n\n- Rivière b (Auteur, 2020)');
    expect(md).toContain('· author, bbox, bboxPrecision');
    expect(diffSummaryMarkdown(diffCatalogItems([], []), 0)).not.toContain('###');
    const noPage = diffCatalogItems(
      [],
      [item('z', { pageUrl: undefined, author: undefined, year: undefined })],
    );
    expect(diffSummaryMarkdown(noPage, 1)).toMatch(/^\*\*1 map\*\* ·[^]*\n- Rivière z$/);
  });
});

describe('massRemovalGuard', () => {
  it('refuses an empty crawl or a mass withdrawal, allows normal churn', () => {
    expect(massRemovalGuard(368, 0, 368)).toBe('the crawl found no maps at all');
    expect(massRemovalGuard(368, 200, 168)).toBe(
      'the crawl would withdraw 168 of 368 maps (46 %, limit 20 %)',
    );
    expect(massRemovalGuard(368, 360, 10)).toBeNull();
    expect(massRemovalGuard(0, 368, 0)).toBeNull();
  });
});

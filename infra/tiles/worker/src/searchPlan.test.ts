/**
 * @jest-environment node
 */
import { MAX_UPSTREAM_CALLS, planSearch, queryShape, tagsFor } from './searchPlan';

describe('queryShape', () => {
  it.each([
    ['katahdin', 'katahdin', 'katahdin', null],
    ['katahdin mount', 'mount katahdin', 'katahdin', 'peak'],
    ['Katahdin Mt', 'Mt Katahdin', 'Katahdin', 'peak'],
    ['mont st anne', 'mont st anne', 'st anne', 'peak'],
    ['Mont-Sainte-Anne', 'Mont-Sainte-Anne', 'Sainte Anne', 'peak'],
    ['pic du Midi', 'pic du Midi', 'du Midi', 'peak'],
    ['Saint-Jean lac', 'lac Saint Jean', 'Saint Jean', 'water'],
    ['lac saint-jean', 'lac saint-jean', 'saint jean', 'water'],
    ['Étang Bleu', 'Étang Bleu', 'Bleu', 'water'],
    ['Katahdin Lake', 'Lake Katahdin', 'Katahdin', 'water'],
    ['mount', 'mount', '', 'peak'],
  ])('%s → "%s" / "%s" (%s)', (q, canonical, core, hint) => {
    expect(queryShape(q)).toMatchObject({ canonical, core, hint });
  });
});

describe('planSearch', () => {
  it('without a generic word: as typed, "mount …" among summits, and the word alone', () => {
    expect(planSearch('katahdin', 'en', 'fr')).toEqual([
      { role: 'general', text: 'katahdin', lang: 'en', tags: 'general' },
      { role: 'expanded', text: 'mount katahdin', lang: 'en', tags: 'peak' },
      { role: 'core', text: 'katahdin', lang: 'fr', tags: 'outdoor' },
    ]);
    // French devices expand with "mont".
    expect(planSearch('katahdin', 'fr', null)[1]).toMatchObject({ text: 'mont katahdin' });
    // No second language: the core query stays in the first.
    expect(planSearch('katahdin', 'fr', null)[2]).toMatchObject({ lang: 'fr' });
  });

  it('with a generic word: with it (in front), restricted by its kind, and without it', () => {
    expect(planSearch('katahdin mount', 'en', 'fr').map((p) => [p.text, p.tags])).toEqual([
      ['mount katahdin', 'general'],
      ['mount katahdin', 'peak'],
      ['katahdin', 'outdoor'],
    ]);
    expect(planSearch('lac saint-jean', 'fr', 'en').map((p) => [p.text, p.tags])).toEqual([
      ['lac saint-jean', 'general'],
      ['lac saint-jean', 'water'],
      ['saint jean', 'outdoor'],
    ]);
  });

  it('a lone generic word, or variants off: the query and its second language only', () => {
    expect(planSearch('lake', 'en', 'fr')).toEqual([
      { role: 'general', text: 'lake', lang: 'en', tags: 'general' },
      { role: 'core', text: 'lake', lang: 'fr', tags: 'general' },
    ]);
    expect(planSearch('katahdin', 'en', null, false)).toHaveLength(1);
  });

  it('stays within the upstream cap', () => {
    for (const q of ['a b c', 'mount x', 'x lake', 'x', 'mount lake']) {
      expect(planSearch(q, 'en', 'fr').length).toBeLessThanOrEqual(MAX_UPSTREAM_CALLS);
    }
  });

  it('builds its tag filters', () => {
    expect(tagsFor('peak')).toContain('natural:massif');
    expect(tagsFor('water')).toContain('natural:water');
    expect(tagsFor('outdoor')).toEqual(
      expect.arrayContaining(['natural:peak', 'water', 'place:town']),
    );
  });
});

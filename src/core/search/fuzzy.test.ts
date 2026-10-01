import {
  allowedTypos,
  analyzeQuery,
  canonicalTokens,
  damerauLevenshtein,
  matchName,
  tokenScore,
} from './fuzzy';

describe('damerauLevenshtein', () => {
  it.each([
    ['katahdin', 'katahdin', 0],
    ['katadhin', 'katahdin', 1], // one transposition
    ['matterhron', 'matterhorn', 1],
    ['kitten', 'sitting', 3],
    ['', 'abc', 3],
    ['abc', '', 3],
    ['ca', 'abc', 3], // OSA, not unrestricted Damerau
  ])('%s ↔ %s = %d', (a, b, d) => {
    expect(damerauLevenshtein(a, b)).toBe(d);
  });

  it('gives up past the limit', () => {
    expect(damerauLevenshtein('kitten', 'sitting', 1)).toBe(2);
    expect(damerauLevenshtein('a', 'abcdef', 2)).toBe(3);
  });
});

describe('allowedTypos', () => {
  it('scales with the length of the typed word', () => {
    expect([3, 4, 5, 8, 9, 14].map(allowedTypos)).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe('canonicalTokens / analyzeQuery', () => {
  it('folds accents, case, separators, saints, generic words and stop words', () => {
    expect(canonicalTokens('Mont-Sainte-Anne')).toEqual(['<peak>', 'saint', 'anne']);
    expect(canonicalTokens('mt st anne')).toEqual(['<peak>', 'saint', 'anne']);
    expect(canonicalTokens("Lac à l'Île")).toEqual(['<water>', 'ile']);
    expect(canonicalTokens('Étang des Castors')).toEqual(['<water>', 'castors']);
    expect(canonicalTokens('  ')).toEqual([]);
  });

  it('finds the distinctive words and the hint, wherever the generic word is', () => {
    expect(analyzeQuery('katahdin mount')).toMatchObject({ core: ['katahdin'], hint: 'peak' });
    expect(analyzeQuery('Pico Duarte')).toMatchObject({ core: ['duarte'], hint: 'peak' });
    expect(analyzeQuery('saint-jean lac')).toMatchObject({
      core: ['saint', 'jean'],
      hint: 'water',
    });
    expect(analyzeQuery('matterhorn')).toMatchObject({ core: ['matterhorn'], hint: null });
    // A lone generic word is what there is to match.
    expect(analyzeQuery('lake')).toMatchObject({ core: ['<water>'], hint: 'water' });
  });
});

describe('tokenScore', () => {
  it('exact, then prefix, then typos, then typos while still typing', () => {
    expect(tokenScore('katahdin', 'katahdin')).toBe(1);
    expect(tokenScore('kata', 'katahdin')).toBe(0.9);
    expect(tokenScore('katadhin', 'katahdin')).toBe(0.8);
    expect(tokenScore('mattrehron', 'matterhorn')).toBe(0.65);
    expect(tokenScore('katadh', 'katahdin')).toBe(0.75);
    expect(tokenScore('mattrehron', 'matterhornspitze')).toBe(0.6);
  });

  it('is strict on short words and far-off spellings', () => {
    expect(tokenScore('mnt', 'mont')).toBe(0);
    expect(tokenScore('k', 'katahdin')).toBe(0);
    expect(tokenScore('kabachin', 'katahdin')).toBe(0);
    expect(tokenScore('katahdin', 'kata')).toBe(0);
  });
});

describe('matchName', () => {
  it.each([
    ['Mount Katahdin', 'katahdin'],
    ['Mount Katahdin', 'katadhin'],
    ['Mount Katahdin', 'katahdin mount'],
    ['Mount Katahdin', 'katadhin mount'],
    ['Mount Katahdin', 'MONT katahdin'],
    ['Matterhorn', 'matterhron'],
    ['Mont Sainte-Anne', 'mont st anne'],
    ['Mont Sainte-Anne', 'mont ste-anne'],
    ['Mont-Sainte-Anne', 'sainte anne mont'],
    ['Lac Saint-Jean', 'lac st jean'],
    ['Lac Saint-Jean', 'lake saint jean'],
  ])('"%s" matches "%s"', (name, query) => {
    expect(matchName(name, query).score).toBeGreaterThan(0.5);
  });

  it.each([
    ['Mount Suzu', 'katadhin'],
    ['Katahdin Lake', 'katahdin stream'],
    ['Mont Sainte-Anne', 'mont saint jean'],
  ])('"%s" does not match "%s"', (name, query) => {
    expect(matchName(name, query)).toEqual({ score: 0, strong: false });
  });

  it('prefers names fully covered by the query', () => {
    const full = matchName('Katahdin Lake', 'katahdin').score;
    const partial = matchName('Katahdin Lake Trail', 'katahdin').score;
    expect(full).toBe(1);
    expect(partial).toBeLessThan(full);
  });

  it('discounts a generic word the name lacks', () => {
    expect(matchName('Matterhorn', 'mount matterhorn').score).toBeCloseTo(0.95);
    expect(matchName('Mount Katahdin', 'mount katahdin').score).toBe(1);
  });

  it('calls exact or whole-name-prefix matches strong, never typos', () => {
    expect(matchName('Mount Katahdin', 'katahdin').strong).toBe(true);
    expect(matchName('Chamonix-Mont-Blanc', 'chamonix').strong).toBe(true);
    expect(matchName('Mont-Sainte-Anne', 'mont sainte an').strong).toBe(true);
    expect(matchName('Mount Katahdin', 'katadhin').strong).toBe(false);
    expect(matchName('Katahdin Lake Trail', 'lake trail').strong).toBe(false);
  });

  it('matches a lone generic word against generic names', () => {
    expect(matchName('Lake', 'lac').score).toBe(1);
    expect(matchName('Long Lake', 'lake').score).toBeGreaterThan(0);
  });

  it('never matches an empty query, and accepts a pre-analysed one', () => {
    expect(matchName('Anything', '').score).toBe(0);
    expect(matchName('Mount Katahdin', analyzeQuery('katahdin')).score).toBe(1);
  });
});

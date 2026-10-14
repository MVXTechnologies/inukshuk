import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  cpaPageUrl,
  creditableAuthor,
  extractFlightPayload,
  extractJsonArray,
  jsonValueEnd,
  parseListing,
} from './listing';

/**
 * An anonymised snippet of https://cartespleinair.org/cartes (structure as
 * captured 2026-10-14: table rows, the mobile <details> list, and the Next.js
 * flight-payload scripts). Every name, author and id in it is synthetic.
 */
const LISTING = readFileSync(join(__dirname, 'fixtures', 'listing.html'), 'utf8');

describe('parseListing', () => {
  const listing = parseListing(LISTING);

  it('folds one row per section into one map per map id', () => {
    expect(listing.maps.map((m) => m.slug)).toEqual([
      'riviere-exemple-auteure-test-2023',
      'circuit-test-club-exemple-1998',
    ]);
    const [a] = listing.maps;
    expect(a).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Rivière Exemple',
      author: 'Auteure Test',
      year: 2023,
      regions: ['qc:07', 'qc:15'],
    });
    expect(a?.sections).toEqual([
      {
        name: 'du lac A au lac B',
        lengthKm: 21.1,
        river: { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Exemple', regions: ['qc:07'] },
      },
      {
        name: "de l'embouchure [aval]",
        lengthKm: 8.3,
        river: {
          id: 'aaaaaaaa-0000-4000-8000-000000000002',
          name: 'Du Nord (Exemple)',
          regions: ['qc:15'],
        },
      },
    ]);
    expect(a?.rivers.map((r) => r.name)).toEqual(['Exemple', 'Du Nord (Exemple)']);
  });

  it('keeps quotes and provinces as the site writes them', () => {
    expect(listing.maps[1]).toMatchObject({
      title: 'Circuit "Test"',
      author: 'Club Exemple',
      year: 1998,
      regions: ['qc:07', 'ca:on'],
    });
  });

  it('drops a map with no author to credit, and rows with unusable ids, with warnings', () => {
    expect(listing.warnings).toEqual([
      'dropped map sans-auteur-2001: no author to credit',
      'dropped map with an unusable id "not-a-uuid"',
      'payload lists 2 maps but the page links 3',
    ]);
    expect(listing.linkedSlugs).toBe(3);
  });

  it('yields nothing, with a reason, for a page without the payload', () => {
    expect(parseListing('<html><a href="/cartes/x">x</a></html>')).toEqual({
      maps: [],
      warnings: ['no "rows" array in the page payload'],
      linkedSlugs: 1,
    });
    expect(parseListing('').maps).toEqual([]);
  });

  it('refuses a slug claimed by two different maps', () => {
    const row = (id: string) => ({
      map: { id, slug: 'same', name: 'X', author: 'Y' },
      regions: ['qc:01', 'xx:99'],
      section: { name: '', river: { id: 'r', name: 'R', regions: 'qc:01' } },
    });
    const html = `<script>self.__next_f.push(${JSON.stringify([
      1,
      `{"rows":${JSON.stringify([
        row('11111111-1111-4111-8111-111111111111'),
        row('22222222-2222-4222-8222-222222222222'),
      ])}}`,
    ])})</script>`;
    const parsed = parseListing(html);
    expect(parsed.maps).toHaveLength(1);
    expect(parsed.maps[0]?.regions).toEqual(['qc:01']);
    expect(parsed.maps[0]?.sections[0]).toEqual({
      name: 'R',
      river: { id: 'r', name: 'R', regions: [] },
    });
    expect(parsed.warnings[0]).toMatch(/slug "same" already belongs to/);
  });

  it('validates every field it keeps', () => {
    const rows = [
      7,
      { map: null },
      {
        map: {
          id: '11111111-1111-4111-8111-111111111111',
          slug: 'Bad Slug',
          name: 'x',
          author: 'y',
        },
      },
      {
        map: {
          id: '11111111-1111-4111-8111-111111111111',
          slug: 'ok',
          name: '$undefined',
          author: 'y',
        },
      },
      {
        map: {
          id: '11111111-1111-4111-8111-111111111111',
          slug: 'ok',
          name: 'Ok',
          author: 'y',
          authoredYear: 1500,
        },
        section: { river: { id: 'r' } },
      },
    ];
    const html = `<script>self.__next_f.push(${JSON.stringify([1, `{"rows":${JSON.stringify(rows)}}`])})</script>`;
    const parsed = parseListing(html);
    expect(parsed.warnings.slice(0, 4)).toEqual([
      'dropped row without a map',
      'dropped row without a map',
      'dropped map 11111111-1111-4111-8111-111111111111: unusable slug "Bad Slug"',
      'dropped map ok: no name',
    ]);
    expect(parsed.maps).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        slug: 'ok',
        title: 'Ok',
        author: 'y',
        sections: [],
        rivers: [],
        regions: [],
      },
    ]);
  });
});

describe('payload extraction', () => {
  it('concatenates every data chunk in page order and skips the rest', () => {
    const html =
      '<script>self.__next_f.push([0])</script>' +
      '<script>self.__next_f.push([1,"a\\"["])</script>' +
      '<script>self.__next_f.push([2,"no"])</script>' +
      '<script>self.__next_f.push(x)</script>' +
      '<script>self.__next_f.push([1,"b]"])</script>' +
      '<script>self.__next_f.push([1,"unterminated</script>';
    expect(extractFlightPayload(html)).toBe('a"[b]');
  });

  it('finds a JSON array by key, string-aware', () => {
    expect(extractJsonArray('x "rows":[1,"]",{"a":[2]}] y', 'rows')).toEqual([1, ']', { a: [2] }]);
    expect(extractJsonArray('"rows":[1,', 'rows')).toBeNull();
    expect(extractJsonArray('"rows":[1,,2]', 'rows')).toBeNull();
    expect(extractJsonArray('nothing', 'rows')).toBeNull();
  });

  it('jsonValueEnd stops at the matching bracket and rejects a stray close', () => {
    expect(jsonValueEnd('[1,[2]]tail', 0)).toBe(7);
    expect(jsonValueEnd('{"a":"\\"}"}', 0)).toBe(11);
    expect(jsonValueEnd(']', 0)).toBe(-1);
  });
});

it('a map page is a stable URL on the site', () => {
  expect(cpaPageUrl('riviere-x-2023')).toBe('https://cartespleinair.org/cartes/riviere-x-2023');
});

describe('creditableAuthor (no author, no listing: 2.5.2 QA)', () => {
  it('a placeholder is no author, whatever its case or accents', () => {
    for (const v of [
      'Inconnu',
      'inconnu',
      ' INCONNUE ',
      'Unknown',
      'Anonyme',
      'anonymous',
      'N/A',
      '?',
      '',
      '   ',
      null,
      3,
    ]) {
      expect([v, creditableAuthor(v)]).toEqual([v, null]);
    }
  });

  it('a real name is kept, trimmed', () => {
    expect(creditableAuthor('  Charles Leduc ')).toBe('Charles Leduc');
    expect(creditableAuthor('Inconnu Lafleur')).toBe('Inconnu Lafleur');
  });

  it('the committed fragment lists no map without a real author', () => {
    const fragment = JSON.parse(
      readFileSync(
        join(__dirname, '../../../../scripts/catalog/fragments/cartes-plein-air.json'),
        'utf8',
      ),
    ) as { items: { id: string; author?: unknown }[] };
    expect(fragment.items.filter((i) => creditableAuthor(i.author) === null)).toEqual([]);
  });
});

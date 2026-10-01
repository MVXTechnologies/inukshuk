import type { Place } from './place';
import { MAX_RECENTS, pushRecent, sanitizeRecents } from './recents';

const p = (id: string, over: Partial<Place> = {}): Place => ({
  id,
  source: 'index',
  type: 'peak',
  name: `Place ${id}`,
  latitude: 47,
  longitude: -71,
  ...over,
});

describe('pushRecent', () => {
  it('puts the newest first and drops its older copy', () => {
    const list = pushRecent([p('a'), p('b'), p('c')], p('b'));
    expect(list.map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('caps the list', () => {
    let list: Place[] = [];
    for (let i = 0; i < 15; i++) list = pushRecent(list, p(String(i)));
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list[0]?.id).toBe('14');
    expect(pushRecent(list, p('x'), 3)).toHaveLength(3);
  });
});

describe('sanitizeRecents', () => {
  it('keeps valid places with their optional fields', () => {
    const full = p('a', {
      altName: 'Alt',
      context: 'Québec, Canada',
      elevationM: 800,
      bbox: [-71, 46, -70, 47],
    });
    expect(sanitizeRecents([full])).toEqual([full]);
  });

  it('drops junk, duplicates and unknown types or sources, and caps', () => {
    const raw = [
      p('a'),
      p('a'),
      null,
      'x',
      { ...p('b'), type: 'spaceport' },
      { ...p('c'), source: 'google' },
      { ...p('d'), latitude: 91 },
      { ...p('e'), name: '' },
      { ...p('f'), bbox: [1, 2, 3], altName: 5 },
      ...Array.from({ length: 12 }, (_, i) => p(`n${i}`)),
    ];
    const out = sanitizeRecents(raw);
    expect(out[0]?.id).toBe('a');
    expect(out[1]).toEqual(p('f'));
    expect(out).toHaveLength(MAX_RECENTS);
    expect(sanitizeRecents({})).toEqual([]);
  });
});

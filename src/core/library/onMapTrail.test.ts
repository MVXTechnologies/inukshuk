import { onMapChipTrail, sameIdSet, withOnMapTrail } from './onMapTrail';

const tracks = [
  { id: 'a', name: 'Sentier des Crêtes' },
  { id: 'b', name: 'Lac-Beauport loop' },
];
const exists = (id: string) => tracks.some((t) => t.id === id);

describe('withOnMapTrail', () => {
  it('is the Library set when no trail is shown "On map"', () => {
    const base = ['a', 'b'];
    expect(withOnMapTrail(base, null, exists)).toBe(base);
  });

  it('draws the "On map" trail alone, over the Library set', () => {
    expect(withOnMapTrail(['b'], 'a', exists)).toEqual(['a']);
    expect(withOnMapTrail([], 'a', exists)).toEqual(['a']);
  });

  it('falls back to the Library set when that trail is gone', () => {
    const base = ['b'];
    expect(withOnMapTrail(base, 'deleted', exists)).toBe(base);
  });
});

describe('onMapChipTrail', () => {
  it('names the "On map" trail', () => {
    expect(onMapChipTrail('a', tracks, null)).toEqual({ id: 'a', name: 'Sentier des Crêtes' });
  });

  it('shows no chip without an "On map" trail', () => {
    expect(onMapChipTrail(null, tracks, null)).toBeNull();
  });

  it('shows no chip while following that trail (#678)', () => {
    expect(onMapChipTrail('a', tracks, 'a')).toBeNull();
  });

  it('keeps the chip while following another trail', () => {
    expect(onMapChipTrail('a', tracks, 'b')).toEqual({ id: 'a', name: 'Sentier des Crêtes' });
  });

  it('shows no chip once the trail is deleted', () => {
    expect(onMapChipTrail('gone', tracks, null)).toBeNull();
  });
});

describe('sameIdSet', () => {
  it('is order-insensitive', () => {
    expect(sameIdSet(['a', 'b'], ['b', 'a'])).toBe(true);
  });

  it('is true for the same array', () => {
    const ids = ['a'];
    expect(sameIdSet(ids, ids)).toBe(true);
  });

  it('sees an added or removed member', () => {
    expect(sameIdSet(['a'], ['a', 'b'])).toBe(false);
    expect(sameIdSet(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(sameIdSet([], [])).toBe(true);
  });
});

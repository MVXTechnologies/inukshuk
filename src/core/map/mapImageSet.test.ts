import { MAX_IMAGE_HEALS, mapImageSet, onImageMissing, withImages } from './mapImageSet';

const KNOWN = new Set([
  'wp-pin',
  'wp-photo',
  'wpg-default',
  'wpg-camp',
  'ph-count-2',
  'ph-count-40',
]);
const known = (n: string) => KNOWN.has(n);

describe('mapImageSet', () => {
  it('starts from its base names, once each', () => {
    expect(mapImageSet(['wp-pin', 'wp-pin', 'wp-photo']).names).toEqual(['wp-pin', 'wp-photo']);
  });

  it('adds what is new and known, and keeps its identity when nothing is', () => {
    const base = mapImageSet(['wp-pin']);
    expect(withImages(base, ['wp-pin'], known)).toBe(base);
    expect(withImages(base, ['someone-elses'], known)).toBe(base);
    const next = withImages(base, ['wpg-camp', 'wp-pin', 'wpg-camp'], known);
    expect(next.names).toEqual(['wp-pin', 'wpg-camp']);
    expect(next.generation).toBe(0);
  });

  it('never shrinks: a layer that stops asking leaves its names registered', () => {
    let set = mapImageSet(['wp-pin']);
    set = withImages(set, ['wpg-camp'], known);
    set = withImages(set, [], known);
    set = withImages(set, ['wpg-default'], known);
    expect(set.names).toEqual(['wp-pin', 'wpg-camp', 'wpg-default']);
  });
});

describe('onImageMissing', () => {
  it("ignores another layer's names (photo sprites, extension symbols)", () => {
    const set = mapImageSet(['wp-pin']);
    expect(onImageMissing(set, 'm-photos-0', known)).toBe(set);
  });

  it('registers a known name on demand (a cluster of 40 asks for its pill)', () => {
    const set = onImageMissing(mapImageSet(['wp-pin']), 'ph-count-40', known);
    expect(set.names).toEqual(['wp-pin', 'ph-count-40']);
    expect(set.generation).toBe(0);
  });

  it('re-registers everything when the native side lost a name it was given', () => {
    const set = onImageMissing(mapImageSet(['wp-pin', 'ph-count-2']), 'wp-pin', known);
    expect(set.generation).toBe(1);
    expect(set.names).toEqual(['wp-pin', 'ph-count-2']);
  });

  it(`stops re-registering after ${MAX_IMAGE_HEALS} times (a sprite that cannot load must not loop)`, () => {
    let set = mapImageSet(['wp-pin']);
    for (let i = 0; i < MAX_IMAGE_HEALS + 3; i++) set = onImageMissing(set, 'wp-pin', known);
    expect(set.generation).toBe(MAX_IMAGE_HEALS);
    expect(onImageMissing(set, 'wp-pin', known)).toBe(set);
  });
});

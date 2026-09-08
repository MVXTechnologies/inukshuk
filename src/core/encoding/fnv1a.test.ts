import { fnv1a32 } from './fnv1a';

describe('fnv1a32', () => {
  // Reference vectors from the FNV specification.
  it('matches the published test vectors', () => {
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('a')).toBe('e40c292c');
    expect(fnv1a32('foobar')).toBe('bf9cf968');
  });

  it('is stable and sensitive to a single-character change', () => {
    const page = '<html><script>var x = 1;</script></html>';
    expect(fnv1a32(page)).toBe(fnv1a32(page));
    expect(fnv1a32(page)).not.toBe(fnv1a32(page.replace('1', '2')));
    expect(fnv1a32(page)).toMatch(/^[0-9a-f]{8}$/);
  });
});

import { LruCache } from './lru';

describe('LruCache', () => {
  it('evicts the least recently used entry over budget', () => {
    const evicted: string[] = [];
    const c = new LruCache<string, number>(
      3,
      () => 1,
      (k) => evicted.push(k),
    );
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.get('a'); // a is now most recent
    c.set('d', 4);
    expect(evicted).toEqual(['b']);
    expect(c.keys()).toEqual(['c', 'a', 'd']);
    expect(c.size).toBe(3);
  });

  it('peek does not refresh recency', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.peek('a')).toBe(1);
    c.set('c', 3);
    expect(c.has('a')).toBe(false);
    expect(c.get('missing')).toBeUndefined();
  });

  it('budgets by size', () => {
    const c = new LruCache<string, Uint8Array>(1000, (v) => v.length);
    c.set('a', new Uint8Array(400));
    c.set('b', new Uint8Array(400));
    expect(c.bytes).toBe(800);
    c.set('c', new Uint8Array(400));
    expect(c.has('a')).toBe(false);
    expect(c.bytes).toBe(800);
  });

  it('never evicts pinned entries, even over budget', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.pin('a');
    c.set('b', 2);
    c.set('c', 3);
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    c.set('d', 4);
    c.set('e', 5);
    expect(c.has('a')).toBe(true);
    expect(c.isPinned('a')).toBe(true);
    c.unpin('a');
    c.set('f', 6);
    expect(c.has('a')).toBe(false);
  });

  it('setPins replaces the on-screen set', () => {
    const c = new LruCache<string, number>(10);
    for (const k of ['a', 'b', 'c', 'd']) c.set(k, 0);
    c.setPins(['b', 'd']);
    expect(c.clearUnpinned()).toBe(2);
    expect(c.keys()).toEqual(['b', 'd']);
  });

  it('a pinned set larger than the budget is kept whole', () => {
    const c = new LruCache<string, number>(2);
    c.setPins(['a', 'b', 'c']);
    for (const k of ['a', 'b', 'c']) c.set(k, 0);
    expect(c.size).toBe(3);
  });

  it('replacing a key adjusts the size and reports the old value', () => {
    const evicted: number[] = [];
    const c = new LruCache<string, number[]>(
      10,
      (v) => v.length,
      (_k, v) => evicted.push(v.length),
    );
    c.set('a', [1, 2, 3]);
    c.set('a', [1]);
    expect(c.bytes).toBe(1);
    expect(evicted).toEqual([3]);
  });

  it('delete removes and unpins', () => {
    const c = new LruCache<string, number>(10);
    c.set('a', 1);
    c.pin('a');
    expect(c.delete('a')).toBe(true);
    expect(c.delete('a')).toBe(false);
    expect(c.isPinned('a')).toBe(false);
    expect(c.bytes).toBe(0);
  });

  it('shrinking the budget trims immediately; low memory drops all unpinned', () => {
    const c = new LruCache<number, number>(100);
    for (let i = 0; i < 50; i++) c.set(i, i);
    c.setBudget(10);
    expect(c.size).toBe(10);
    expect(c.keys()[0]).toBe(40);
    expect(c.capacity).toBe(10);
    c.pin(45);
    c.clearUnpinned();
    expect(c.keys()).toEqual([45]);
  });

  it('within budget trim is a no-op', () => {
    const c = new LruCache<number, number>(5);
    c.set(1, 1);
    expect(c.trim()).toBe(0);
  });

  it('a long random session never exceeds budget + pinned', () => {
    const c = new LruCache<number, number>(32, () => 1);
    let seed = 1;
    const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let step = 0; step < 5000; step++) {
      const pins = Array.from({ length: 8 }, () => Math.floor(r() * 200));
      c.setPins(pins);
      for (const p of pins) c.set(p, step);
      c.set(Math.floor(r() * 200), step);
      expect(c.size).toBeLessThanOrEqual(32 + 8);
      for (const p of pins) expect(c.has(p)).toBe(true);
    }
  });
});

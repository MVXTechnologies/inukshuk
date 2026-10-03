/**
 * A size-bounded LRU cache with pinning — the shape of the native engines'
 * DEM cache (CPU, by bytes) and tile-mesh cache (GPU, by count). Pinned
 * entries (on screen this frame) are never evicted; `trim` evicts the
 * least-recently-used unpinned entries until the total fits.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, { value: V; size: number }>();
  private readonly pins = new Set<K>();
  private total = 0;

  constructor(
    private budget: number,
    private readonly sizeOf: (v: V) => number = () => 1,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.total;
  }

  get capacity(): number {
    return this.budget;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Read and mark as most recently used. */
  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  /** Read without touching recency. */
  peek(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  set(key: K, value: V): void {
    const old = this.map.get(key);
    if (old) {
      this.total -= old.size;
      this.map.delete(key);
      if (old.value !== value) this.onEvict?.(key, old.value);
    }
    const size = Math.max(0, this.sizeOf(value));
    this.map.set(key, { value, size });
    this.total += size;
    this.trim();
  }

  delete(key: K): boolean {
    const e = this.map.get(key);
    if (!e) return false;
    this.map.delete(key);
    this.pins.delete(key);
    this.total -= e.size;
    this.onEvict?.(key, e.value);
    return true;
  }

  pin(key: K): void {
    this.pins.add(key);
  }

  unpin(key: K): void {
    this.pins.delete(key);
  }

  /** Replace the pinned set (the tiles on screen this frame). */
  setPins(keys: Iterable<K>): void {
    this.pins.clear();
    for (const k of keys) this.pins.add(k);
  }

  isPinned(key: K): boolean {
    return this.pins.has(key);
  }

  /** Evict LRU unpinned entries until within `budget` (default: the capacity). */
  trim(budget = this.budget): number {
    let evicted = 0;
    if (this.total <= budget) return 0;
    for (const [k, e] of this.map) {
      if (this.total <= budget) break;
      if (this.pins.has(k)) continue;
      this.map.delete(k);
      this.total -= e.size;
      this.onEvict?.(k, e.value);
      evicted++;
    }
    return evicted;
  }

  setBudget(budget: number): void {
    this.budget = budget;
    this.trim();
  }

  /** Low-memory: drop everything not pinned. */
  clearUnpinned(): number {
    return this.trim(0);
  }

  /** Keys, least recently used first. */
  keys(): K[] {
    return [...this.map.keys()];
  }
}

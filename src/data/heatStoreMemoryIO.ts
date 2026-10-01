import type { HeatStoreIO } from './heatStoreFiles';

/**
 * Test-only (never imported by the app): an in-memory heat store directory
 * with read/write counters and a switchable write failure.
 */
export class MemoryHeatIO implements HeatStoreIO {
  readonly files = new Map<string, string | Uint8Array>();
  reads = 0;
  writes = 0;
  /** Throw on the next write whose name matches (simulates a crash / full disk). */
  failWrite: RegExp | null = null;

  private check(name: string) {
    if (this.failWrite?.test(name)) {
      this.failWrite = null;
      throw new Error(`simulated write failure: ${name}`);
    }
  }
  async readText(name: string) {
    this.reads++;
    const v = this.files.get(name);
    return typeof v === 'string' ? v : null;
  }
  async readBytes(name: string) {
    this.reads++;
    const v = this.files.get(name);
    return v instanceof Uint8Array ? v : null;
  }
  writeText(name: string, text: string) {
    this.check(name);
    this.writes++;
    this.files.set(name, text);
  }
  writeBytes(name: string, bytes: Uint8Array) {
    this.check(name);
    this.writes++;
    this.files.set(name, bytes);
  }
  remove(name: string) {
    this.files.delete(name);
  }
  clear() {
    this.files.clear();
  }
  /** Total stored bytes (text counted as UTF-16 code units ≈ bytes for ASCII JSON). */
  size(prefix = ''): number {
    let n = 0;
    for (const [k, v] of this.files) if (k.startsWith(prefix)) n += v.length;
    return n;
  }
}

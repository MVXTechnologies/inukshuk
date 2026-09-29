/**
 * Shared, polite HTTP plumbing for the catalog generators (Node only).
 *
 * Every request identifies itself with {@link USER_AGENT}, retries transient
 * failures with backoff, and treats a settled 4xx as an answer rather than an
 * error — one missing sheet must never abort a 20 000-sheet crawl. Callers
 * bound their own parallelism with {@link mapPool}.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const USER_AGENT = 'inukshuk-catalog/1.0 (+https://inukshuk.mvxtechnologies.com)';

/** Backoff between attempts; a request gets 1 + RETRY_DELAYS_MS.length tries. */
const RETRY_DELAYS_MS = [1000, 4000, 12000];

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PoliteFetchOptions {
  method?: 'GET' | 'HEAD' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  /** 'manual' to read a 3xx Location instead of following it. */
  redirect?: 'follow' | 'manual';
}

/**
 * Fetch with a custom User-Agent and backoff. Returns the response for any
 * settled status (2xx, 3xx with redirect: 'manual', 4xx other than 429), or
 * null when every attempt failed on a 5xx/429/network error.
 */
export async function politeFetch(
  url: string,
  options: PoliteFetchOptions = {},
): Promise<Response | null> {
  for (let attempt = 0; ; attempt++) {
    let reason = '';
    try {
      const res = await fetch(url, {
        method: options.method ?? 'GET',
        redirect: options.redirect ?? 'follow',
        headers: { 'User-Agent': USER_AGENT, ...(options.headers ?? {}) },
        ...(options.body !== undefined ? { body: options.body } : {}),
      });
      if (res.status < 500 && res.status !== 429) return res;
      reason = `HTTP ${res.status}`;
      await res.body?.cancel();
    } catch (err: unknown) {
      reason = err instanceof Error ? err.message : String(err);
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      console.warn(`  ${options.method ?? 'GET'} ${url} failed (${reason}) — giving up`);
      return null;
    }
    await sleep(delay);
  }
}

/** Run `fn` over `items` with at most `concurrency` in flight; results keep input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Download `url` to `path` once; later calls reuse the file. */
export async function cachedDownload(url: string, path: string): Promise<string> {
  if (existsSync(path)) return path;
  console.log(`GET ${url}`);
  const res = await politeFetch(url);
  if (res === null || !res.ok) throw new Error(`GET ${url} → ${res?.status ?? 'network error'}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  console.log(`  ${(bytes.length / 1024 / 1024).toFixed(1)} MB → ${path}`);
  return path;
}

/** A tiny JSON key/value cache on disk, flushed on demand. */
export class JsonCache<V> {
  private readonly entries: Record<string, V>;
  private dirty = 0;

  constructor(private readonly path: string) {
    let loaded: Record<string, V> = {};
    try {
      loaded = JSON.parse(readFileSync(path, 'utf8')) as Record<string, V>;
    } catch {
      // Missing or unreadable cache: start empty.
    }
    this.entries = loaded;
  }

  get(key: string): V | undefined {
    return this.entries[key];
  }

  set(key: string, value: V, flushEvery = 200): void {
    this.entries[key] = value;
    this.dirty += 1;
    if (this.dirty >= flushEvery) this.flush();
  }

  flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.entries));
    this.dirty = 0;
  }
}

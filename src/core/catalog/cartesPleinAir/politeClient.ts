import { isAllowed, robotsFromStatus, type RobotsPolicy } from './robots';

/**
 * A polite HTTP client for the catalog crawler (#680). Platform-free: the
 * fetch, the clock and the sleep are injected, so the politeness rules are
 * unit-tested with fakes instead of being trusted.
 *
 * Every request:
 * - identifies itself with the crawler's User-Agent;
 * - is checked against the host's robots.txt first (read once per origin,
 *   through this same client, so it is throttled and identified too). An
 *   unreachable robots.txt means "disallow all" (RFC 9309), never "go ahead";
 * - waits until at least `minIntervalMs` (or the host's `Crawl-delay`, when
 *   longer) has passed since the previous request to the same host, so the
 *   crawl stays at or under one request per second per host;
 * - may carry the validators of a previous answer (`If-None-Match`,
 *   `If-Modified-Since`), so an unchanged document costs a 304 and no body.
 *
 * Transient failures (network error, 5xx, 429) are retried a bounded number
 * of times with backoff, honouring `Retry-After`; anything else is an answer.
 *
 * Redirects are never left to the fetch (2.5.2 review): it would follow them
 * to any host, past that host's robots.txt and its throttle. The client asks
 * with `redirect: 'manual'` and follows a `Location` itself (http(s) only, at
 * most {@link MAX_REDIRECTS} hops), each hop a request of its own: checked
 * against its host's robots.txt, throttled for its host, counted. The answer
 * says which URL it finally came from, so a caller can refuse a hop off its
 * publisher's site. `redirect: 'manual'` returns the 3xx itself.
 */

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  /** Always manual: the client follows redirects itself. */
  redirect: 'manual';
}

export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponse>;

/** What a previous answer said about its version. */
export interface Validators {
  etag?: string;
  lastModified?: string;
}

export interface PoliteClientOptions {
  /** Full User-Agent header, e.g. "InukshukCatalogBot/1.0 (+https://…)". */
  userAgent: string;
  /** The robots.txt product token, e.g. "InukshukCatalogBot". */
  productToken: string;
  /** Minimum gap between two requests to one host. */
  minIntervalMs: number;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Attempts per request, transient failures included (default 3). */
  maxAttempts?: number;
  /** Backoff before attempt 2, 3, … (default 2 s, 8 s). */
  backoffMs?: readonly number[];
  log?: (message: string) => void;
}

export type PoliteResult =
  /** `url`: where the answer came from, after any redirect the client followed. */
  | { kind: 'response'; response: HttpResponse; url: string }
  | { kind: 'disallowed' }
  | { kind: 'failed'; reason: string };

export interface PoliteRequest {
  method?: 'GET' | 'HEAD';
  redirect?: 'follow' | 'manual';
  validators?: Validators;
  headers?: Record<string, string>;
  /**
   * Where a followed redirect may go: a `Location` this refuses is not
   * requested at all, and the 3xx is the answer (its `url` the last one asked).
   */
  stayOn?: (url: string) => boolean;
}

/** Redirects followed per request (RFC 9309 asks at least five for robots.txt). */
export const MAX_REDIRECTS = 5;

/** A `Retry-After` longer than this is not waited for: the request fails instead. */
const MAX_RETRY_AFTER_MS = 60_000;

/** The validators an answer carries (ETag, Last-Modified), if any. */
export function validatorsOf(response: HttpResponse): Validators {
  const etag = response.headers.get('etag') ?? undefined;
  const lastModified = response.headers.get('last-modified') ?? undefined;
  return {
    ...(etag !== undefined && etag !== '' ? { etag } : {}),
    ...(lastModified !== undefined && lastModified !== '' ? { lastModified } : {}),
  };
}

/** Conditional-request headers for a previous answer's validators. */
export function conditionalHeaders(validators: Validators | undefined): Record<string, string> {
  return {
    ...(validators?.etag !== undefined ? { 'If-None-Match': validators.etag } : {}),
    ...(validators?.lastModified !== undefined
      ? { 'If-Modified-Since': validators.lastModified }
      : {}),
  };
}

function retryAfterMs(response: HttpResponse): number | null {
  const header = response.headers.get('retry-after');
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

export class PoliteClient {
  private readonly robots = new Map<string, Promise<RobotsPolicy>>();
  private readonly lastRequestAt = new Map<string, number>();
  private readonly perHost = new Map<string, number>();

  constructor(private readonly options: PoliteClientOptions) {}

  /** Requests actually sent, per host (robots.txt and retries included). */
  requestCounts(): Record<string, number> {
    return Object.fromEntries(this.perHost);
  }

  async request(url: string, request: PoliteRequest = {}): Promise<PoliteResult> {
    return this.follow(url, request, true);
  }

  /**
   * One request and the redirects it leads to, each hop a request of its own
   * (robots.txt when `obeyRobots`, the hop's own host throttle). Validators
   * belong to the first URL only.
   */
  private async follow(
    url: string,
    request: PoliteRequest,
    obeyRobots: boolean,
  ): Promise<PoliteResult> {
    let current = url;
    let req = request;
    for (let hop = 0; ; hop++) {
      let target: URL;
      try {
        target = new URL(current);
      } catch {
        return this.fail(`unusable URL ${current}`);
      }
      if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        return this.fail(`refused a ${target.protocol} URL (${current})`);
      }
      let policy: RobotsPolicy | null = null;
      if (obeyRobots) {
        policy = await this.robotsFor(target);
        if (!isAllowed(policy, `${target.pathname}${target.search}`)) {
          this.options.log?.(`robots.txt disallows ${current}; not fetched`);
          return { kind: 'disallowed' };
        }
      }
      const result = await this.send(current, req, policy);
      if (result.kind !== 'response' || req.redirect === 'manual') return result;
      const { status, headers } = result.response;
      const location = status >= 300 && status < 400 ? headers.get('location') : null;
      if (location === null || status === 304) return result;
      if (hop >= MAX_REDIRECTS)
        return this.fail(`more than ${MAX_REDIRECTS} redirects from ${url}`);
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        return this.fail(`unusable redirect from ${result.url} (${location})`);
      }
      if (req.stayOn !== undefined && !req.stayOn(next)) {
        this.options.log?.(`${current} redirects to ${next}; not followed`);
        return result;
      }
      current = next;
      req = {
        ...(req.method !== undefined ? { method: req.method } : {}),
        ...(req.headers !== undefined ? { headers: req.headers } : {}),
        ...(req.stayOn !== undefined ? { stayOn: req.stayOn } : {}),
      };
    }
  }

  private fail(reason: string): PoliteResult {
    this.options.log?.(reason);
    return { kind: 'failed', reason };
  }

  private robotsFor(target: URL): Promise<RobotsPolicy> {
    let pending = this.robots.get(target.origin);
    if (pending === undefined) {
      pending = (async () => {
        const result = await this.follow(`${target.origin}/robots.txt`, {}, false);
        if (result.kind !== 'response') {
          this.options.log?.(`${target.origin}/robots.txt unreachable: assuming disallow-all`);
          return robotsFromStatus(null, '', this.options.productToken);
        }
        const body = result.response.status < 300 ? await result.response.text() : '';
        return robotsFromStatus(result.response.status, body, this.options.productToken);
      })();
      this.robots.set(target.origin, pending);
    }
    return pending;
  }

  private async throttle(host: string, policy: RobotsPolicy | null): Promise<void> {
    const delay = Math.max(this.options.minIntervalMs, (policy?.crawlDelaySec ?? 0) * 1000);
    const last = this.lastRequestAt.get(host);
    if (last !== undefined) {
      const wait = last + delay - this.options.now();
      if (wait > 0) await this.options.sleep(wait);
    }
    this.lastRequestAt.set(host, this.options.now());
    this.perHost.set(host, (this.perHost.get(host) ?? 0) + 1);
  }

  private async send(
    url: string,
    request: PoliteRequest,
    policy: RobotsPolicy | null,
  ): Promise<PoliteResult> {
    const host = new URL(url).host;
    const maxAttempts = this.options.maxAttempts ?? 3;
    const backoff = this.options.backoffMs ?? [2000, 8000];
    const init: HttpRequestInit = {
      method: request.method ?? 'GET',
      redirect: 'manual',
      headers: {
        ...(request.headers ?? {}),
        ...conditionalHeaders(request.validators),
        'User-Agent': this.options.userAgent,
      },
    };
    let reason = '';
    for (let attempt = 1; ; attempt++) {
      await this.throttle(host, policy);
      let pause: number | null = null;
      try {
        const response = await this.options.fetch(url, init);
        if (response.status < 500 && response.status !== 429) {
          return { kind: 'response', response, url };
        }
        reason = `HTTP ${response.status}`;
        pause = retryAfterMs(response);
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
      if (attempt >= maxAttempts) break;
      if (pause !== null && pause > MAX_RETRY_AFTER_MS) break;
      await this.options.sleep(pause ?? backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 0);
    }
    this.options.log?.(`${init.method} ${url} failed (${reason})`);
    return { kind: 'failed', reason };
  }
}

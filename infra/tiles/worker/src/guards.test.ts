/**
 * Abuse and cost guards (./guards.ts), run by the app's Jest in Node.
 */
import {
  allowRequest,
  archiveAllowlist,
  DEFAULT_ARCHIVES,
  glyphStack,
  isPlausibleToken,
  memoryLimiter,
  positiveInt,
  readTextCapped,
  staticCacheUrl,
  tooManyRequests,
  utcDay,
} from './guards';

describe('archiveAllowlist', () => {
  it('defaults to the archives the app and the NAS pipeline use', () => {
    const set = archiveAllowlist(undefined);
    for (const name of ['basemap', 'peaks', 'parks', 'geodetic', 'tides']) {
      expect(set.has(name)).toBe(true);
    }
    expect(set.has('donors')).toBe(false);
    expect(set.has('basemap-na-west')).toBe(false);
    expect([...set]).toEqual([...DEFAULT_ARCHIVES]);
  });

  it('takes a comma-separated override and ignores malformed names', () => {
    const set = archiveAllowlist(' basemap , new_one,../x, ');
    expect([...set].sort()).toEqual(['basemap', 'new_one']);
  });

  it('falls back to the defaults when the override has no valid name', () => {
    expect([...archiveAllowlist(' , ../')]).toEqual([...DEFAULT_ARCHIVES]);
  });
});

describe('staticCacheUrl', () => {
  const key = (u: string) => staticCacheUrl(new URL(u), '2');

  it('keeps the path and the app version, drops everything else', () => {
    expect(key('https://w.dev/contours/9/1/2.mvt?v=2')).toBe(
      'https://w.dev/contours/9/1/2.mvt?v=2&__g=2',
    );
    expect(key('https://w.dev/basemap/9/1/2.mvt?junk=123&v=2&__g=9')).toBe(
      'https://w.dev/basemap/9/1/2.mvt?v=2&__g=2',
    );
  });

  it('gives every random query string the same entry', () => {
    const a = key('https://w.dev/basemap/9/1/2.mvt?r=1');
    const b = key('https://w.dev/basemap/9/1/2.mvt?r=2&s=3');
    expect(a).toBe(b);
    expect(a).toBe('https://w.dev/basemap/9/1/2.mvt?__g=2');
  });

  it('drops a version that is not a small number', () => {
    expect(key('https://w.dev/x.json?v=abc')).toBe('https://w.dev/x.json?__g=2');
    expect(key('https://w.dev/x.json?v=123456')).toBe('https://w.dev/x.json?__g=2');
  });
});

describe('isPlausibleToken', () => {
  it('accepts Strava-shaped codes and tokens', () => {
    expect(isPlausibleToken('a'.repeat(40))).toBe(true);
    expect(isPlausibleToken('0f3A-._~')).toBe(true);
  });

  it.each([[''], ['a'.repeat(257)], ['abc&client_secret=x'], ['a b'], ['é'], [42], [null]])(
    'refuses %p',
    (value) => {
      expect(isPlausibleToken(value)).toBe(false);
    },
  );
});

describe('glyphStack', () => {
  it('decodes a plain font name', () => {
    expect(glyphStack('Atkinson%20Hyperlegible%20Next%20Regular')).toBe(
      'Atkinson Hyperlegible Next Regular',
    );
    expect(glyphStack('Noto%20Sans%20Regular,Noto%20Sans%20Bold')).toBe(
      'Noto Sans Regular,Noto Sans Bold',
    );
  });

  it('refuses malformed escapes and anything that is not a font name', () => {
    expect(glyphStack('%E0%A4%A')).toBeNull();
    expect(glyphStack('..%2F..%2Fdonors')).toBeNull();
    expect(glyphStack('a'.repeat(129))).toBeNull();
    expect(glyphStack('')).toBeNull();
  });
});

describe('readTextCapped', () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request('https://w.dev/x', { method: 'POST', body, headers });

  it('returns the body when it fits', async () => {
    expect(await readTextCapped(post('{"a":1}'), 100)).toBe('{"a":1}');
  });

  it('refuses a declared length over the cap without reading', async () => {
    const req = post('x', { 'Content-Length': '5000' });
    expect(await readTextCapped(req, 100)).toBeNull();
  });

  it('refuses a streamed body that grows past the cap', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 1000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const req = new Request('https://w.dev/x', {
      method: 'POST',
      body: stream,
      // Node needs this for a streamed request body.
      ...({ duplex: 'half' } as Record<string, unknown>),
    });
    expect(await readTextCapped(req, 1024)).toBeNull();
    // It stopped reading soon after the cap, not after the whole stream.
    expect(sent).toBeLessThan(40);
  });

  it('counts bytes, not characters', async () => {
    expect(await readTextCapped(post('é'.repeat(60)), 100)).toBeNull();
    expect(await readTextCapped(post('é'.repeat(50)), 100)).toBe('é'.repeat(50));
  });

  it('reads a request without a body as empty', async () => {
    expect(await readTextCapped(new Request('https://w.dev/x'), 10)).toBe('');
  });
});

describe('memoryLimiter', () => {
  it('allows `limit` calls per window per key', () => {
    const allow = memoryLimiter(2, 1000);
    expect(allow('a', 0)).toBe(true);
    expect(allow('a', 10)).toBe(true);
    expect(allow('a', 20)).toBe(false);
    expect(allow('b', 20)).toBe(true);
    expect(allow('a', 1001)).toBe(true);
  });

  it('forgets everyone rather than growing past maxKeys', () => {
    const allow = memoryLimiter(1, 1000, 2);
    expect(allow('a', 0)).toBe(true);
    expect(allow('b', 0)).toBe(true);
    expect(allow('c', 0)).toBe(true); // cleared the table
    expect(allow('a', 0)).toBe(true);
  });
});

describe('allowRequest', () => {
  const binding = (success: boolean) => ({ limit: jest.fn(async () => ({ success })) });

  it('needs both the floor and the binding to agree', async () => {
    expect(await allowRequest(binding(true), () => true, 'k')).toBe(true);
    expect(await allowRequest(binding(false), () => true, 'k')).toBe(false);
    const b = binding(true);
    expect(await allowRequest(b, () => false, 'k')).toBe(false);
    expect(b.limit).not.toHaveBeenCalled();
  });

  it('uses the floor alone without a binding, and fails open if the binding throws', async () => {
    expect(await allowRequest(undefined, () => true, 'k')).toBe(true);
    const broken = {
      limit: async () => {
        throw new Error('down');
      },
    };
    expect(await allowRequest(broken, () => true, 'k')).toBe(true);
  });
});

describe('tooManyRequests', () => {
  it('is an uncacheable 429 with Retry-After and the CORS headers', async () => {
    const res = tooManyRequests({ 'Access-Control-Allow-Origin': '*' }, 30);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.json()).toEqual({ message: 'too many requests, try again shortly' });
  });
});

describe('utcDay / positiveInt', () => {
  it('names the UTC day and when it ends', () => {
    const now = Date.UTC(2026, 9, 6, 23, 59, 59);
    expect(utcDay(now)).toEqual({ day: '2026-10-06', endsAt: Date.UTC(2026, 9, 7) });
  });

  it('parses positive integers only', () => {
    expect(positiveInt('25', 9)).toBe(25);
    for (const bad of [undefined, '', '0', '-3', '2.5', 'x']) expect(positiveInt(bad, 9)).toBe(9);
  });
});

/**
 * POST /donor-verify/start|check (#476, round 3). Pure handler with fakes: an
 * in-memory R2, a readable "HMAC", a fixed code and a clock.
 */
import {
  CODE_TTL_MS,
  codeEmail,
  handleVerify,
  MAX_ATTEMPTS,
  MAX_STARTS_PER_HOUR,
  normalizeCode,
  normalizeEmail,
  randomCode,
  sameString,
  type PendingCode,
  type VerifyDeps,
} from '../src/donorVerify';

function world() {
  const store = new Map<string, PendingCode>();
  let now = 1_000_000;
  let nextCode = '123456';
  let allowed = true;
  const sent: { email: string; code: string }[] = [];
  const deps: VerifyDeps = {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => {
      store.set(k, v);
    },
    delete: async (k) => {
      store.delete(k);
    },
    sweep: async () => undefined,
    allow: async () => allowed,
    hmac: async (m) => `h(${m})`,
    code: () => nextCode,
    sendCode: async (email, code) => {
      sent.push({ email, code });
      return true;
    },
    now: () => now,
  };
  const call = (route: 'start' | 'check', body: unknown) =>
    handleVerify(
      { route, method: 'POST', client: '203.0.113.9', body: JSON.stringify(body) },
      deps,
    );
  return {
    store,
    sent,
    deps,
    call,
    tick: (ms: number) => (now += ms),
    setCode: (c: string) => (nextCode = c),
    block: () => (allowed = false),
  };
}

describe('start', () => {
  it('stops minting codes once the global send budget is spent, storing and sending nothing', async () => {
    const w = world();
    let budget = 1;
    w.deps.allowSend = async () => budget-- > 0;
    expect((await w.call('start', { email: 'a@b.ca' })).status).toBe(202);
    const res = await w.call('start', { email: 'other@b.ca' });
    expect(res).toEqual({ status: 429, body: { ok: false, error: 'try again later' } });
    expect(w.sent.map((s) => s.email)).toEqual(['a@b.ca']);
    expect(w.store.size).toBe(1);
  });

  it('emails a code and stores only hashes, never the address or the code', async () => {
    const w = world();
    const res = await w.call('start', { email: '  Anne@Example.org ' });
    expect(res).toEqual({ status: 202, body: { ok: true } });
    expect(w.sent).toEqual([{ email: 'anne@example.org', code: '123456' }]);
    const [[key, value]] = [...w.store.entries()] as [[string, PendingCode]];
    expect(key).toBe('donor-verify/h(email:anne@example.org).json');
    expect(value.proof).toBe('h(code:anne@example.org|123456)');
    expect(value.expiresAt).toBe(1_000_000 + CODE_TTL_MS);
    // (The fake HMAC is readable; the real one is HMAC-SHA256 with a secret salt.)
    expect(Object.keys(value).sort()).toEqual(['attempts', 'expiresAt', 'proof', 'starts']);
  });

  it(`sends at most ${MAX_STARTS_PER_HOUR} codes per address per hour`, async () => {
    const w = world();
    for (let i = 0; i < MAX_STARTS_PER_HOUR; i++) {
      expect((await w.call('start', { email: 'a@b.ca' })).status).toBe(202);
    }
    expect((await w.call('start', { email: 'a@b.ca' })).status).toBe(429);
    w.tick(60 * 60_000);
    expect((await w.call('start', { email: 'a@b.ca' })).status).toBe(202);
    expect(w.sent).toHaveLength(MAX_STARTS_PER_HOUR + 1);
  });

  it('answers the same whether or not the email could be sent', async () => {
    const w = world();
    w.deps.sendCode = async () => {
      throw new Error('resend down');
    };
    expect(await w.call('start', { email: 'a@b.ca' })).toEqual({ status: 202, body: { ok: true } });
  });

  it.each([
    ['not an email', { email: 'nope' }],
    ['two emails', { email: 'a@b.ca,c@d.ca' }],
    ['no email', {}],
    ['a very long email', { email: `${'a'.repeat(250)}@b.ca` }],
  ])('rejects %s', async (_label, body) => {
    const w = world();
    expect((await w.call('start', body)).status).toBe(400);
    expect(w.sent).toHaveLength(0);
  });

  it('rate-limits per client before anything else', async () => {
    const w = world();
    w.block();
    expect((await w.call('start', { email: 'a@b.ca' })).status).toBe(429);
    expect(w.sent).toHaveLength(0);
  });

  it('refuses GET, bad JSON and big bodies', async () => {
    const w = world();
    const base = { route: 'start' as const, client: 'x' };
    expect((await handleVerify({ ...base, method: 'GET', body: '' }, w.deps)).status).toBe(405);
    expect((await handleVerify({ ...base, method: 'POST', body: '{' }, w.deps)).status).toBe(400);
    expect(
      (await handleVerify({ ...base, method: 'POST', body: 'x'.repeat(2000) }, w.deps)).status,
    ).toBe(400);
  });
});

describe('check', () => {
  it('accepts the right code once, then forgets everything', async () => {
    const w = world();
    await w.call('start', { email: 'a@b.ca' });
    expect(await w.call('check', { email: 'A@b.ca', code: '123 456' })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(w.store.size).toBe(0);
    expect((await w.call('check', { email: 'a@b.ca', code: '123456' })).status).toBe(400);
  });

  it('gives the same answer for a wrong code, an expired code and no code at all', async () => {
    const w = world();
    const never = await w.call('check', { email: 'x@y.ca', code: '123456' });
    await w.call('start', { email: 'a@b.ca' });
    const wrong = await w.call('check', { email: 'a@b.ca', code: '000000' });
    w.tick(CODE_TTL_MS);
    const expired = await w.call('check', { email: 'a@b.ca', code: '123456' });
    expect(never).toEqual({ status: 400, body: { ok: false } });
    expect(wrong).toEqual(never);
    expect(expired).toEqual(never);
  });

  it(`burns the code after ${MAX_ATTEMPTS} wrong tries, keeping the hourly limit`, async () => {
    const w = world();
    await w.call('start', { email: 'a@b.ca' });
    for (let i = 0; i < MAX_ATTEMPTS; i++)
      await w.call('check', { email: 'a@b.ca', code: '999999' });
    expect((await w.call('check', { email: 'a@b.ca', code: '123456' })).status).toBe(400);
    const left = [...w.store.values()][0];
    expect(left?.proof).toBe('');
    expect(left?.starts).toHaveLength(1);
  });

  it('rejects a malformed code without touching the store', async () => {
    const w = world();
    await w.call('start', { email: 'a@b.ca' });
    expect(await w.call('check', { email: 'a@b.ca', code: '12ab56' })).toMatchObject({
      status: 400,
      body: { error: 'invalid code' },
    });
    expect([...w.store.values()][0]?.attempts).toBe(0);
  });
});

describe('helpers', () => {
  it('normalizes emails and codes', () => {
    expect(normalizeEmail(' A@B.CA ')).toBe('a@b.ca');
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail(3)).toBeNull();
    expect(normalizeCode(' 12 34 56')).toBe('123456');
    expect(normalizeCode('12345')).toBeNull();
  });

  it('compares in constant time', () => {
    expect(sameString('abc', 'abc')).toBe(true);
    expect(sameString('abc', 'abd')).toBe(false);
    expect(sameString('abc', 'ab')).toBe(false);
  });

  it('draws six digits without modulo bias', () => {
    const values = [0xffffffff, 42];
    const code = randomCode((a) => {
      a[0] = values.shift() ?? 0;
      return a;
    });
    // The first draw is past the unbiased range and is thrown away.
    expect(code).toBe('000042');
  });

  it('writes a plain bilingual message', () => {
    const { subject, text } = codeEmail('123456');
    expect(subject).toBe('Your Inukshuk code / Votre code Inukshuk');
    expect(text).toContain('Your Inukshuk code is 123456');
    expect(text).toContain('Votre code Inukshuk est 123456');
  });
});

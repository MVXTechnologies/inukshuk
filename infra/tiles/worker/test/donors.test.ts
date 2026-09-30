/**
 * POST /donors (#476). Pure handler, run by the app's Jest (the Worker project
 * has no test runner of its own); the R2 put and the limiter are fakes.
 */
import { handleDonor, memoryLimiter, parseDonor, type DonorDeps } from '../src/donors';

const NOW = new Date('2026-10-02T12:00:00Z');
const valid = {
  name: '  Anne   T. ',
  place: 'Rimouski',
  platform: 'android',
  transactionIds: ['GPA.3312-1234-5678-90123', 'GPA.3312-1234-5678-90123'],
};

function deps(allow = true) {
  const put = jest.fn(async () => undefined);
  const d: DonorDeps = {
    put,
    allow: async () => allow,
    now: () => NOW,
    random: () => 'ab12cd34',
  };
  return { d, put };
}

const post = (body: unknown, client = '203.0.113.9') => ({
  method: 'POST',
  client,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

describe('handleDonor', () => {
  it('files a valid submission as pending, cleaned and deduplicated', async () => {
    const { d, put } = deps();
    const res = await handleDonor(post({ ...valid, email: 'x@y.z', deviceId: 'abc' }), d);
    expect(res).toEqual({ status: 202, body: { ok: true } });
    expect(put).toHaveBeenCalledTimes(1);
    const [key, json] = put.mock.calls[0] as unknown as [string, string];
    expect(key).toBe(`donors/pending/${NOW.getTime()}-ab12cd34.json`);
    expect(JSON.parse(json)).toEqual({
      name: 'Anne T.',
      place: 'Rimouski',
      platform: 'android',
      transactionIds: ['GPA.3312-1234-5678-90123'],
      receivedAt: NOW.toISOString(),
    });
    // Nothing identifying beyond what the person typed: no IP, no email.
    expect(json).not.toMatch(/203\.0\.113\.9|x@y\.z|deviceId/);
  });

  it('rate-limits before reading the body', async () => {
    const { d, put } = deps(false);
    expect((await handleDonor(post(valid), d)).status).toBe(429);
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', { method: 'GET', client: 'x', body: '' }, 405],
    ['bad JSON', post('{nope'), 400],
    ['a huge body', post({ ...valid, name: 'a'.repeat(5000) }), 413],
  ])('refuses %s', async (_label, req, status) => {
    const { d, put } = deps();
    expect((await handleDonor(req, d)).status).toBe(status);
    expect(put).not.toHaveBeenCalled();
  });
});

describe('parseDonor', () => {
  it.each([
    ['not an object', []],
    ['no name', { ...valid, name: undefined }],
    ['a blank name', { ...valid, name: '   ' }],
    ['a long name', { ...valid, name: 'a'.repeat(41) }],
    ['a long place', { ...valid, place: 'b'.repeat(61) }],
    ['a numeric place', { ...valid, place: 3 }],
    ['an unknown platform', { ...valid, platform: 'web' }],
    ['no transactions', { ...valid, transactionIds: [] }],
    ['too many transactions', { ...valid, transactionIds: Array(21).fill('a') }],
    ['a strange transaction id', { ...valid, transactionIds: ['<script>'] }],
  ])('rejects %s', (_label, body) => {
    expect(typeof parseDonor(body, NOW)).toBe('string');
  });

  it('accepts a missing or blank place', () => {
    expect(parseDonor({ ...valid, place: undefined }, NOW)).toMatchObject({ place: null });
    expect(parseDonor({ ...valid, place: '  ' }, NOW)).toMatchObject({ place: null });
    expect(parseDonor({ ...valid, name: 'a'.repeat(40) }, NOW)).toMatchObject({
      platform: 'android',
    });
  });
});

describe('memoryLimiter', () => {
  it('allows a few submissions per client per window', async () => {
    const allow = memoryLimiter(2, 1000);
    expect(await allow('a', 0)).toBe(true);
    expect(await allow('a', 10)).toBe(true);
    expect(await allow('a', 20)).toBe(false);
    expect(await allow('b', 20)).toBe(true);
    expect(await allow('a', 1500)).toBe(true);
  });
});

/**
 * Cloudflare TURN API answers (src/turn.ts): only well-formed answers reach a phone.
 */
import {
  fetchMonthlyEgress,
  mintCredential,
  monthRange,
  parseMintAnswer,
  parseUsageAnswer,
  revokeCredential,
} from '../src/turn';

const good = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'abc123',
      credential: 'c2VjcmV0+/=',
    },
  ],
};

describe('parseMintAnswer', () => {
  it('accepts the documented shape (array) and the older single-object shape', () => {
    expect(parseMintAnswer(good)?.username).toBe('abc123');
    const single = {
      iceServers: { urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'p' },
    };
    expect(parseMintAnswer(single)).toEqual({
      iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'p' }],
      username: 'u',
    });
  });

  it.each([
    [null],
    ['x'],
    [{}],
    [{ iceServers: [] }],
    [{ iceServers: [{ urls: ['stun:x'] }] }], // no credential at all
    [{ iceServers: [{ urls: ['http://evil.example/'], username: 'u', credential: 'p' }] }],
    [{ iceServers: [{ urls: ['turn:x'], username: 'u/../v', credential: 'p' }] }],
    [{ iceServers: [{ urls: ['turn:x'], username: 'u' }] }],
    [{ iceServers: [{ urls: [], username: 'u', credential: 'p' }] }],
    [{ iceServers: [{ urls: ['turn:x'], username: 'u', credential: 'p'.repeat(600) }] }],
    [{ iceServers: Array.from({ length: 5 }, () => good.iceServers[1]) }],
    [{ iceServers: [null] }],
  ])('refuses %j', (body) => {
    expect(parseMintAnswer(body)).toBeUndefined();
  });
});

describe('parseUsageAnswer', () => {
  const ok = (groups: unknown) => ({
    data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: groups }] } },
  });

  it('sums egress over groups', () => {
    expect(parseUsageAnswer(ok([{ sum: { egressBytes: 5 } }, { sum: { egressBytes: 7 } }]))).toBe(
      12,
    );
    expect(parseUsageAnswer(ok([]))).toBe(0);
  });

  it.each([
    [null],
    [{ errors: [{ message: 'denied' }], data: null }],
    [{ data: { viewer: { accounts: [] } } }],
    [ok('x')],
    [ok([{ sum: { egressBytes: -1 } }])],
    [ok([{ sum: { egressBytes: '5' } }])],
    [ok([null])],
  ])('refuses %j', (body) => {
    expect(parseUsageAnswer(body)).toBeUndefined();
  });
});

describe('API calls fail closed', () => {
  const throwing = async () => {
    throw new Error('network');
  };

  it('mint: bad key id, network error, non-2xx, bad JSON', async () => {
    const ok = async () => Response.json(good, { status: 201 });
    expect(await mintCredential(ok, 'key/../x', 't', 900)).toBeUndefined();
    expect(await mintCredential(throwing, 'k', 't', 900)).toBeUndefined();
    expect(
      await mintCredential(async () => new Response('x', { status: 401 }), 'k', 't', 900),
    ).toBeUndefined();
    expect(
      await mintCredential(async () => new Response('{', { status: 201 }), 'k', 't', 900),
    ).toBeUndefined();
    expect((await mintCredential(ok, 'k', 't', 900))?.username).toBe('abc123');
  });

  it('revoke: bad input or network error is false', async () => {
    expect(await revokeCredential(throwing, 'k', 't', 'u')).toBe(false);
    expect(
      await revokeCredential(async () => new Response(null, { status: 204 }), 'k', 't', 'a/b'),
    ).toBe(false);
    expect(
      await revokeCredential(async () => new Response(null, { status: 204 }), 'k', 't', 'u'),
    ).toBe(true);
  });

  it('usage: bad account, network error, non-200', async () => {
    const acct = '0123456789abcdef0123456789abcdef';
    expect(await fetchMonthlyEgress(throwing, 'nope', 't', 0)).toBeUndefined();
    expect(await fetchMonthlyEgress(throwing, acct, 't', 0)).toBeUndefined();
    expect(
      await fetchMonthlyEgress(async () => new Response('x', { status: 500 }), acct, 't', 0),
    ).toBeUndefined();
  });

  it('monthRange covers the UTC calendar month to date', () => {
    expect(monthRange(Date.UTC(2026, 0, 1, 0, 0, 1))).toEqual({
      dateFrom: '2026-01-01',
      dateTo: '2026-01-01',
    });
    expect(monthRange(Date.UTC(2026, 11, 31, 23, 59))).toEqual({
      dateFrom: '2026-12-01',
      dateTo: '2026-12-31',
    });
  });
});

import { TOKEN_EXPIRY_SKEW_S, isTokenFresh, parseTokenResponse, sanitizeStravaDoc } from './tokens';

describe('isTokenFresh', () => {
  const expiresAtS = 1_000_000; // epoch seconds

  it('is fresh well before expiry', () => {
    expect(isTokenFresh(expiresAtS, (expiresAtS - 3600) * 1000)).toBe(true);
  });

  it('is stale after expiry', () => {
    expect(isTokenFresh(expiresAtS, (expiresAtS + 1) * 1000)).toBe(false);
  });

  it('is stale inside the safety skew window', () => {
    expect(isTokenFresh(expiresAtS, (expiresAtS - TOKEN_EXPIRY_SKEW_S + 1) * 1000)).toBe(false);
  });

  it('is fresh just outside the skew window', () => {
    expect(isTokenFresh(expiresAtS, (expiresAtS - TOKEN_EXPIRY_SKEW_S - 1) * 1000)).toBe(true);
  });

  it('honors a custom skew', () => {
    expect(isTokenFresh(expiresAtS, (expiresAtS - 10) * 1000, 0)).toBe(true);
    expect(isTokenFresh(expiresAtS, (expiresAtS - 10) * 1000, 60)).toBe(false);
  });
});

describe('parseTokenResponse', () => {
  const valid = {
    token_type: 'Bearer',
    access_token: 'acc_1',
    refresh_token: 'ref_1',
    expires_at: 1_700_000_000,
    expires_in: 21600,
  };

  it('parses a refresh response (no athlete)', () => {
    expect(parseTokenResponse(valid)).toEqual({
      tokens: { accessToken: 'acc_1', refreshToken: 'ref_1', expiresAt: 1_700_000_000 },
      athlete: null,
    });
  });

  it('parses the initial exchange with the athlete', () => {
    const parsed = parseTokenResponse({
      ...valid,
      athlete: { id: 42, firstname: 'Jane', lastname: 'Doe' },
    });
    expect(parsed?.athlete).toEqual({ id: 42, name: 'Jane Doe' });
  });

  it('carries the ROTATED refresh token, not the old one', () => {
    const parsed = parseTokenResponse({ ...valid, refresh_token: 'ref_2_rotated' });
    expect(parsed?.tokens.refreshToken).toBe('ref_2_rotated');
  });

  it('tolerates a partial athlete object', () => {
    const parsed = parseTokenResponse({ ...valid, athlete: { firstname: 'Jane' } });
    expect(parsed?.athlete).toEqual({ id: null, name: 'Jane' });
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['missing access_token', { ...valid, access_token: undefined }],
    ['empty access_token', { ...valid, access_token: '' }],
    ['missing refresh_token', { ...valid, refresh_token: undefined }],
    ['non-numeric expires_at', { ...valid, expires_at: 'soon' }],
    ['NaN expires_at', { ...valid, expires_at: Number.NaN }],
  ])('returns null for %s', (_name, input) => {
    expect(parseTokenResponse(input)).toBeNull();
  });
});

describe('sanitizeStravaDoc', () => {
  const connection = {
    accessToken: 'acc',
    refreshToken: 'ref',
    expiresAt: 1_700_000_000,
    athleteId: 42,
    athleteName: 'Jane Doe',
  };

  it('round-trips a valid document', () => {
    expect(sanitizeStravaDoc({ schemaVersion: 1, connection })).toEqual(connection);
  });

  it('defaults missing athlete fields', () => {
    const sanitized = sanitizeStravaDoc({
      schemaVersion: 1,
      connection: { accessToken: 'acc', refreshToken: 'ref', expiresAt: 5 },
    });
    expect(sanitized).toEqual({
      accessToken: 'acc',
      refreshToken: 'ref',
      expiresAt: 5,
      athleteId: null,
      athleteName: '',
    });
  });

  it.each([
    ['null', null],
    ['junk', 'garbage'],
    ['no connection', { schemaVersion: 1 }],
    ['null connection', { schemaVersion: 1, connection: null }],
    ['tokenless connection', { schemaVersion: 1, connection: { athleteName: 'x' } }],
    [
      'non-numeric expiry',
      { schemaVersion: 1, connection: { accessToken: 'a', refreshToken: 'r', expiresAt: 'x' } },
    ],
  ])('returns null (disconnected) for %s', (_name, input) => {
    expect(sanitizeStravaDoc(input)).toBeNull();
  });
});

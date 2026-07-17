import {
  STRAVA_REDIRECT_URI,
  authRedirectOutcome,
  buildAuthorizeUrl,
  buildTokenExchangeBody,
  buildTokenRefreshBody,
  formEncode,
  isStravaAuthRedirect,
  parseRedirectParams,
} from './oauth';

describe('formEncode', () => {
  it('percent-encodes keys and values', () => {
    expect(formEncode({ 'a b': 'c&d', scope: 'activity:write' })).toBe(
      'a%20b=c%26d&scope=activity%3Awrite',
    );
  });
});

describe('buildAuthorizeUrl', () => {
  it('targets the mobile authorize endpoint with the write scope and state', () => {
    const url = buildAuthorizeUrl({ clientId: '123', state: 'nonce9' });
    expect(url.startsWith('https://www.strava.com/oauth/mobile/authorize?')).toBe(true);
    expect(url).toContain('client_id=123');
    expect(url).toContain('response_type=code');
    expect(url).toContain('scope=activity%3Awrite');
    expect(url).toContain('state=nonce9');
    expect(url).toContain(`redirect_uri=${encodeURIComponent(STRAVA_REDIRECT_URI)}`);
  });
});

describe('token bodies', () => {
  it('builds the authorization-code exchange body', () => {
    expect(buildTokenExchangeBody({ clientId: '1', clientSecret: 's', code: 'c' })).toBe(
      'client_id=1&client_secret=s&code=c&grant_type=authorization_code',
    );
  });

  it('builds the refresh body', () => {
    expect(buildTokenRefreshBody({ clientId: '1', clientSecret: 's', refreshToken: 'r' })).toBe(
      'client_id=1&client_secret=s&refresh_token=r&grant_type=refresh_token',
    );
  });
});

describe('isStravaAuthRedirect', () => {
  it('recognizes the redirect in scheme-URL form', () => {
    expect(isStravaAuthRedirect('inukshuk://localhost/strava-auth?code=x')).toBe(true);
  });

  it('recognizes the redirect as a bare router path', () => {
    expect(isStravaAuthRedirect('/strava-auth?code=x')).toBe(true);
  });

  it('rejects other deep links, even with strava-auth in the query', () => {
    expect(isStravaAuthRedirect('inukshuk://localhost/other')).toBe(false);
    expect(isStravaAuthRedirect('content://downloads/123')).toBe(false);
    expect(isStravaAuthRedirect('inukshuk://x?next=strava-auth')).toBe(false);
  });
});

describe('parseRedirectParams', () => {
  it('parses query params', () => {
    expect(parseRedirectParams('app://cb?code=abc&state=s1&scope=read%2Cactivity%3Awrite')).toEqual(
      {
        code: 'abc',
        state: 's1',
        scope: 'read,activity:write',
      },
    );
  });

  it('returns {} without a query', () => {
    expect(parseRedirectParams('app://cb')).toEqual({});
  });

  it('skips malformed pairs and survives bad escapes', () => {
    expect(parseRedirectParams('app://cb?=x&flag&code=%E0%A4%A')).toEqual({ code: '%E0%A4%A' });
  });
});

describe('authRedirectOutcome', () => {
  const url = (query: string) => `inukshuk://localhost/strava-auth?${query}`;

  it('accepts a matching-state grant with the write scope', () => {
    expect(authRedirectOutcome(url('state=s1&code=abc&scope=read,activity:write'), 's1')).toEqual({
      ok: true,
      code: 'abc',
    });
  });

  it('accepts when Strava omits the scope param', () => {
    expect(authRedirectOutcome(url('state=s1&code=abc'), 's1')).toEqual({ ok: true, code: 'abc' });
  });

  it('rejects a denial', () => {
    expect(authRedirectOutcome(url('error=access_denied&state=s1'), 's1')).toEqual({
      ok: false,
      reason: 'denied',
    });
  });

  it('rejects a state mismatch (stale/spoofed redirect)', () => {
    expect(authRedirectOutcome(url('state=other&code=abc'), 's1')).toEqual({
      ok: false,
      reason: 'state-mismatch',
    });
  });

  it('rejects a grant missing activity:write', () => {
    expect(authRedirectOutcome(url('state=s1&code=abc&scope=read'), 's1')).toEqual({
      ok: false,
      reason: 'missing-scope',
    });
  });

  it('rejects a redirect without a code', () => {
    expect(authRedirectOutcome(url('state=s1'), 's1')).toEqual({ ok: false, reason: 'malformed' });
  });
});

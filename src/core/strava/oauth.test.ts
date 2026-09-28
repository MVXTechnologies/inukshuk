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
  it('targets the mobile authorize endpoint with both activity scopes and state', () => {
    const url = buildAuthorizeUrl({ clientId: '123', state: 'nonce9' });
    expect(url.startsWith('https://www.strava.com/oauth/mobile/authorize?')).toBe(true);
    expect(url).toContain('client_id=123');
    expect(url).toContain('response_type=code');
    expect(url).toContain('scope=activity%3Awrite%2Cactivity%3Aread_all');
    expect(url).toContain('state=nonce9');
    expect(url).toContain(`redirect_uri=${encodeURIComponent(STRAVA_REDIRECT_URI)}`);
  });
});

describe('token-proxy bodies', () => {
  it('sends only the code — the proxy adds the client id and secret', () => {
    expect(JSON.parse(buildTokenExchangeBody('c'))).toEqual({ code: 'c' });
  });

  it('sends only the refresh token', () => {
    expect(JSON.parse(buildTokenRefreshBody('r'))).toEqual({ refresh_token: 'r' });
  });

  it('never carries a secret', () => {
    expect(buildTokenExchangeBody('c')).not.toContain('secret');
    expect(buildTokenRefreshBody('r')).not.toContain('secret');
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

  it('accepts a full grant', () => {
    expect(
      authRedirectOutcome(
        url('state=s1&code=abc&scope=read,activity:write,activity:read_all'),
        's1',
      ),
    ).toEqual({ ok: true, code: 'abc', scopes: ['activity:write', 'activity:read_all'] });
  });

  it('accepts a partial grant and reports what it allows', () => {
    expect(authRedirectOutcome(url('state=s1&code=abc&scope=read,activity:write'), 's1')).toEqual({
      ok: true,
      code: 'abc',
      scopes: ['activity:write'],
    });
    expect(
      authRedirectOutcome(url('state=s1&code=abc&scope=read,activity:read_all'), 's1'),
    ).toEqual({ ok: true, code: 'abc', scopes: ['activity:read_all'] });
  });

  it('takes a redirect without the scope param as the full request', () => {
    expect(authRedirectOutcome(url('state=s1&code=abc'), 's1')).toEqual({
      ok: true,
      code: 'abc',
      scopes: ['activity:write', 'activity:read_all'],
    });
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

  it('rejects a grant with neither activity scope', () => {
    expect(authRedirectOutcome(url('state=s1&code=abc&scope=read'), 's1')).toEqual({
      ok: false,
      reason: 'missing-scope',
    });
  });

  it('rejects a redirect without a code', () => {
    expect(authRedirectOutcome(url('state=s1'), 's1')).toEqual({ ok: false, reason: 'malformed' });
  });
});

import { SERVED_DOCUMENT_PREFIXES, lighttpdAccessConfig, servedFileUrl } from './servedPaths';

const origin = 'http://127.0.0.1:41234';

describe('servedFileUrl', () => {
  it('maps a stored maps/ path onto the server origin', () => {
    expect(servedFileUrl(origin, 'maps/abc123.pdf')).toBe(`${origin}/maps/abc123.pdf`);
    expect(servedFileUrl(`${origin}/`, 'offline-styles/r1.json')).toBe(
      `${origin}/offline-styles/r1.json`,
    );
    expect(servedFileUrl(origin, '.rasterizer/index.html')).toBe(
      `${origin}/.rasterizer/index.html`,
    );
  });

  it('percent-encodes each segment', () => {
    expect(servedFileUrl(origin, 'maps/Trail #4 (2024).pdf')).toBe(
      `${origin}/maps/Trail%20%234%20(2024).pdf`,
    );
  });

  // Anything absolute is not under the server root: a content:// picker uri,
  // a cache file, or a path the #247 migration left alone. Those keep the
  // in-memory path; they must never be turned into a bogus loopback URL.
  it('refuses absolute paths and uris', () => {
    expect(servedFileUrl(origin, 'file:///data/user/0/app/files/maps/a.pdf')).toBeNull();
    expect(servedFileUrl(origin, 'content://downloads/1')).toBeNull();
    expect(servedFileUrl(origin, '/maps/a.pdf')).toBeNull();
    expect(servedFileUrl(origin, '')).toBeNull();
  });

  it('refuses paths outside the allowlist and traversal attempts', () => {
    expect(servedFileUrl(origin, 'library.json')).toBeNull();
    expect(servedFileUrl(origin, 'tracks/t1.gpx')).toBeNull();
    expect(servedFileUrl(origin, 'maps/../library.json')).toBeNull();
    expect(servedFileUrl(origin, 'maps')).toBeNull();
  });
});

describe('lighttpdAccessConfig', () => {
  it('denies everything outside the served prefixes, without backslashes', () => {
    const config = lighttpdAccessConfig(SERVED_DOCUMENT_PREFIXES);
    expect(config).toBe(
      '$HTTP["url"] !~ "^/(maps|offline-styles|[.]rasterizer)/" {\n  url.access-deny = ( "" )\n}',
    );
    expect(config).not.toContain('\\');
  });

  it('the generated pattern admits exactly the allowlisted folders', () => {
    const config = lighttpdAccessConfig(SERVED_DOCUMENT_PREFIXES);
    const pattern = new RegExp(/!~ "(.*)" \{/.exec(config)?.[1] ?? 'no-match');
    expect(pattern.test('/maps/a.pdf')).toBe(true);
    expect(pattern.test('/.rasterizer/index.html')).toBe(true);
    expect(pattern.test('/offline-styles/r1.json')).toBe(true);
    expect(pattern.test('/library.json')).toBe(false);
    expect(pattern.test('/tracks/t.gpx')).toBe(false);
    expect(pattern.test('/xrasterizer/index.html')).toBe(false);
  });
});

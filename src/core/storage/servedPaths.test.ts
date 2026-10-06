import {
  SERVED_DOCUMENT_PREFIXES,
  isServerSecret,
  lighttpdAccessConfig,
  servedBase,
  servedFileUrl,
} from './servedPaths';

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

const secret = '0f8e2c1a-5b7d-4e9f-a3c6-1d2b4f6a8c0e';

describe('isServerSecret / servedBase', () => {
  it('accepts a v4 UUID and rejects short or unsafe secrets', () => {
    expect(isServerSecret(secret)).toBe(true);
    expect(isServerSecret('')).toBe(false);
    expect(isServerSecret('abc123')).toBe(false);
    expect(isServerSecret(`${secret}"`)).toBe(false);
    expect(isServerSecret(`${secret}/x`)).toBe(false);
    expect(isServerSecret('a'.repeat(65))).toBe(false);
  });

  it('puts the secret first in every served URL', () => {
    const base = servedBase(`${origin}/`, secret);
    expect(base).toBe(`${origin}/${secret}`);
    expect(servedFileUrl(base, 'maps/a.pdf')).toBe(`${origin}/${secret}/maps/a.pdf`);
  });

  it('refuses an invalid secret instead of serving without one', () => {
    expect(() => servedBase(origin, 'short')).toThrow('invalid loopback server secret');
  });
});

describe('lighttpdAccessConfig', () => {
  it('aliases /<secret>/ to the document root and denies everything else', () => {
    const config = lighttpdAccessConfig(SERVED_DOCUMENT_PREFIXES, secret, '/data/files');
    expect(config).toBe(
      'server.modules += ( "mod_access", "mod_alias" )\n' +
        `alias.url = ( "/${secret}/" => "/data/files/" )\n` +
        `$HTTP["url"] !~ "^/${secret}/(maps|offline-styles|[.]rasterizer|[.]photo-inbox)/" {\n` +
        '  url.access-deny = ( "" )\n}',
    );
    expect(config).not.toContain('\\');
  });

  it('escapes quotes and backslashes in the document root', () => {
    const config = lighttpdAccessConfig(['maps'], secret, '/odd "dir"\\x/');
    expect(config).toContain('=> "/odd \\"dir\\"\\\\x/" )');
  });

  it('refuses an invalid secret', () => {
    expect(() => lighttpdAccessConfig(SERVED_DOCUMENT_PREFIXES, 'nope', '/doc/')).toThrow(
      'invalid loopback server secret',
    );
  });

  it('the generated pattern admits exactly the allowlisted folders under the secret', () => {
    const config = lighttpdAccessConfig(SERVED_DOCUMENT_PREFIXES, secret, '/doc/');
    const pattern = new RegExp(/!~ "(.*)" \{/.exec(config)?.[1] ?? 'no-match');
    expect(pattern.test(`/${secret}/maps/a.pdf`)).toBe(true);
    expect(pattern.test(`/${secret}/.rasterizer/index.html`)).toBe(true);
    expect(pattern.test(`/${secret}/offline-styles/r1.json`)).toBe(true);
    // Without the secret, nothing — not even an allowlisted folder.
    expect(pattern.test('/maps/a.pdf')).toBe(false);
    expect(pattern.test('/.rasterizer/index.html')).toBe(false);
    expect(pattern.test(`/x${secret}/maps/a.pdf`)).toBe(false);
    expect(pattern.test(`/${secret}/library.json`)).toBe(false);
    expect(pattern.test(`/${secret}/tracks/t.gpx`)).toBe(false);
    expect(pattern.test(`/${secret}/xrasterizer/index.html`)).toBe(false);
    expect(pattern.test(`/${secret}/.photo-inbox/j1.jpg`)).toBe(true);
    expect(pattern.test('/.photo-inbox/j1.jpg')).toBe(false);
    // The kept photo copies (and their EXIF-free data) are never served.
    expect(pattern.test(`/${secret}/photos/t1/p1.jpg`)).toBe(false);
    expect(pattern.test(`/${secret}/photos/p1.jpg`)).toBe(false);
  });
});

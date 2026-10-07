import {
  aliasTileUrl,
  parseUrlTemplates,
  staleTemplateKeys,
  styleUrlTemplates,
  tileHostAlias,
  TILE_HOST_ALIAS_ID,
} from './tileUrls';

const HOST = 'https://tiles.old.example';

describe('styleUrlTemplates', () => {
  const style = {
    version: 8,
    glyphs: `${HOST}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${HOST}/sprite`,
    sources: {
      base: { type: 'vector', tiles: [`${HOST}/basemap/{z}/{x}/{y}.mvt`] },
      twin: {
        type: 'raster',
        tiles: ['https://a.example/{z}/{x}/{y}', 'https://b.example/{z}/{x}/{y}'],
      },
      tilejson: { type: 'vector', url: `${HOST}/planet.json` },
      remote: { type: 'geojson', data: `${HOST}/labels.json` },
      inline: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      relative: { type: 'vector', tiles: ['/local/{z}/{x}/{y}.mvt'] },
      broken: 'nope',
    },
    layers: [],
  };

  it('keys every source, the glyphs and the sprite by where the style uses them', () => {
    expect(styleUrlTemplates(style)).toEqual({
      glyphs: `${HOST}/fonts/{fontstack}/{range}.pbf`,
      sprite: `${HOST}/sprite`,
      'source:base': `${HOST}/basemap/{z}/{x}/{y}.mvt`,
      'source:twin': 'https://a.example/{z}/{x}/{y} https://b.example/{z}/{x}/{y}',
      'source:tilejson': `${HOST}/planet.json`,
      'source:remote': `${HOST}/labels.json`,
    });
  });

  it('reads the serialized style the same as the object', () => {
    expect(styleUrlTemplates(JSON.stringify(style))).toEqual(styleUrlTemplates(style));
  });

  it('reads a multi-sprite list', () => {
    expect(
      styleUrlTemplates({
        sprite: [{ id: 'a', url: `${HOST}/a` }, { id: 'b', url: `${HOST}/b` }, { id: 'c' }],
      }),
    ).toEqual({ sprite: `${HOST}/a ${HOST}/b` });
  });

  it('yields nothing for something that is not a style', () => {
    expect(styleUrlTemplates('{not json')).toEqual({});
    expect(styleUrlTemplates(null)).toEqual({});
    expect(styleUrlTemplates([1, 2])).toEqual({});
    expect(styleUrlTemplates({ sources: [] })).toEqual({});
    expect(styleUrlTemplates({ sprite: [], glyphs: 42 })).toEqual({});
  });
});

describe('staleTemplateKeys', () => {
  it('names the keys both sides have with different templates, sorted', () => {
    expect(
      staleTemplateKeys(
        { 'source:z': 'a?v=1', 'source:a': 'b?v=1', glyphs: 'g', gone: 'x' },
        { 'source:z': 'a?v=2', 'source:a': 'b?v=2', glyphs: 'g', added: 'y' },
      ),
    ).toEqual(['source:a', 'source:z']);
  });

  it('is empty when nothing moved', () => {
    expect(staleTemplateKeys({ glyphs: 'g' }, { glyphs: 'g' })).toEqual([]);
    expect(staleTemplateKeys({}, { glyphs: 'g' })).toEqual([]);
  });
});

describe('parseUrlTemplates', () => {
  it('accepts a string map and rejects anything else', () => {
    expect(parseUrlTemplates({ glyphs: 'g' })).toEqual({ glyphs: 'g' });
    expect(parseUrlTemplates({})).toEqual({});
    expect(parseUrlTemplates({ glyphs: 3 })).toBeNull();
    expect(parseUrlTemplates(['g'])).toBeNull();
    expect(parseUrlTemplates(undefined)).toBeNull();
  });
});

describe('tileHostAlias', () => {
  it('is null while the host has not moved (trailing slashes aside)', () => {
    expect(tileHostAlias(HOST, HOST)).toBeNull();
    expect(tileHostAlias(`${HOST}/`, HOST)).toBeNull();
  });

  it('rewrites the key host to the serving host, and only that host', () => {
    const alias = tileHostAlias(HOST, 'https://tiles.new.example/');
    expect(alias).not.toBeNull();
    if (alias === null) return;
    expect(alias.id).toBe(TILE_HOST_ALIAS_ID);
    expect(alias.replace).toBe('https://tiles.new.example');
    const match = new RegExp(alias.match);
    const rewrite = (url: string) =>
      match.test(url) ? url.replace(new RegExp(alias.find), alias.replace) : url;
    expect(rewrite(`${HOST}/contours/1/2/3.mvt?v=2`)).toBe(
      'https://tiles.new.example/contours/1/2/3.mvt?v=2',
    );
    expect(rewrite(`${HOST}?x=1`)).toBe('https://tiles.new.example?x=1');
    expect(rewrite(HOST)).toBe('https://tiles.new.example');
    // A longer host with the same prefix, or the host elsewhere in a URL, is left alone.
    expect(rewrite(`${HOST}.evil/a`)).toBe(`${HOST}.evil/a`);
    expect(rewrite(`https://x.example/?u=${HOST}/a`)).toBe(`https://x.example/?u=${HOST}/a`);
    // Regex metacharacters in the host are literal.
    expect(rewrite('https://tilesXold.example/a')).toBe('https://tilesXold.example/a');
  });
});

describe('aliasTileUrl', () => {
  it('applies the same rewrite to a plain URL', () => {
    expect(aliasTileUrl(`${HOST}/route`, HOST, 'https://n.example')).toBe(
      'https://n.example/route',
    );
    expect(aliasTileUrl(`${HOST}/route`, HOST, HOST)).toBe(`${HOST}/route`);
    expect(aliasTileUrl('https://other.example/a', HOST, 'https://n.example')).toBe(
      'https://other.example/a',
    );
  });
});

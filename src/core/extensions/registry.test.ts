import { STONE_FONTS_ATKINSON } from '@core/map/stoneStyle';

import { ALL_EXTENSION_KEYS, DEVICE_EXTENSION_KEYS, EXTENSION_KEYS, isExtensionKey } from './keys';
import {
  companionExtensions,
  DEVICE_EXTENSIONS,
  extensionBasics,
  extensionDescriptor,
  EXTENSIONS,
} from './registry';

const TILES = 'https://tiles.example/{z}/{x}/{y}.mvt';

describe('the extension registry', () => {
  it('has one descriptor per key, in draw order', () => {
    expect(Object.keys(EXTENSIONS)).toEqual([...EXTENSION_KEYS]);
    expect(EXTENSION_KEYS).toEqual(['geodetic', 'tides']);
    for (const key of EXTENSION_KEYS) expect(extensionDescriptor(key)).toBe(EXTENSIONS[key]);
  });

  it('names, sources and settings keys never collide', () => {
    const all = EXTENSION_KEYS.map((k) => EXTENSIONS[k]);
    const unique = (xs: readonly string[]) => expect(new Set(xs).size).toBe(xs.length);
    unique(all.map((d) => d.label));
    unique(all.map((d) => d.teaser));
    unique(all.map((d) => d.map.sourceId));
    unique(
      all.flatMap((d) => (d.legacySettings ? Object.values(d.legacySettings) : [])) as string[],
    );
  });

  it("every descriptor's style block is self-contained: its layers name only its sources", () => {
    for (const key of EXTENSION_KEYS) {
      const block = extensionDescriptor(key).map.build(
        { tiles: TILES, dark: false },
        { theme: 'light', font: STONE_FONTS_ATKINSON.regular },
      );
      expect(block.sources[EXTENSIONS[key].map.sourceId]).toMatchObject({
        type: 'vector',
        tiles: [TILES],
      });
      expect(block.layers.length).toBeGreaterThan(0);
      for (const layer of block.layers) {
        if ('source' in layer) expect(Object.keys(block.sources)).toContain(layer.source);
      }
    }
  });

  it('tides add the CHS live source and its layers only when given stations', () => {
    const ctx = { theme: 'dark' as const, font: STONE_FONTS_ATKINSON.regular };
    const plain = EXTENSIONS.tides.map.build({ tiles: TILES, dark: true }, ctx);
    const chs = EXTENSIONS.tides.map.build(
      { tiles: TILES, dark: true, chs: { type: 'FeatureCollection', features: [] } },
      ctx,
    );
    expect(Object.keys(plain.sources)).toEqual(['tides']);
    expect(Object.keys(chs.sources)).toEqual(['tides', 'tides-chs']);
    expect(chs.layers.length).toBeGreaterThan(plain.layers.length);
  });

  it('geodetic applies the user filter (no OSM points: their layers go)', () => {
    const ctx = { theme: 'light' as const, font: STONE_FONTS_ATKINSON.regular };
    const plain = EXTENSIONS.geodetic.map.build({ tiles: TILES, dark: false }, ctx);
    const hidden = EXTENSIONS.geodetic.map.build(
      { tiles: TILES, dark: false, filters: { official: null, osm: 'hidden' } },
      ctx,
    );
    expect(hidden.layers.length).toBeLessThan(plain.layers.length);
  });

  it('only geodetic has companion packs; tides always ride in packs once installed', () => {
    expect(companionExtensions()).toEqual(['geodetic']);
    expect(EXTENSIONS.geodetic.offline.packs).toBe('opt-in');
    expect(EXTENSIONS.tides.offline.packs).toBe('installed');
  });

  it('isExtensionKey', () => {
    expect(isExtensionKey('geodetic')).toBe(true);
    expect(isExtensionKey('climbing')).toBe(false);
    expect(isExtensionKey(3)).toBe(false);
  });
});

describe('device extensions (#588)', () => {
  it('are listed after the map ones, never in the map registry, with their own basics', () => {
    expect(DEVICE_EXTENSION_KEYS).toEqual(['gnss']);
    expect(ALL_EXTENSION_KEYS).toEqual(['geodetic', 'tides', 'gnss']);
    expect(Object.keys(DEVICE_EXTENSIONS)).toEqual([...DEVICE_EXTENSION_KEYS]);
    expect(isExtensionKey('gnss')).toBe(false);
    expect(extensionBasics('gnss')).toBe(DEVICE_EXTENSIONS.gnss);
    expect(extensionBasics('tides')).toBe(EXTENSIONS.tides);
    const labels = ALL_EXTENSION_KEYS.map((k) => extensionBasics(k).label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(extensionBasics('gnss').legacySettings).toBeUndefined();
  });
});

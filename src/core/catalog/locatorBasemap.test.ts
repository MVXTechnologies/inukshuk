import { buildLocatorScene, type LocatorRing } from './locator';
import { LOCATOR_BASEMAP } from './locatorBasemap';

/**
 * Sanity checks over the GENERATED basemap (see build-locator-basemap.ts):
 * the data is committed, so a bad regeneration should fail loudly here, not
 * as blank thumbnails on device.
 */

const allRings: LocatorRing[] = [
  ...LOCATOR_BASEMAP.land,
  ...LOCATOR_BASEMAP.lakes,
  ...LOCATOR_BASEMAP.borders,
];

describe('LOCATOR_BASEMAP', () => {
  it('has land, lakes and borders', () => {
    expect(LOCATOR_BASEMAP.land.length).toBeGreaterThan(20);
    expect(LOCATOR_BASEMAP.lakes.length).toBeGreaterThan(10);
    expect(LOCATOR_BASEMAP.borders.length).toBeGreaterThan(10);
  });

  it('every ring has even-length coordinates matching its bounds', () => {
    for (const ring of allRings) {
      expect(ring.p.length % 2).toBe(0);
      expect(ring.p.length).toBeGreaterThanOrEqual(4);
      const [w, s, e, n] = ring.b;
      expect(w).toBeLessThanOrEqual(e);
      expect(s).toBeLessThanOrEqual(n);
      for (let i = 0; i + 1 < ring.p.length; i += 2) {
        const lon = ring.p[i]!;
        const lat = ring.p[i + 1]!;
        expect(lon).toBeGreaterThanOrEqual(w);
        expect(lon).toBeLessThanOrEqual(e);
        expect(lat).toBeGreaterThanOrEqual(s);
        expect(lat).toBeLessThanOrEqual(n);
      }
    }
  });

  it('covers the CanTopo coverage window', () => {
    // Coordinates stay in the western hemisphere (rings are only cropped by
    // intersection, so a kept landmass may extend past the window itself)…
    for (const ring of allRings) {
      expect(ring.b[0]).toBeGreaterThanOrEqual(-180);
      expect(ring.b[2]).toBeLessThanOrEqual(0);
      expect(ring.b[3]).toBeLessThanOrEqual(85);
    }
    // …and known sheets across the country get non-empty scenes.
    const quebec = buildLocatorScene([-71.5, 46.75, -71, 47], LOCATOR_BASEMAP, 100);
    expect(quebec.land.length).toBeGreaterThan(0);
    const novaScotia = buildLocatorScene([-65, 44.25, -64.5, 44.5], LOCATOR_BASEMAP, 100);
    expect(novaScotia.land.length).toBeGreaterThan(0);
    const yukon = buildLocatorScene([-135.1, 60.6, -134.6, 60.85], LOCATOR_BASEMAP, 100);
    expect(yukon.land.length).toBeGreaterThan(0);
  });
});

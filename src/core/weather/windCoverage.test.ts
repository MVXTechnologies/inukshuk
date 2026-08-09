import {
  needsReanchor,
  PARTICLES_MAX_VIEW_SPAN_DEG,
  wcsCoverageUrl,
  WIND_COVERAGES,
  windFetchBbox,
  windFieldCacheKey,
  type WindBbox,
} from './windCoverage';
import { WEATHER_MODEL_IDS } from './weatherModels';

const view: WindBbox = { west: -72, south: 46, east: -70, north: 48 };

describe('WIND_COVERAGES', () => {
  it('covers every model in the catalog with speed+dir+gust ids', () => {
    for (const id of WEATHER_MODEL_IDS) {
      const c = WIND_COVERAGES[id];
      expect(c.speed).toBeTruthy();
      expect(c.dir).toBeTruthy();
      expect(c.gust).toBeTruthy();
    }
    // The ids verified live 2026-08-09 — a rename here must be re-verified.
    expect(WIND_COVERAGES.hrdps.speed).toBe('HRDPS.CONTINENTAL_WSPD');
    expect(WIND_COVERAGES.hrdps.dir).toBe('HRDPS.CONTINENTAL_WD');
    expect(WIND_COVERAGES.hrdps.gust).toBe('HRDPS-WEonG_2.5km_WindGust');
    expect(WIND_COVERAGES.rdps.speed).toBe('RDPS_10km_WindSpeed_10m');
    expect(WIND_COVERAGES.gdps.gust).toBe('GDPS_15km_WindGust_10m');
  });
});

describe('wcsCoverageUrl', () => {
  it('builds the verified GetCoverage shape', () => {
    const url = wcsCoverageUrl('HRDPS.CONTINENTAL_WSPD', view, '2026-08-09T12:00:00Z');
    expect(url).toContain('service=WCS');
    expect(url).toContain('version=2.0.1');
    expect(url).toContain('request=GetCoverage');
    expect(url).toContain('coverageid=HRDPS.CONTINENTAL_WSPD');
    expect(url).toContain('subset=lat(46,48)');
    expect(url).toContain('subset=long(-72,-70)');
    expect(url).toContain('format=image/tiff');
    expect(url).toContain('TIME=2026-08-09T12%3A00%3A00Z');
  });

  it('omits TIME for the server-latest frame', () => {
    expect(wcsCoverageUrl('X', view)).not.toContain('TIME=');
  });
});

describe('windFetchBbox', () => {
  it('pads ~1.5× and quantizes to a cache-friendly grid', () => {
    const bbox = windFetchBbox(view);
    expect(bbox).not.toBeNull();
    const b = bbox as WindBbox;
    // Padded beyond the viewport on every side…
    expect(b.west).toBeLessThanOrEqual(-72.5);
    expect(b.east).toBeGreaterThanOrEqual(-69.5);
    expect(b.south).toBeLessThanOrEqual(46);
    expect(b.north).toBeGreaterThanOrEqual(48);
    // …and on the 0.25° quantization grid.
    for (const v of [b.west, b.south, b.east, b.north]) {
      expect(Math.abs(v / 0.25 - Math.round(v / 0.25))).toBeLessThan(1e-9);
    }
  });

  it('shares one bbox across nearby viewports (cache stability)', () => {
    const a = windFetchBbox(view);
    const b = windFetchBbox({ west: -72.01, south: 46.02, east: -70.01, north: 48.02 });
    expect(a).toEqual(b);
  });

  it('refuses continental viewports (particles stay off, gradient only)', () => {
    expect(
      windFetchBbox({
        west: -100,
        south: 30,
        east: -100 + PARTICLES_MAX_VIEW_SPAN_DEG + 1,
        north: 60,
      }),
    ).toBeNull();
  });

  it('enforces a minimum span for degenerate zoom-ins', () => {
    const b = windFetchBbox({ west: -71.01, south: 46.99, east: -70.99, north: 47.01 });
    expect(b).not.toBeNull();
    expect((b?.east ?? 0) - (b?.west ?? 0)).toBeGreaterThanOrEqual(0.5);
  });

  it('clamps to the mercator-safe latitude band', () => {
    const b = windFetchBbox({ west: -70, south: 82, east: -68, north: 84.5 });
    expect(b?.north).toBeLessThanOrEqual(84);
  });

  it('rejects junk viewports', () => {
    expect(windFetchBbox({ west: -70, south: 48, east: -72, north: 46 })).toBeNull();
    expect(windFetchBbox({ west: -179.9, south: 46, east: -178, north: 48 })).not.toBeNull();
    expect(windFetchBbox({ west: 179, south: 46, east: 181, north: 48 })).toBeNull();
  });
});

describe('needsReanchor', () => {
  const anchor = windFetchBbox(view) as WindBbox;

  it('stays anchored while the viewport sits inside the padding', () => {
    expect(needsReanchor(anchor, view)).toBe(false);
    expect(needsReanchor(anchor, { west: -72.2, south: 46, east: -70.2, north: 48 })).toBe(false);
  });

  it('re-anchors when the viewport escapes the bbox', () => {
    expect(needsReanchor(anchor, { west: -75, south: 46, east: -73, north: 48 })).toBe(true);
    expect(needsReanchor(anchor, { west: -72, south: 49, east: -70, north: 51 })).toBe(true);
  });

  it('re-anchors after a deep zoom-in (finer grid is worth a refetch)', () => {
    expect(needsReanchor(anchor, { west: -71.1, south: 46.9, east: -70.9, north: 47.1 })).toBe(
      true,
    );
  });
});

describe('windFieldCacheKey', () => {
  it('distinguishes model, bbox and time; treats undefined time as latest', () => {
    const a = windFieldCacheKey('hrdps', view, '2026-08-09T12:00:00Z');
    expect(a).toContain('hrdps');
    expect(a).not.toBe(windFieldCacheKey('rdps', view, '2026-08-09T12:00:00Z'));
    expect(a).not.toBe(windFieldCacheKey('hrdps', view, '2026-08-09T13:00:00Z'));
    expect(a).not.toBe(windFieldCacheKey('hrdps', { ...view, east: -69 }, '2026-08-09T12:00:00Z'));
    expect(windFieldCacheKey('hrdps', view, undefined)).toContain('latest');
  });
});

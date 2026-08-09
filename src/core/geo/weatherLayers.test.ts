import {
  ECCC_ATTRIBUTION,
  formatWmsTime,
  getFeatureInfoUrl,
  getFeatureInfoUrlForLayer,
  isWeatherLayerId,
  parseFeatureInfo,
  parseIsoDuration,
  parseReferenceTimeDefault,
  parseTimeDimension,
  parseTimeDimensionList,
  sanitizeWeatherLayer,
  toWebMercator,
  WEATHER_LAYERS,
  weatherCapabilitiesUrl,
  weatherLayerById,
  weatherTileUrl,
} from './weatherLayers';

// A trimmed GetCapabilities excerpt captured from GeoMet (RADAR_1KM_RRAI,
// 2026-08-08): the time dimension is a single start/end/period interval.
const CAPS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0">
  <Capability>
    <Layer queryable="1">
      <Name>RADAR_1KM_RRAI</Name>
      <Dimension name="reference_time" units="ISO8601" default="2026-08-08T21:00:00Z">2026-08-08T18:00:00Z/2026-08-08T21:00:00Z/PT6M</Dimension>
      <Dimension name="time" units="ISO8601" default="2026-08-08T21:00:00Z" nearestValue="0">2026-08-08T18:00:00Z/2026-08-08T21:00:00Z/PT6M</Dimension>
    </Layer>
  </Capability>
</WMS_Capabilities>`;

describe('weather layer catalog', () => {
  it('exposes the five GeoMet layers with regex-safe labels', () => {
    expect(WEATHER_LAYERS.map((l) => l.id)).toEqual([
      'radar-rain',
      'radar-snow',
      'temp',
      'wind',
      'precip',
    ]);
    // Labels are Maestro/a11y match targets — no regex metacharacters allowed.
    for (const l of WEATHER_LAYERS) expect(l.label).not.toMatch(/[.*+?^${}()|[\]\\]/);
  });

  it('marks radar layers past-scrubbing and HRDPS model layers forecast-scrubbing', () => {
    expect(WEATHER_LAYERS.filter((l) => l.timeline === 'past').map((l) => l.id)).toEqual([
      'radar-rain',
      'radar-snow',
    ]);
    expect(WEATHER_LAYERS.filter((l) => l.timeline === 'forecast').map((l) => l.id)).toEqual([
      'temp',
      'wind',
      'precip',
    ]);
  });

  it('serves the HRDPS 2 m temperature layer (verified live 2026-08-09)', () => {
    expect(weatherLayerById('temp').wmsLayer).toBe('HRDPS.CONTINENTAL_TT');
  });

  it('gives every layer a legend-style thumbnail swatch of valid hex colours', () => {
    for (const l of WEATHER_LAYERS) {
      expect(l.swatch.length).toBeGreaterThanOrEqual(3);
      for (const c of l.swatch) expect(c).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('gives every layer a value legend (unit + evenly spaced labels)', () => {
    for (const l of WEATHER_LAYERS) {
      expect(l.legend.unit.length).toBeGreaterThan(0);
      expect(l.legend.labels.length).toBeGreaterThanOrEqual(3);
      for (const label of l.legend.labels) expect(label.length).toBeGreaterThan(0);
    }
  });

  it('type-guards ids and sanitizes persisted junk to null', () => {
    expect(isWeatherLayerId('radar-rain')).toBe(true);
    expect(isWeatherLayerId('RADAR_1KM_RRAI')).toBe(false);
    expect(sanitizeWeatherLayer('wind')).toBe('wind');
    expect(sanitizeWeatherLayer('nonsense')).toBeNull();
    expect(sanitizeWeatherLayer(null)).toBeNull();
    expect(sanitizeWeatherLayer({ id: 'radar-rain' })).toBeNull(); // object junk (typeof null trap)
    expect(sanitizeWeatherLayer(42)).toBeNull();
  });

  it('looks layers up by id', () => {
    expect(weatherLayerById('precip').wmsLayer).toBe('HRDPS.CONTINENTAL_PR');
  });

  it('carries the ECCC credit line the licence requires', () => {
    expect(ECCC_ATTRIBUTION).toContain('Environment and Climate Change Canada');
  });
});

describe('weatherTileUrl', () => {
  it('builds a MapLibre-templatable GetMap URL for the latest frame', () => {
    const url = weatherTileUrl('radar-rain');
    expect(url).toContain('https://geo.weather.gc.ca/geomet?');
    expect(url).toContain('request=GetMap');
    expect(url).toContain('layers=RADAR_1KM_RRAI');
    expect(url).toContain('crs=EPSG:3857');
    expect(url).toContain('bbox={bbox-epsg-3857}'); // must stay un-encoded for MapLibre
    expect(url).toContain('width=256');
    expect(url).toContain('height=256');
    expect(url).toContain('transparent=true');
    expect(url).not.toContain('time='); // no TIME = GeoMet serves the latest frame
  });

  it('pins an animation frame via an encoded TIME parameter', () => {
    const url = weatherTileUrl('radar-rain', '2026-08-08T20:54:00Z');
    expect(url).toContain('time=2026-08-08T20%3A54%3A00Z');
  });

  it('encodes the HRDPS layer names (dots survive, safe chars only)', () => {
    expect(weatherTileUrl('wind')).toContain('layers=HRDPS.CONTINENTAL_UU');
  });
});

describe('parseIsoDuration', () => {
  it.each([
    ['PT6M', 360_000],
    ['PT1H', 3_600_000],
    ['PT30S', 30_000],
    ['P1D', 86_400_000],
    ['P1DT2H30M', 95_400_000],
  ])('parses %s', (input, ms) => {
    expect(parseIsoDuration(input)).toBe(ms);
  });

  it('rejects junk and zero durations', () => {
    expect(parseIsoDuration('6 minutes')).toBeNull();
    expect(parseIsoDuration('P')).toBeNull();
    expect(parseIsoDuration('PT0M')).toBeNull();
    expect(parseIsoDuration('')).toBeNull();
  });
});

describe('parseTimeDimension', () => {
  it('reads the time dimension from a real capabilities excerpt', () => {
    const dim = parseTimeDimension(CAPS_XML);
    expect(dim).toEqual({
      startMs: Date.parse('2026-08-08T18:00:00Z'),
      endMs: Date.parse('2026-08-08T21:00:00Z'),
      stepMs: 360_000,
      defaultTime: '2026-08-08T21:00:00Z',
    });
  });

  it('skips non-time dimensions (reference_time comes first in the document)', () => {
    // If the parser grabbed the first <Dimension> blindly, this would still
    // pass shape-wise — assert it picked the one AFTER reference_time by
    // giving them different intervals.
    const xml = CAPS_XML.replace(
      '2026-08-08T18:00:00Z/2026-08-08T21:00:00Z/PT6M</Dimension>\n      <Dimension name="time"',
      '2020-01-01T00:00:00Z/2020-01-01T06:00:00Z/PT1H</Dimension>\n      <Dimension name="time"',
    );
    expect(parseTimeDimension(xml)?.stepMs).toBe(360_000);
  });

  it('uses the last interval when several are listed', () => {
    const xml =
      '<Dimension name="time" units="ISO8601">' +
      '2026-08-07T00:00:00Z/2026-08-07T12:00:00Z/PT1H,' +
      '2026-08-08T18:00:00Z/2026-08-08T21:00:00Z/PT6M</Dimension>';
    expect(parseTimeDimension(xml)).toMatchObject({
      endMs: Date.parse('2026-08-08T21:00:00Z'),
      stepMs: 360_000,
      defaultTime: null,
    });
  });

  it.each([
    ['no dimension at all', '<WMS_Capabilities></WMS_Capabilities>'],
    [
      'a single timestamp instead of an interval',
      '<Dimension name="time">2026-08-08T21:00:00Z</Dimension>',
    ],
    ['an unparseable date', '<Dimension name="time">junk/2026-08-08T21:00:00Z/PT6M</Dimension>'],
    [
      'a bad period',
      '<Dimension name="time">2026-08-08T18:00:00Z/2026-08-08T21:00:00Z/6min</Dimension>',
    ],
    [
      'end before start',
      '<Dimension name="time">2026-08-08T21:00:00Z/2026-08-08T18:00:00Z/PT6M</Dimension>',
    ],
  ])('returns null on %s (caller degrades to static)', (_name, xml) => {
    expect(parseTimeDimension(xml)).toBeNull();
  });
});

describe('formatWmsTime', () => {
  it('formats frames the way GeoMet TIME expects (no milliseconds)', () => {
    expect(formatWmsTime(Date.parse('2026-08-08T20:54:00Z'))).toBe('2026-08-08T20:54:00Z');
  });
});

describe('GetFeatureInfo', () => {
  it('projects to web mercator (reference anchors)', () => {
    const origin = toWebMercator({ latitude: 0, longitude: 0 });
    expect(origin.x).toBe(0);
    expect(origin.y).toBeCloseTo(0, 6);
    // The EPSG:3857 world half-width and the canonical y at 45°N.
    expect(toWebMercator({ latitude: 0, longitude: 180 }).x).toBeCloseTo(20037508.34, 2);
    expect(toWebMercator({ latitude: 45, longitude: 0 }).y).toBeCloseTo(5621521.49, 1);
  });

  it('builds a centred JSON query window', () => {
    const url = getFeatureInfoUrl('wind', { latitude: 46.8139, longitude: -71.208 });
    expect(url).toContain('request=GetFeatureInfo');
    expect(url).toContain('query_layers=HRDPS.CONTINENTAL_UU');
    expect(url).toContain('i=50');
    expect(url).toContain('j=50');
    expect(url).toContain('width=101');
    expect(url).toContain('info_format=application/json');
    const bbox = /bbox=([-\d.,]+)/.exec(url)?.[1]?.split(',').map(Number) ?? [];
    expect(bbox).toHaveLength(4);
    const [minX, minY, maxX, maxY] = bbox as [number, number, number, number];
    expect(maxX - minX).toBeCloseTo(20_000, 0);
    expect(maxY - minY).toBeCloseTo(20_000, 0);
  });

  it('parses a real-shaped response and strips the layer prefix from the title', () => {
    // Captured shape from GeoMet (HRDPS.CONTINENTAL_TT, 2026-08-08).
    const json = {
      type: 'FeatureCollection',
      layer: 'HRDPS.CONTINENTAL_TT',
      features: [
        {
          type: 'Feature',
          id: 'HRDPS.CONTINENTAL_TT(-7953753.8,5931108.8)',
          geometry: { type: 'Point', coordinates: [-71.4498, 46.9328] },
          properties: {
            value: 25.327021,
            class: '25 30',
            title_en: 'HRDPS.CONTINENTAL - Air temperature at 2m above ground [°C]',
            title_fr: "HRDPS.CONTINENTAL - Température de l'air à 2m au dessus de la surface [°C]",
            time: '2026-08-08T21:00:00Z',
            dim_reference_time: '2026-08-08T12:00:00Z',
          },
        },
      ],
    };
    expect(parseFeatureInfo(json)).toEqual({
      value: 25.327021,
      label: 'Air temperature at 2m above ground [°C]',
      time: '2026-08-08T21:00:00Z',
      referenceTime: '2026-08-08T12:00:00Z',
    });
  });

  it('tolerates missing optional fields', () => {
    expect(parseFeatureInfo({ features: [{ properties: { value: 1.5 } }] })).toEqual({
      value: 1.5,
      label: null,
      time: null,
      referenceTime: null,
    });
  });

  it.each([
    ['not an object', 'nope'],
    ['no features', {}],
    ['empty features', { features: [] }],
    ['no properties', { features: [{}] }],
    ['non-numeric value', { features: [{ properties: { value: 'NaN' } }] }],
  ])('returns null on %s', (_name, json) => {
    expect(parseFeatureInfo(json)).toBeNull();
  });

  it('keeps the capabilities URL layer-scoped', () => {
    expect(weatherCapabilitiesUrl('radar-snow')).toContain('request=GetCapabilities');
    expect(weatherCapabilitiesUrl('radar-snow')).toContain('layer=RADAR_1KM_RSNO');
  });

  it('pins an arbitrary layer and time in the generalized URL (M2 table cells)', () => {
    const url = getFeatureInfoUrlForLayer(
      'RDPS_10km_AirTemp_2m',
      { latitude: 46.813, longitude: -71.208 },
      '2026-08-09T15:00:00Z',
    );
    expect(url).toContain('layers=RDPS_10km_AirTemp_2m');
    expect(url).toContain('query_layers=RDPS_10km_AirTemp_2m');
    expect(url).toContain('time=2026-08-09T15%3A00%3A00Z');
  });

  it('omits time when not pinned', () => {
    const url = getFeatureInfoUrlForLayer('HRDPS.CONTINENTAL_TT', {
      latitude: 46.813,
      longitude: -71.208,
    });
    expect(url).not.toContain('time=');
  });
});

describe('parseTimeDimensionList', () => {
  it('expands a single interval (HRDPS/RDPS/radar form)', () => {
    const list = parseTimeDimensionList(CAPS_XML);
    expect(list).not.toBeNull();
    expect(list?.timesMs).toHaveLength(31); // 3 h of PT6M steps inclusive
    expect(list?.timesMs[0]).toBe(Date.parse('2026-08-08T18:00:00Z'));
    expect(list?.timesMs[30]).toBe(Date.parse('2026-08-08T21:00:00Z'));
    expect(list?.defaultTime).toBe('2026-08-08T21:00:00Z');
  });

  it('parses the GDPS comma-list with its 1 h to 3 h cadence change', () => {
    // Trimmed live shape (GDPS_15km_AirTemp_2m, 2026-08-09): plain timestamps,
    // hourly until the seam, then 3-hourly.
    const xml = `<Layer><Name>GDPS_15km_AirTemp_2m</Name>
      <Dimension name="time" units="ISO8601" default="2026-08-09T06:00:00Z" nearestValue="0">2026-08-12T10:00:00Z,2026-08-12T11:00:00Z,2026-08-12T12:00:00Z,2026-08-12T15:00:00Z,2026-08-12T18:00:00Z,2026-08-12T21:00:00Z</Dimension>
      </Layer>`;
    const list = parseTimeDimensionList(xml);
    expect(list?.timesMs.map((t) => new Date(t).toISOString())).toEqual([
      '2026-08-12T10:00:00.000Z',
      '2026-08-12T11:00:00.000Z',
      '2026-08-12T12:00:00.000Z',
      '2026-08-12T15:00:00.000Z',
      '2026-08-12T18:00:00.000Z',
      '2026-08-12T21:00:00.000Z',
    ]);
    expect(list?.defaultTime).toBe('2026-08-09T06:00:00Z');
  });

  it('handles a mixed list of intervals and plain timestamps, sorted and deduped', () => {
    const xml = `<Dimension name="time" default="x">2026-08-09T03:00:00Z,2026-08-09T00:00:00Z/2026-08-09T02:00:00Z/PT1H,2026-08-09T02:00:00Z</Dimension>`;
    const list = parseTimeDimensionList(xml);
    expect(list?.timesMs.map((t) => new Date(t).toISOString())).toEqual([
      '2026-08-09T00:00:00.000Z',
      '2026-08-09T01:00:00.000Z',
      '2026-08-09T02:00:00.000Z',
      '2026-08-09T03:00:00.000Z',
    ]);
  });

  it.each([
    ['no time dimension', '<Dimension name="elevation">0</Dimension>'],
    ['empty content', '<Dimension name="time" default="x"></Dimension>'],
    ['junk tokens', '<Dimension name="time" default="x">nope,also/not/valid</Dimension>'],
    ['no XML at all', 'not xml'],
  ])('returns null on %s', (_name, xml) => {
    expect(parseTimeDimensionList(xml)).toBeNull();
  });

  it('ignores junk tokens mixed with valid ones', () => {
    const xml = `<Dimension name="time" default="x">garbage,2026-08-09T00:00:00Z</Dimension>`;
    expect(parseTimeDimensionList(xml)?.timesMs).toEqual([Date.parse('2026-08-09T00:00:00Z')]);
  });
});

describe('parseReferenceTimeDefault', () => {
  it('reads the latest run from the reference_time default', () => {
    expect(parseReferenceTimeDefault(CAPS_XML)).toBe(Date.parse('2026-08-08T21:00:00Z'));
  });

  it('returns null when the dimension is absent or junk', () => {
    expect(
      parseReferenceTimeDefault('<Dimension name="time" default="x">a</Dimension>'),
    ).toBeNull();
    expect(
      parseReferenceTimeDefault('<Dimension name="reference_time" default="junk">a</Dimension>'),
    ).toBeNull();
  });
});

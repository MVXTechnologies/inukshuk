import { signedDeltaDeg } from '@core/signal/heading';
import { haversineMeters, initialBearingDeg } from './geomath';
import {
  AUTO_TICK_MIN_DP,
  EDGE_MAX_M,
  MAJOR_HALF_DP,
  MAX_TICKS,
  TICK_HALF_DP,
  autoTickStep,
  destinationPoint,
  edgeDistanceM,
  niceAtLeast,
  pointingLineFeatures,
  resolveLengthM,
  fixedTickStep,
  previewTickStep,
  resolveTickStep,
  roundTickStep,
  tickDistances,
  tickLabel,
} from './pointingLine';
import { metersPerPixel } from './scaleBar';

/** One degree of arc on the mean sphere, metres. */
const DEG_M = (6371008.8 * Math.PI) / 180;
const QC = { latitude: 46.8139, longitude: -71.2082 };

describe('destinationPoint', () => {
  it('matches the textbook example (Veness: 124.8 km at 096°01′18″ → 53°11′18″N 000°08′00″E)', () => {
    const p = destinationPoint(
      { latitude: 53 + 19 / 60 + 14 / 3600, longitude: -(1 + 43 / 60 + 47 / 3600) },
      96 + 1 / 60 + 18 / 3600,
      124_800,
    );
    expect(p.latitude).toBeCloseTo(53 + 11 / 60 + 18 / 3600, 3);
    expect(p.longitude).toBeCloseTo(8 / 60, 3);
  });

  it('runs one degree of arc along the equator and a meridian', () => {
    const east = destinationPoint({ latitude: 0, longitude: 0 }, 90, DEG_M);
    expect(east.latitude).toBeCloseTo(0, 9);
    expect(east.longitude).toBeCloseTo(1, 9);
    const north = destinationPoint({ latitude: 0, longitude: 0 }, 0, DEG_M);
    expect(north.latitude).toBeCloseTo(1, 9);
    expect(north.longitude).toBeCloseTo(0, 9);
  });

  it('round-trips with the haversine distance and the initial bearing', () => {
    for (const bearing of [0, 37, 90, 151, 180, 233, 270, 359]) {
      for (const d of [10, 500, 2000, 50_000]) {
        const p = destinationPoint(QC, bearing, d);
        expect(haversineMeters(QC, p)).toBeCloseTo(d, 3);
        expect(signedDeltaDeg(bearing, initialBearingDeg(QC, p))).toBeCloseTo(0, 6);
      }
    }
  });

  it('wraps across the antimeridian', () => {
    const p = destinationPoint({ latitude: 0, longitude: 179.9 }, 90, 0.2 * DEG_M);
    expect(p.longitude).toBeCloseTo(-179.9, 6);
  });
});

describe('edgeDistanceM', () => {
  const box = { west: -0.01, south: -0.01, east: 0.01, north: 0.01 };
  const o = { latitude: 0, longitude: 0 };

  it('runs from the centre to each side and into the corners', () => {
    expect(edgeDistanceM(o, 0, box)).toBeCloseTo(0.01 * DEG_M, 3);
    expect(edgeDistanceM(o, 90, box)).toBeCloseTo(0.01 * DEG_M, 3);
    expect(edgeDistanceM(o, 180, box)).toBeCloseTo(0.01 * DEG_M, 3);
    expect(edgeDistanceM(o, 270, box)).toBeCloseTo(0.01 * DEG_M, 3);
    expect(edgeDistanceM(o, 45, box)).toBeCloseTo(0.01 * DEG_M * Math.SQRT2, 3);
  });

  it('shortens east–west runs by cos(latitude), not north–south ones', () => {
    const at60 = { latitude: 60, longitude: 0 };
    const b = { west: -0.02, south: 59.99, east: 0.02, north: 60.01 };
    expect(edgeDistanceM(at60, 90, b)).toBeCloseTo(0.02 * DEG_M * 0.5, 0);
    expect(edgeDistanceM(at60, 0, b)).toBeCloseTo(0.01 * DEG_M, 0);
  });

  it('crosses the box from outside, and is null facing away from it', () => {
    const west = { latitude: 0, longitude: -0.02 };
    expect(edgeDistanceM(west, 90, box)).toBeCloseTo(0.03 * DEG_M, 3);
    expect(edgeDistanceM(west, 270, box)).toBeNull();
    // Parallel to a slab and outside it.
    expect(edgeDistanceM({ latitude: 0.05, longitude: 0 }, 90, box)).toBeNull();
  });

  it('handles a box across ±180°', () => {
    const seam = { west: 179.99, south: -0.01, east: -179.99, north: 0.01 };
    expect(edgeDistanceM({ latitude: 0, longitude: -180 }, 90, seam)).toBeCloseTo(0.01 * DEG_M, 3);
    expect(edgeDistanceM({ latitude: 0, longitude: 179.995 }, 90, seam)).toBeCloseTo(
      0.015 * DEG_M,
      3,
    );
  });

  it('is capped (a pitched camera reaches the horizon) and refuses junk', () => {
    const huge = { west: -60, south: -60, east: 60, north: 60 };
    expect(edgeDistanceM(o, 0, huge)).toBe(EDGE_MAX_M);
    expect(edgeDistanceM(o, 0, { ...box, north: NaN })).toBeNull();
  });
});

describe('ticks', () => {
  it('rounds up to 1/2/5 × 10ⁿ', () => {
    expect(niceAtLeast(437)).toBe(500);
    expect(niceAtLeast(500)).toBe(500);
    expect(niceAtLeast(501)).toBe(1000);
    expect(niceAtLeast(1.5)).toBe(2);
    expect(niceAtLeast(0.7)).toBe(1);
    expect(niceAtLeast(0)).toBe(0);
    expect(niceAtLeast(NaN)).toBe(0);
  });

  it('auto: the smallest round step at least 24 dp apart, at every zoom', () => {
    // z16 at the equator: 1.19 m/dp → 28.7 m → 50 m.
    expect(autoTickStep(16, 0, 'metric')).toEqual({ stepM: 50, unit: 'm' });
    // z14 over Québec: 3.27 m/dp → 78.5 m → 100 m.
    expect(autoTickStep(14, QC.latitude, 'metric')).toEqual({ stepM: 100, unit: 'm' });
    for (let z = 2; z <= 22; z += 0.25) {
      const mpp = metersPerPixel(z, QC.latitude)!;
      const step = autoTickStep(z, QC.latitude, 'metric')!.stepM;
      expect(step / mpp).toBeGreaterThanOrEqual(AUTO_TICK_MIN_DP - 1e-9);
      // …and the next smaller round step would be too close (or it is the 1 m floor).
      if (step > 1) {
        const smaller = String(step).startsWith('5') ? step * 0.4 : step / 2;
        expect(smaller / mpp).toBeLessThan(AUTO_TICK_MIN_DP);
      }
    }
    expect(autoTickStep(NaN, 0, 'metric')).toBeNull();
  });

  it('auto in imperial: round feet up to 500 ft, then round miles, at every zoom', () => {
    // z16 at the equator: 28.7 m = 94 ft → 100 ft.
    const z16 = autoTickStep(16, 0, 'imperial')!;
    expect(z16.unit).toBe('ft');
    expect(z16.stepM / 0.3048).toBeCloseTo(100, 9);
    // z12 over Québec: 13.1 m/dp → 314 m = 1030 ft = 0.195 mi → 0.2 mi.
    const z12 = autoTickStep(12, QC.latitude, 'imperial')!;
    expect(z12.unit).toBe('mi');
    expect(z12.stepM / 1609.344).toBeCloseTo(0.2, 9);
    for (let z = 2; z <= 22; z += 0.25) {
      const mpp = metersPerPixel(z, QC.latitude)!;
      const { stepM, unit } = autoTickStep(z, QC.latitude, 'imperial')!;
      expect(stepM / mpp).toBeGreaterThanOrEqual(AUTO_TICK_MIN_DP - 1e-9);
      // The step is a round number in its own unit: 1, 2 or 5 × 10ⁿ.
      const n = stepM / (unit === 'ft' ? 0.3048 : 1609.344);
      const lead = Number((n / Math.pow(10, Math.floor(Math.log10(n) + 1e-9))).toFixed(6));
      expect([1, 2, 5]).toContain(lead);
      if (unit === 'ft') expect(n).toBeLessThanOrEqual(500);
      else expect(n).toBeGreaterThanOrEqual(0.1);
    }
    expect(autoTickStep(NaN, 0, 'imperial')).toBeNull();
  });

  it('rounds a minimum step in either unit system', () => {
    expect(roundTickStep(0.2, 'metric')).toEqual({ stepM: 1, unit: 'm' });
    expect(roundTickStep(0.1, 'imperial')).toEqual({ stepM: 0.3048, unit: 'ft' });
    expect(roundTickStep(500 * 0.3048, 'imperial')).toEqual({ stepM: 500 * 0.3048, unit: 'ft' });
    // Just past 500 ft: the next round step is 0.1 mi (528 ft).
    expect(roundTickStep(501 * 0.3048, 'imperial')).toEqual({
      stepM: 0.1 * 1609.344,
      unit: 'mi',
    });
  });

  it('maps the fixed choices to round feet in imperial', () => {
    expect(fixedTickStep(50, 'metric')).toEqual({ stepM: 50, unit: 'm' });
    expect(fixedTickStep(10, 'imperial')).toEqual({ stepM: 50 * 0.3048, unit: 'ft' });
    expect(fixedTickStep(50, 'imperial')).toEqual({ stepM: 200 * 0.3048, unit: 'ft' });
    expect(fixedTickStep(100, 'imperial')).toEqual({ stepM: 500 * 0.3048, unit: 'ft' });
  });

  it('resolves the setting: off, unknown zoom, fused fixed ticks → none', () => {
    expect(resolveTickStep('off', 16, 0, 'metric')).toBeNull();
    expect(resolveTickStep(50, null, 0, 'metric')).toBeNull();
    expect(resolveTickStep(50, 16, 0, 'metric')).toEqual({ stepM: 50, unit: 'm' });
    expect(resolveTickStep(50, 16, 0, 'imperial')).toEqual({ stepM: 200 * 0.3048, unit: 'ft' });
    // 10 m at z10 is 0.07 dp apart: a solid bar, so none (50 ft too).
    expect(resolveTickStep(10, 10, 0, 'metric')).toBeNull();
    expect(resolveTickStep(10, 10, 0, 'imperial')).toBeNull();
    expect(resolveTickStep('auto', 16, 0, 'metric')).toEqual({ stepM: 50, unit: 'm' });
    expect(resolveTickStep('auto', 16, 0, 'imperial')?.unit).toBe('ft');
  });

  it('previews five auto ticks (round in imperial), and the fixed step as set', () => {
    expect(previewTickStep('off', 500, 'metric')).toBeNull();
    expect(previewTickStep('auto', 500, 'metric')).toEqual({ stepM: 100, unit: 'm' });
    expect(previewTickStep('auto', 2000, 'metric')).toEqual({ stepM: 400, unit: 'm' });
    // 500 m / 5 = 328 ft → 500 ft.
    expect(previewTickStep('auto', 500, 'imperial')).toEqual({ stepM: 500 * 0.3048, unit: 'ft' });
    expect(previewTickStep(100, 500, 'imperial')).toEqual({ stepM: 500 * 0.3048, unit: 'ft' });
    expect(previewTickStep(10, 500, 'metric')).toEqual({ stepM: 10, unit: 'm' });
  });

  it('places ticks every step up to the length, capped', () => {
    expect(tickDistances(500, 50)).toEqual([50, 100, 150, 200, 250, 300, 350, 400, 450, 500]);
    expect(tickDistances(520, 50)).toHaveLength(10);
    expect(tickDistances(49, 50)).toEqual([]);
    expect(tickDistances(500, 0)).toEqual([]);
    expect(tickDistances(1e9, 1)).toHaveLength(MAX_TICKS);
  });

  it('labels in metres, then kilometres', () => {
    expect(tickLabel(50, 'm')).toBe('50 m');
    expect(tickLabel(500, 'm')).toBe('500 m');
    expect(tickLabel(1000, 'm')).toBe('1 km');
    expect(tickLabel(1500, 'm')).toBe('1.5 km');
    expect(tickLabel(2250, 'm')).toBe('2.25 km');
  });

  it('labels a feet step in round feet, a mile step in round miles', () => {
    // Every 5th tick of a 200 ft step, past a mile: still round feet.
    expect(tickLabel(1000 * 0.3048, 'ft')).toBe('1000 ft');
    expect(tickLabel(6000 * 0.3048, 'ft')).toBe('6000 ft');
    expect(tickLabel(5 * 50 * 0.3048, 'ft')).toBe('250 ft');
    expect(tickLabel(0.5 * 1609.344, 'mi')).toBe('0.5 mi');
    expect(tickLabel(1609.344, 'mi')).toBe('1 mi');
    expect(tickLabel(15 * 0.1 * 1609.344, 'mi')).toBe('1.5 mi');
  });
});

describe('resolveLengthM', () => {
  it('is the setting, or the edge distance once bounds exist', () => {
    expect(resolveLengthM(500, QC, 0, null)).toBe(500);
    expect(resolveLengthM('edge', QC, 0, null)).toBeNull();
    const b = { west: -71.22, south: 46.8, east: -71.2, north: 46.82 };
    expect(resolveLengthM('edge', QC, 0, b)).toBeCloseTo((46.82 - QC.latitude) * DEG_M, 3);
  });
});

describe('pointingLineFeatures', () => {
  type F = {
    geometry: { type: string; coordinates: unknown };
    properties: { kind: string; text?: string };
  };
  const kinds = (fc: { features: F[] }) => fc.features.map((f) => f.properties.kind);
  const ll = (c: unknown) => {
    const [lng, lat] = c as [number, number];
    return { latitude: lat, longitude: lng };
  };

  it('draws the line and its end; nothing sized in dp without a zoom', () => {
    const fc = pointingLineFeatures({
      origin: QC,
      bearingDeg: 62,
      lengthM: 500,
      tickStep: { stepM: 50, unit: 'm' },
      zoom: null,
      labelMajors: true,
      endLabel: 'COG',
    }) as unknown as { features: F[] };
    expect(kinds(fc)).toEqual(['line', 'end']);
    const [a, b] = fc.features[0]!.geometry.coordinates as [unknown, unknown];
    expect(haversineMeters(ll(a), ll(b))).toBeCloseTo(500, 3);
    expect(initialBearingDeg(ll(a), ll(b))).toBeCloseTo(62, 6);
  });

  it('ticks across the line every step, majors every 5th, labels only there', () => {
    const zoom = 16;
    const mpp = metersPerPixel(zoom, QC.latitude)!;
    const fc = pointingLineFeatures({
      origin: QC,
      bearingDeg: 30,
      lengthM: 500,
      tickStep: { stepM: 50, unit: 'm' },
      zoom,
      labelMajors: true,
      endLabel: null,
    }) as unknown as { features: F[] };
    const k = kinds(fc);
    expect(k.filter((x) => x === 'tick')).toHaveLength(8);
    expect(k.filter((x) => x === 'major')).toHaveLength(2);
    expect(
      fc.features.filter((f) => f.properties.kind === 'label').map((f) => f.properties.text),
    ).toEqual(['250 m', '500 m']);
    const ticks = fc.features.filter((f) => f.properties.kind === 'tick');
    const [t0a, t0b] = ticks[0]!.geometry.coordinates as [unknown, unknown];
    // Square to the line, 2 × 4.5 dp long, centred 50 m out.
    expect(initialBearingDeg(ll(t0a), ll(t0b))).toBeCloseTo(120, 1);
    expect(haversineMeters(ll(t0a), ll(t0b))).toBeCloseTo(2 * TICK_HALF_DP * mpp, 1);
    const mid = {
      latitude: (ll(t0a).latitude + ll(t0b).latitude) / 2,
      longitude: (ll(t0a).longitude + ll(t0b).longitude) / 2,
    };
    expect(haversineMeters(QC, mid)).toBeCloseTo(50, 1);
    const major = fc.features.find((f) => f.properties.kind === 'major')!;
    const [ma, mb] = major.geometry.coordinates as [unknown, unknown];
    expect(haversineMeters(ll(ma), ll(mb))).toBeCloseTo(2 * MAJOR_HALF_DP * mpp, 1);
  });

  it('labels the majors of an imperial line in round feet', () => {
    const step = fixedTickStep(50, 'imperial'); // 200 ft
    const fc = pointingLineFeatures({
      origin: QC,
      bearingDeg: 90,
      lengthM: 2000,
      tickStep: step,
      zoom: 16,
      labelMajors: true,
      endLabel: null,
    }) as unknown as { features: F[] };
    // 2000 m = 6562 ft: 32 ticks of 200 ft, majors at 1000…6000 ft.
    expect(fc.features.filter((f) => f.properties.kind === 'major')).toHaveLength(6);
    expect(
      fc.features.filter((f) => f.properties.kind === 'label').map((f) => f.properties.text),
    ).toEqual(['1000 ft', '2000 ft', '3000 ft', '4000 ft', '5000 ft', '6000 ft']);
  });

  it('skips labels when asked and adds the COG word at the end', () => {
    const fc = pointingLineFeatures({
      origin: QC,
      bearingDeg: 0,
      lengthM: 500,
      tickStep: { stepM: 100, unit: 'm' },
      zoom: 15,
      labelMajors: false,
      endLabel: 'COG',
    }) as unknown as { features: F[] };
    const labels = fc.features.filter((f) => f.properties.kind === 'label');
    expect(labels.map((f) => f.properties.text)).toEqual(['COG']);
  });
});

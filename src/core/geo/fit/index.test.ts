import { FitDecodeError, decodeFit, looksLikeFit } from './index';
import {
  FitWriter,
  buildSimpleFit,
  toFitAltitude,
  toFitTime,
  toSemicircles,
  type SimpleFitPoint,
} from './testUtils';

const T0 = Date.UTC(2026, 8, 12, 13, 0, 0);

const pts: SimpleFitPoint[] = [
  { lat: 46.8139, lon: -71.208, timeMs: T0, altM: 100.2, hr: 120 },
  { lat: 46.8141, lon: -71.2078, timeMs: T0 + 5000, altM: 101, hr: 125 },
  { lat: 46.8143, lon: -71.2076, timeMs: T0 + 10000, altM: 102.4, hr: 130 },
];

const recordFields = [
  { num: 253, type: 'uint32' as const },
  { num: 0, type: 'sint32' as const },
  { num: 1, type: 'sint32' as const },
];

function expectFitError(fn: () => unknown, code: FitDecodeError['code']): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(FitDecodeError);
  expect((caught as FitDecodeError).code).toBe(code);
}

describe('decodeFit', () => {
  it('round-trips positions, time, enhanced altitude and heart rate', () => {
    const fit = decodeFit(buildSimpleFit(pts, { sport: 1 }));
    expect(fit.points).toHaveLength(3);
    fit.points.forEach((p, i) => {
      const src = pts[i]!;
      expect(p.latitude).toBeCloseTo(src.lat, 6);
      expect(p.longitude).toBeCloseTo(src.lon, 6);
      expect(p.time).toBe(src.timeMs);
      expect(p.hasTime).toBe(true);
      expect(p.altitude).toBeCloseTo(src.altM!, 1);
      expect(p.heartRateBpm).toBe(src.hr);
    });
    expect(fit.sport).toBe('running');
    expect(fit.startTime).toBe(T0);
    expect(fit.segmentStarts).toEqual([]);
  });

  it('decodes a big-endian record definition identically', () => {
    const le = decodeFit(buildSimpleFit(pts));
    const be = decodeFit(buildSimpleFit(pts, { bigEndian: true }));
    expect(be.points).toEqual(le.points);
  });

  it('accepts a 12-byte header', () => {
    const w = new FitWriter().define(0, 20, recordFields);
    w.data(0, [toFitTime(T0), toSemicircles(45), toSemicircles(-73)]);
    const fit = decodeFit(w.build({ headerSize: 12 }));
    expect(fit.points).toHaveLength(1);
    expect(fit.points[0]!.latitude).toBeCloseTo(45, 6);
  });

  it('resolves compressed timestamps, including the 5-bit rollover', () => {
    const base = toFitTime(T0); // T0 seconds
    const w = new FitWriter().define(0, 20, recordFields);
    w.data(0, [base, toSemicircles(45), toSemicircles(-73)]);
    const low = base & 0x1f;
    // Compressed records carry no timestamp field: define a record without 253.
    w.define(1, 20, recordFields.slice(1));
    w.data(1, [toSemicircles(45.001), toSemicircles(-73)], (low + 3) & 0x1f);
    // An offset below the last low bits means the counter rolled over (+32 s).
    w.data(1, [toSemicircles(45.002), toSemicircles(-73)], (low + 3 + 31) & 0x1f);
    const fit = decodeFit(w.build());
    expect(fit.points.map((p) => (p.time - T0) / 1000)).toEqual([0, 3, 34]);
  });

  it('skips developer data fields by their declared size', () => {
    const w = new FitWriter().define(0, 20, recordFields, { devFieldSizes: [4, 1] });
    w.data(0, [toFitTime(T0), toSemicircles(45), toSemicircles(-73)]);
    w.data(0, [toFitTime(T0) + 1, toSemicircles(45.001), toSemicircles(-73.001)]);
    const fit = decodeFit(w.build());
    expect(fit.points).toHaveLength(2);
    expect(fit.points[1]!.longitude).toBeCloseTo(-73.001, 6);
  });

  it('skips records without a position and honors invalid sentinels', () => {
    const w = new FitWriter().define(0, 20, [
      ...recordFields,
      { num: 2, type: 'uint16' },
      { num: 3, type: 'uint8' },
      { num: 6, type: 'uint16' },
    ]);
    w.data(0, [toFitTime(T0), undefined, undefined, toFitAltitude(10), 100, 2000]);
    w.data(0, [toFitTime(T0) + 1, toSemicircles(45), toSemicircles(-73), undefined, undefined]);
    w.data(0, [
      toFitTime(T0) + 2,
      toSemicircles(45.001),
      toSemicircles(-73),
      toFitAltitude(12),
      0,
      2500,
    ]);
    const fit = decodeFit(w.build());
    expect(fit.points).toHaveLength(2);
    expect(fit.points[0]!.altitude).toBeUndefined();
    expect(fit.points[0]!.heartRateBpm).toBeUndefined();
    expect(fit.points[0]!.speed).toBeUndefined();
    expect(fit.points[1]!.altitude).toBeCloseTo(12, 5);
    expect(fit.points[1]!.heartRateBpm).toBeUndefined(); // 0 bpm is not a reading
    expect(fit.points[1]!.speed).toBeCloseTo(2.5, 5);
  });

  it('marks records without a timestamp as untimed', () => {
    const w = new FitWriter().define(0, 20, recordFields.slice(1));
    w.data(0, [toSemicircles(45), toSemicircles(-73)]);
    const [p] = decodeFit(w.build()).points;
    expect(p).toMatchObject({ time: 0, hasTime: false });
  });

  it('turns a timer stop into a segment boundary', () => {
    const w = new FitWriter().define(0, 20, recordFields);
    w.define(1, 21, [
      { num: 253, type: 'uint32' },
      { num: 0, type: 'enum' },
      { num: 1, type: 'enum' },
    ]);
    const t = toFitTime(T0);
    w.data(0, [t, toSemicircles(45), toSemicircles(-73)]);
    w.data(0, [t + 1, toSemicircles(45.001), toSemicircles(-73)]);
    w.data(1, [t + 2, 0, 1]); // timer stop
    w.data(1, [t + 60, 0, 0]); // timer start
    w.data(0, [t + 61, toSemicircles(45.002), toSemicircles(-73)]);
    w.data(1, [t + 62, 3, 3]); // some other event: no break
    w.data(0, [t + 63, toSemicircles(45.003), toSemicircles(-73)]);
    expect(decodeFit(w.build()).segmentStarts).toEqual([2]);
  });

  it('maps sport + sub-sport, preferring the session over the sport message', () => {
    expect(decodeFit(buildSimpleFit(pts, { sport: 1, subSport: 3 })).sport).toBe('trail_running');
    expect(decodeFit(buildSimpleFit(pts, { sport: 2, subSport: 8 })).sport).toBe('mountain_biking');
    expect(decodeFit(buildSimpleFit(pts, { sport: 12, subSport: 37 })).sport).toBe(
      'backcountry_skiing',
    );
    expect(decodeFit(buildSimpleFit(pts, { sport: 17 })).sport).toBe('hiking');
    expect(decodeFit(buildSimpleFit(pts, { sport: 99 })).sport).toBe('sport_99');

    const w = new FitWriter().define(0, 12, [
      { num: 0, type: 'enum' },
      { num: 1, type: 'enum' },
      { num: 3, type: 'string' },
    ]);
    w.data(0, [11, 0, undefined]);
    expect(decodeFit(w.build()).sport).toBe('walking');
  });

  it('falls back to file_id creation time without a session', () => {
    const w = new FitWriter().define(0, 0, [{ num: 4, type: 'uint32' }]);
    w.data(0, [toFitTime(T0)]);
    const fit = decodeFit(w.build());
    expect(fit.startTime).toBe(T0);
    expect(fit.sport).toBeUndefined();
  });

  it('decodes chained FIT files and ignores trailing garbage', () => {
    const a = buildSimpleFit(pts.slice(0, 2));
    const b = buildSimpleFit(pts.slice(2));
    const chained = new Uint8Array(a.length + b.length + 3);
    chained.set(a, 0);
    chained.set(b, a.length);
    chained.set([1, 2, 3], a.length + b.length);
    expect(decodeFit(chained).points).toHaveLength(3);
  });

  it('reads to the end when the header data size is zero (unfinalized file)', () => {
    const w = new FitWriter().define(0, 20, recordFields);
    w.data(0, [toFitTime(T0), toSemicircles(45), toSemicircles(-73)]);
    const bytes = w.build();
    new DataView(bytes.buffer).setUint32(4, 0, true);
    // Without its declared size the trailing CRC placeholder reads as a record header.
    expect(() => decodeFit(bytes.subarray(0, bytes.length - 2))).not.toThrow();
  });

  describe('malformed input', () => {
    it('rejects non-FIT bytes', () => {
      expect(looksLikeFit(new Uint8Array([1, 2, 3]))).toBe(false);
      expectFitError(() => decodeFit(new TextEncoder().encode('<gpx></gpx>')), 'not-fit');
    });

    it('rejects a file whose data is shorter than the header claims', () => {
      const bytes = buildSimpleFit(pts);
      expectFitError(() => decodeFit(bytes.subarray(0, bytes.length - 20)), 'truncated');
    });

    it('rejects a data message referencing an undefined local type', () => {
      const bytes = new FitWriter().raw(0x05, 1, 2, 3).build();
      expectFitError(() => decodeFit(bytes), 'undefined-local-message');
    });

    it('rejects a definition with an unknown architecture', () => {
      const bytes = new FitWriter().raw(0x40, 0, 7, 20, 0, 0).build();
      expectFitError(() => decodeFit(bytes), 'bad-definition');
    });

    it('rejects cut-off definitions and data messages', () => {
      expectFitError(() => decodeFit(new FitWriter().raw(0x40, 0, 0).build()), 'truncated');
      expectFitError(
        () => decodeFit(new FitWriter().raw(0x40, 0, 0, 20, 0, 3, 0).build()),
        'truncated',
      );
      expectFitError(
        () => decodeFit(new FitWriter().raw(0x60, 0, 0, 20, 0, 0, 2, 0).build()),
        'truncated',
      );
      expectFitError(
        () => decodeFit(new FitWriter().raw(0x60, 0, 0, 20, 0, 0).build()),
        'truncated',
      );
      const w = new FitWriter().define(0, 20, recordFields).raw(0x00, 1, 2);
      expectFitError(() => decodeFit(w.build()), 'truncated');
    });

    it('never hangs or crashes on random garbage behind a valid header', () => {
      let seed = 42;
      const rand = () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return seed & 0xff;
      };
      for (let i = 0; i < 300; i++) {
        const noise = Array.from({ length: 1 + (i % 97) }, rand);
        const bytes = new FitWriter().raw(...noise).build();
        try {
          decodeFit(bytes);
        } catch (err) {
          expect(err).toBeInstanceOf(FitDecodeError);
        }
      }
    });
  });
});

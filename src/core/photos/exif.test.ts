import {
  exifLngLat,
  exifTime,
  normalizeExif,
  parseExifDateTime,
  parseExifOffset,
  parseGpsDateTime,
  resolveTakenAt,
  type ZoneOffsetAt,
} from './exif';

/** What expo-image-picker returns on iOS: `{Exif}` + flattened `{GPS}` (+ TIFF). */
const IOS = {
  DateTimeOriginal: '2026:09:27 10:31:05',
  OffsetTimeOriginal: '-04:00',
  SubsecTimeOriginal: '45',
  PixelXDimension: 4032,
  PixelYDimension: 3024,
  GPSLatitude: 47.66751,
  GPSLatitudeRef: 'N',
  GPSLongitude: 70.61322,
  GPSLongitudeRef: 'W',
  GPSAltitude: 902.4,
  GPSAltitudeRef: 0,
  GPSDateStamp: '2026:09:27',
  GPSTimeStamp: '14:31:04.00',
  Make: 'Apple',
};

/** What it returns on Android (ExifInterface): signed decimals, no offset tag. */
const ANDROID = {
  DateTimeOriginal: '2026:09:27 10:31:05',
  SubSecTimeOriginal: '120',
  GPSLatitude: 47.66751,
  GPSLongitude: -70.61322,
  GPSLongitudeRef: 'W',
  GPSAltitude: 902.4,
  GPSDateStamp: '2026:09:27',
  GPSTimeStamp: '14/1,31/1,4/1',
  ImageWidth: 4000,
  ImageLength: 3000,
};

const EDT: ZoneOffsetAt = () => -240;

describe('normalizeExif', () => {
  it('reads an iPhone photo: offset time wins, signed position, altitude, size', () => {
    const n = normalizeExif(IOS);
    expect(n.time).toEqual({
      kind: 'absolute',
      epochMs: Date.UTC(2026, 8, 27, 14, 31, 5, 450),
      source: 'exif-offset',
    });
    expect(n.lngLat).toEqual([-70.61322, 47.66751]);
    expect(n.altitudeM).toBeCloseTo(902.4);
    expect(n).toMatchObject({ width: 4032, height: 3024 });
  });

  it('reads a Samsung photo: GPS UTC time, refined with the original sub-seconds', () => {
    const n = normalizeExif(ANDROID);
    expect(n.time).toEqual({
      kind: 'absolute',
      epochMs: Date.UTC(2026, 8, 27, 14, 31, 5, 120),
      source: 'exif-gps-utc',
    });
    // Already negative + a W ref: not mirrored back east.
    expect(n.lngLat).toEqual([-70.61322, 47.66751]);
    expect(n).toMatchObject({ width: 4000, height: 3000 });
  });

  it('keeps the raw wall-clock reading the time came from, for re-pick dedupe', () => {
    expect(normalizeExif(ANDROID).wallClock).toBe('2026:09:27 10:31:05.120');
    expect(normalizeExif(IOS).wallClock).toMatch(/^2026:09:27 10:31:05/);
    expect(normalizeExif({ DateTime: ' 2027:01:01 00:00:00 ' }).wallClock).toBe(
      '2027:01:01 00:00:00',
    );
    expect(normalizeExif({ DateTimeOriginal: '2026:01:01 00:00:00.5' }).wallClock).toBe(
      '2026:01:01 00:00:00.5',
    );
    const { DateTimeOriginal: _d, ...gpsOnly } = ANDROID;
    expect(normalizeExif(gpsOnly)).not.toHaveProperty('wallClock');
  });

  it('falls back to an unzoned local time', () => {
    expect(normalizeExif({ DateTimeOriginal: '2026:09:27 10:31:05' }).time).toEqual({
      kind: 'local',
      wallMs: Date.UTC(2026, 8, 27, 10, 31, 5),
    });
  });

  it('ignores a stale GPS fix and reads the original time in the device zone', () => {
    // Android: no offset tag. The last fix was 6 min 56 s before the shot, so
    // the stamp is NOT the capture time and no time zone explains the gap.
    const n = normalizeExif({ ...ANDROID, DateTimeOriginal: '2026:09:27 10:38:00' });
    expect(n.time).toEqual({ kind: 'local', wallMs: Date.UTC(2026, 8, 27, 10, 38, 0, 120) });
    expect(resolveTakenAt(n.time!, EDT)).toEqual({
      epochMs: Date.UTC(2026, 8, 27, 14, 38, 0, 120),
      source: 'exif-local',
    });
  });

  it('ignores a fix hours stale, falling back to the device zone', () => {
    const n = normalizeExif({ ...ANDROID, GPSTimeStamp: '11/1,49/1,30/1' }); // 2 h 42 min old
    expect(n.time).toEqual({ kind: 'local', wallMs: Date.UTC(2026, 8, 27, 10, 31, 5, 120) });
    expect(resolveTakenAt(n.time!, EDT).source).toBe('exif-local');
  });

  it('infers the zone from a fresh fix even when the device is elsewhere now', () => {
    // Shot in Paris (UTC+2) at 16:31:05 local, imported back home in EDT.
    const n = normalizeExif({ ...ANDROID, DateTimeOriginal: '2026:09:27 16:31:05' });
    expect(resolveTakenAt(n.time!, EDT)).toEqual({
      epochMs: Date.UTC(2026, 8, 27, 14, 31, 5, 120),
      source: 'exif-gps-utc',
    });
  });

  it('does not infer a zone beyond ±14 h', () => {
    const n = normalizeExif({ ...ANDROID, GPSDateStamp: '2026:09:26' }); // 24 h apart
    expect(n.time).toMatchObject({ kind: 'local' });
  });

  it('uses the GPS stamp alone when there is no original time', () => {
    const { DateTimeOriginal: _d, ...gpsOnly } = ANDROID;
    expect(normalizeExif(gpsOnly).time).toMatchObject({
      epochMs: Date.UTC(2026, 8, 27, 14, 31, 4),
    });
  });

  it('prefers DateTimeOriginal, then Digitized, then DateTime', () => {
    expect(
      exifTime({ DateTimeDigitized: '2026:01:02 03:04:05', DateTime: '2027:01:01 00:00:00' }),
    ).toEqual({
      kind: 'local',
      wallMs: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    expect(exifTime({ DateTime: '2027:01:01 00:00:00' })).toMatchObject({
      wallMs: Date.UTC(2027, 0, 1),
    });
  });

  it('is empty for non-objects and garbage', () => {
    expect(normalizeExif(null)).toEqual({});
    expect(normalizeExif('x')).toEqual({});
    expect(normalizeExif({ DateTimeOriginal: '0000:00:00 00:00:00', GPSLatitude: 'abc' })).toEqual(
      {},
    );
  });

  it('marks below-sea-level altitude', () => {
    expect(normalizeExif({ ...IOS, GPSAltitude: 12, GPSAltitudeRef: 1 }).altitudeM).toBe(-12);
  });

  it('ignores a size that is not positive', () => {
    expect(normalizeExif({ PixelXDimension: 0, PixelYDimension: 10 }).width).toBeUndefined();
  });
});

describe('exifLngLat', () => {
  it('applies S/W refs to unsigned values', () => {
    expect(
      exifLngLat({
        GPSLatitude: 33.9,
        GPSLatitudeRef: 'S',
        GPSLongitude: 18.4,
        GPSLongitudeRef: 'E',
      }),
    ).toEqual([18.4, -33.9]);
    expect(
      exifLngLat({ GPSLatitude: 1, GPSLatitudeRef: 's', GPSLongitude: 2, GPSLongitudeRef: 'w' }),
    ).toEqual([-2, -1]);
  });

  it('reads degree/minute/second triples as strings, rationals and arrays', () => {
    const p = exifLngLat({
      GPSLatitude: '47/1,40/1,300/100',
      GPSLatitudeRef: 'N',
      GPSLongitude: [70, 36, 47.6],
      GPSLongitudeRef: 'W',
    })!;
    expect(p[1]).toBeCloseTo(47 + 40 / 60 + 3 / 3600, 9);
    expect(p[0]).toBeCloseTo(-(70 + 36 / 60 + 47.6 / 3600), 9);
    expect(exifLngLat({ GPSLatitude: '47,40,3', GPSLongitude: '70,36,47' })![1]).toBeCloseTo(
      47.6675,
      4,
    );
  });

  it('rejects 0,0, out-of-range and partial positions', () => {
    expect(exifLngLat({ GPSLatitude: 0, GPSLongitude: 0 })).toBeUndefined();
    expect(exifLngLat({ GPSLatitude: 91, GPSLongitude: 0 })).toBeUndefined();
    expect(exifLngLat({ GPSLatitude: 45 })).toBeUndefined();
    expect(exifLngLat({ GPSLatitude: '1,2', GPSLongitude: 3 })).toBeUndefined();
    expect(exifLngLat({ GPSLatitude: [1, 'x', 3], GPSLongitude: 3 })).toBeUndefined();
    expect(exifLngLat({ GPSLatitude: '4/0', GPSLongitude: 3 })).toBeUndefined();
  });

  it('reads plain Latitude/Longitude spellings', () => {
    expect(
      exifLngLat({ Latitude: '45.5', LatitudeRef: 'N', Longitude: '73.6', LongitudeRef: 'W' }),
    ).toEqual([-73.6, 45.5]);
  });
});

describe('parseExifDateTime', () => {
  it('parses EXIF and ISO-ish separators with sub-seconds', () => {
    expect(parseExifDateTime('2026:09:27 10:31:05')).toBe(Date.UTC(2026, 8, 27, 10, 31, 5));
    expect(parseExifDateTime('2026-09-27T10:31:05.5')).toBe(Date.UTC(2026, 8, 27, 10, 31, 5, 500));
    expect(parseExifDateTime('2026:09:27 10:31:05', '07')).toBe(
      Date.UTC(2026, 8, 27, 10, 31, 5, 70),
    );
    expect(parseExifDateTime('2026:09:27 10:31:05', 'xx')).toBe(Date.UTC(2026, 8, 27, 10, 31, 5));
  });

  it('rejects impossible dates instead of rolling them over', () => {
    expect(parseExifDateTime('2026:02:31 10:00:00')).toBeUndefined();
    expect(parseExifDateTime('2026:13:01 10:00:00')).toBeUndefined();
    expect(parseExifDateTime('1899:01:01 10:00:00')).toBeUndefined();
    expect(parseExifDateTime('2026:01:01 25:00:00')).toBeUndefined();
    expect(parseExifDateTime('yesterday')).toBeUndefined();
    expect(parseExifDateTime(20260101)).toBeUndefined();
    expect(parseExifDateTime('   ')).toBeUndefined();
  });
});

describe('parseExifOffset', () => {
  it('parses signed offsets and Z', () => {
    expect(parseExifOffset('-04:00')).toBe(-240);
    expect(parseExifOffset('+05:30')).toBe(330);
    expect(parseExifOffset('+0545')).toBe(345);
    expect(parseExifOffset('Z')).toBe(0);
  });
  it('rejects nonsense', () => {
    expect(parseExifOffset('+15:00')).toBeUndefined();
    expect(parseExifOffset('EDT')).toBeUndefined();
    expect(parseExifOffset(undefined)).toBeUndefined();
  });
});

describe('parseGpsDateTime', () => {
  it('reads colon, rational and array times', () => {
    const t = Date.UTC(2026, 8, 27, 14, 31, 4);
    expect(parseGpsDateTime('2026:09:27', '14:31:04.00')).toBe(t);
    expect(parseGpsDateTime('2026:09:27', '14/1,31/1,4/1')).toBe(t);
    expect(parseGpsDateTime('2026-09-27', [14, 31, 4])).toBe(t);
  });
  it('rejects partial or impossible stamps', () => {
    expect(parseGpsDateTime('2026:09:27', undefined)).toBeUndefined();
    expect(parseGpsDateTime(undefined, '14:31:04')).toBeUndefined();
    expect(parseGpsDateTime('27/09/2026', '14:31:04')).toBeUndefined();
    expect(parseGpsDateTime('2026:09:27', '24:00:00')).toBeUndefined();
    expect(parseGpsDateTime('2026:09:27', '14:31')).toBeUndefined();
    expect(parseGpsDateTime('2026:09:27', [14, 'x', 4])).toBeUndefined();
  });
});

describe('resolveTakenAt', () => {
  it('keeps an absolute time', () => {
    expect(resolveTakenAt({ kind: 'absolute', epochMs: 5, source: 'exif-offset' }, EDT)).toEqual({
      epochMs: 5,
      source: 'exif-offset',
    });
  });

  it('reads a wall clock in the device zone at that date', () => {
    const wall = Date.UTC(2026, 8, 27, 10, 31, 5);
    expect(resolveTakenAt({ kind: 'local', wallMs: wall }, EDT)).toEqual({
      epochMs: Date.UTC(2026, 8, 27, 14, 31, 5),
      source: 'exif-local',
    });
  });

  it('uses daylight time for a September photo imported in winter', () => {
    // America/Toronto: EDT (−4) until 1 Nov 2026 06:00 UTC, then EST (−5).
    const toronto: ZoneOffsetAt = (ms) => (ms < Date.UTC(2026, 10, 1, 6) ? -240 : -300);
    const sept = resolveTakenAt({ kind: 'local', wallMs: Date.UTC(2026, 8, 27, 10) }, toronto);
    const dec = resolveTakenAt({ kind: 'local', wallMs: Date.UTC(2026, 11, 5, 10) }, toronto);
    expect(sept.epochMs).toBe(Date.UTC(2026, 8, 27, 14));
    expect(dec.epochMs).toBe(Date.UTC(2026, 11, 5, 15));
  });

  it('lands on the right side of the fall-back switch', () => {
    const toronto: ZoneOffsetAt = (ms) => (ms < Date.UTC(2026, 10, 1, 6) ? -240 : -300);
    // 03:30 local on 1 Nov is after the switch (EST): 08:30 UTC.
    const r = resolveTakenAt({ kind: 'local', wallMs: Date.UTC(2026, 10, 1, 3, 30) }, toronto);
    expect(r.epochMs).toBe(Date.UTC(2026, 10, 1, 8, 30));
  });
});

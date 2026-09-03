import { destinationReadout, formatBearing } from './destination';

const QC = { latitude: 46.8139, longitude: -71.2082 };

describe('formatBearing', () => {
  it('zero-pads to three digits and names the cardinal', () => {
    expect(formatBearing(0)).toBe('000° N');
    expect(formatBearing(42)).toBe('042° NE');
    expect(formatBearing(90)).toBe('090° E');
    expect(formatBearing(182.4)).toBe('182° S');
    expect(formatBearing(315)).toBe('315° NW');
  });

  it('wraps AFTER rounding so 359.7 reads 000, never 360', () => {
    expect(formatBearing(359.7)).toBe('000° N');
    expect(formatBearing(360)).toBe('000° N');
    expect(formatBearing(-90)).toBe('270° W');
    expect(formatBearing(725)).toBe('005° N');
  });

  it('degrades to an em dash on junk', () => {
    expect(formatBearing(Number.NaN)).toBe('—');
    expect(formatBearing(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('destinationReadout', () => {
  it('reports straight-line distance and initial bearing in the chosen units', () => {
    // ~1.1 km due north of the Plaines d'Abraham.
    const to = { latitude: 46.8239, longitude: -71.2082 };
    const metric = destinationReadout(QC, to, 'metric');
    expect(metric?.distanceM).toBeCloseTo(1112, 0);
    expect(metric?.bearingDeg).toBeCloseTo(0, 6);
    expect(metric?.distance).toBe('1.11 km');
    expect(metric?.bearing).toBe('000° N');

    const imperial = destinationReadout(QC, to, 'imperial');
    expect(imperial?.distanceM).toBeCloseTo(1112, 0);
    expect(imperial?.distance).toBe('0.69 mi');
  });

  it('points east for a destination to the east', () => {
    const east = destinationReadout(QC, { ...QC, longitude: QC.longitude + 0.02 }, 'metric');
    expect(east?.bearing).toBe('090° E');
  });

  it('reads zero distance for the pin you are standing on', () => {
    const here = destinationReadout(QC, { ...QC }, 'metric');
    expect(here?.distanceM).toBe(0);
    expect(here?.distance).toBe('0 m');
    expect(here?.bearing).toBe('000° N');
  });

  it('returns null without a position or without a destination', () => {
    expect(destinationReadout(null, QC, 'metric')).toBeNull();
    expect(destinationReadout(QC, null, 'metric')).toBeNull();
    expect(destinationReadout(undefined, undefined, 'metric')).toBeNull();
  });

  it('returns null for out-of-range or non-finite coordinates', () => {
    expect(destinationReadout({ latitude: 91, longitude: 0 }, QC, 'metric')).toBeNull();
    expect(destinationReadout(QC, { latitude: 0, longitude: 181 }, 'metric')).toBeNull();
    expect(destinationReadout(QC, { latitude: Number.NaN, longitude: 0 }, 'metric')).toBeNull();
  });
});

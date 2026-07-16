import { GPS_LOST_MS, GPS_WEAK_ACCURACY_M, GPS_WEAK_MS, gpsQualityLevel } from './gpsQuality';

const NOW = 1_700_000_000_000;

describe('gpsQualityLevel', () => {
  it("reports 'acquiring' before any fix is accepted", () => {
    expect(gpsQualityLevel(null, NOW, null)).toBe('acquiring');
    // A pending accuracy value is irrelevant with no accepted fix yet.
    expect(gpsQualityLevel(null, NOW, 5)).toBe('acquiring');
  });

  it("reports 'good' for a fresh, accurate fix", () => {
    expect(gpsQualityLevel(NOW - 1_000, NOW, 8)).toBe('good');
  });

  it("reports 'good' when accuracy is unknown but the fix is fresh", () => {
    expect(gpsQualityLevel(NOW - 1_000, NOW, null)).toBe('good');
  });

  it("reports 'weak' for a fresh fix with coarse accuracy", () => {
    expect(gpsQualityLevel(NOW - 1_000, NOW, GPS_WEAK_ACCURACY_M + 1)).toBe('weak');
  });

  it('treats the weak-accuracy threshold as inclusive-good at the boundary', () => {
    // Exactly at the threshold is still good; only strictly worse is weak.
    expect(gpsQualityLevel(NOW - 1_000, NOW, GPS_WEAK_ACCURACY_M)).toBe('good');
  });

  it("reports 'weak' once a fix is stale past the weak threshold", () => {
    expect(gpsQualityLevel(NOW - GPS_WEAK_MS, NOW, 5)).toBe('weak');
    expect(gpsQualityLevel(NOW - (GPS_WEAK_MS + 5_000), NOW, 5)).toBe('weak');
  });

  it("stays 'good' just below the weak-staleness threshold", () => {
    expect(gpsQualityLevel(NOW - (GPS_WEAK_MS - 1), NOW, 5)).toBe('good');
  });

  it("reports 'lost' once a fix is stale past the lost threshold", () => {
    expect(gpsQualityLevel(NOW - GPS_LOST_MS, NOW, 5)).toBe('lost');
    expect(gpsQualityLevel(NOW - (GPS_LOST_MS + 60_000), NOW, 5)).toBe('lost');
  });

  it('lost staleness wins over an otherwise-good accuracy', () => {
    expect(gpsQualityLevel(NOW - GPS_LOST_MS, NOW, 1)).toBe('lost');
  });

  it('never reports worse than good for a future/skewed timestamp', () => {
    expect(gpsQualityLevel(NOW + 5_000, NOW, 5)).toBe('good');
  });
});

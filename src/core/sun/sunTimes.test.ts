import { msUntilSunset, sunTimes } from './sunTimes';

const MIN = 60_000;

/** Minutes between two epoch-ms values, for readable failures. */
function minutesOff(actual: number | null, expected: number): number {
  if (actual === null) return Infinity;
  return Math.abs(actual - expected) / MIN;
}

describe('sunTimes', () => {
  // Reference: London on the June solstice sets at 21:21 BST (20:21 UTC) and
  // rises at 04:43 BST (03:43 UTC).
  it('matches London on the June solstice within a few minutes', () => {
    const t = sunTimes(Date.UTC(2024, 5, 21, 12), 51.5074, -0.1278);
    expect(minutesOff(t.sunset, Date.UTC(2024, 5, 21, 20, 21))).toBeLessThan(4);
    expect(minutesOff(t.sunrise, Date.UTC(2024, 5, 21, 3, 43))).toBeLessThan(4);
  });

  it('puts sunrise before solar noon before sunset', () => {
    const t = sunTimes(Date.UTC(2026, 8, 26, 16), 46.8139, -71.2082); // Québec City
    expect(t.sunrise).not.toBeNull();
    expect(t.sunset).not.toBeNull();
    expect(t.sunrise!).toBeLessThan(t.solarNoon);
    expect(t.solarNoon).toBeLessThan(t.sunset!);
  });

  it('gives about twelve hours of day near the equinox', () => {
    const t = sunTimes(Date.UTC(2026, 8, 23, 12), 46.8139, -71.2082);
    const hours = (t.sunset! - t.sunrise!) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThan(12.4);
  });

  it('centres solar noon on the longitude (about 16:45 UTC at 71°W)', () => {
    const t = sunTimes(Date.UTC(2026, 8, 26, 16), 46.8139, -71.2082);
    // 71.2°/15 = 4 h 45 min after UTC noon, give or take the equation of time.
    expect(minutesOff(t.solarNoon, Date.UTC(2026, 8, 26, 16, 45))).toBeLessThan(12);
  });

  it('has no sunset under the midnight sun', () => {
    const t = sunTimes(Date.UTC(2026, 5, 21, 12), 78.22, 15.65); // Longyearbyen
    expect(t.sunset).toBeNull();
    expect(t.sunrise).toBeNull();
  });

  it('has no sunrise in polar night', () => {
    const t = sunTimes(Date.UTC(2026, 11, 21, 12), 78.22, 15.65);
    expect(t.sunrise).toBeNull();
    expect(t.sunset).toBeNull();
  });
});

describe('msUntilSunset', () => {
  it('counts down to this evening', () => {
    const now = Date.UTC(2024, 5, 21, 18, 21); // two hours before London sunset
    const left = msUntilSunset(now, 51.5074, -0.1278);
    expect(left).not.toBeNull();
    expect(Math.abs(left! - 2 * 60 * MIN) / MIN).toBeLessThan(4);
  });

  it('is null once the sun has set', () => {
    expect(msUntilSunset(Date.UTC(2024, 5, 21, 21, 30), 51.5074, -0.1278)).toBeNull();
  });

  it('is null under the midnight sun', () => {
    expect(msUntilSunset(Date.UTC(2026, 5, 21, 12), 78.22, 15.65)).toBeNull();
  });
});

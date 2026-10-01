import { qualifiesForHeat } from './qualify';

const track = (category: string | undefined, durationS: number) => ({
  category,
  stats: { durationS },
});

describe('qualifiesForHeat', () => {
  it('includes non-navigation categories regardless of timing', () => {
    expect(qualifiesForHeat(track('run', 0))).toBe(true);
    expect(qualifiesForHeat(track(undefined, 0))).toBe(true);
  });

  it('excludes untimed navigation trails', () => {
    expect(qualifiesForHeat(track('navigation', 0))).toBe(false);
  });

  it('includes navigation trails that have real timing data', () => {
    expect(qualifiesForHeat(track('navigation', 1))).toBe(true);
  });

  it('excludes routes drawn on the map, whatever their activity (#502)', () => {
    expect(
      qualifiesForHeat({ ...track('hike', 0), plan: { mode: 'freehand', vertices: [] } }),
    ).toBe(false);
  });
});

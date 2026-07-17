import { BACKGROUND_FEED_FRESH_MS, isBackgroundFeedFresh } from './backgroundFeed';

describe('isBackgroundFeedFresh', () => {
  const NOW = 1_700_000_000_000;

  it('is NOT fresh before the task has delivered anything', () => {
    // Regression: the v1.0.2 bug gated the foreground feed on "the start call
    // resolved" alone. A task that never delivers must never silence the
    // foreground watch.
    expect(isBackgroundFeedFresh(null, NOW)).toBe(false);
  });

  it('is fresh right after a delivery and within the freshness window', () => {
    expect(isBackgroundFeedFresh(NOW, NOW)).toBe(true);
    expect(isBackgroundFeedFresh(NOW - BACKGROUND_FEED_FRESH_MS, NOW)).toBe(true);
  });

  it('goes stale once deliveries stop', () => {
    expect(isBackgroundFeedFresh(NOW - BACKGROUND_FEED_FRESH_MS - 1, NOW)).toBe(false);
  });

  it('tolerates a small clock skew (delivery timestamped after "now")', () => {
    expect(isBackgroundFeedFresh(NOW + 500, NOW)).toBe(true);
  });

  it('honours a custom freshness window', () => {
    expect(isBackgroundFeedFresh(NOW - 3_000, NOW, 2_000)).toBe(false);
    expect(isBackgroundFeedFresh(NOW - 1_000, NOW, 2_000)).toBe(true);
  });
});

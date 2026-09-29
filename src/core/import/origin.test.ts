import {
  countBySource,
  isActivitySourceId,
  originKey,
  originKeys,
  sanitizeTrackOrigin,
  sourceLabel,
  tracksFromSource,
} from './origin';
import type { TrackOrigin } from './sources';

describe('sanitizeTrackOrigin', () => {
  it('keeps a well-formed origin', () => {
    expect(sanitizeTrackOrigin({ source: 'strava', externalId: '42' })).toEqual({
      source: 'strava',
      externalId: '42',
    });
    expect(sanitizeTrackOrigin({ source: 'apple-health', externalId: ' abc ' })).toEqual({
      source: 'apple-health',
      externalId: 'abc',
    });
  });

  it('accepts a numeric id (a hand-edited or older writer)', () => {
    expect(sanitizeTrackOrigin({ source: 'strava', externalId: 99 })).toEqual({
      source: 'strava',
      externalId: '99',
    });
  });

  it.each([
    undefined,
    null,
    'strava',
    [],
    {},
    { source: 'garmin', externalId: '1' },
    { source: 'strava' },
    { source: 'strava', externalId: '' },
    { source: 'strava', externalId: '   ' },
    { source: 'strava', externalId: Number.NaN },
    { source: 'strava', externalId: 'x'.repeat(201) },
    { source: 'health-connect', externalId: {} },
  ])('drops junk %p', (raw) => {
    expect(sanitizeTrackOrigin(raw)).toBeUndefined();
  });
});

describe('origin queries', () => {
  const s = (id: string): { origin: TrackOrigin } => ({
    origin: { source: 'strava', externalId: id },
  });
  const h = (id: string): { origin: TrackOrigin } => ({
    origin: { source: 'health-connect', externalId: id },
  });
  const tracks = [s('1'), {}, h('a'), s('2')];

  it('counts by source', () => {
    expect(countBySource(tracks)).toEqual({ strava: 2, 'health-connect': 1 });
    expect(countBySource([])).toEqual({});
  });

  it('filters by source', () => {
    expect(tracksFromSource(tracks, 'strava')).toEqual([s('1'), s('2')]);
    expect(tracksFromSource(tracks, 'apple-health')).toEqual([]);
  });

  it('keys origins', () => {
    expect(originKey({ source: 'strava', externalId: '1' })).toBe('strava:1');
    expect([...originKeys(tracks)].sort()).toEqual(['health-connect:a', 'strava:1', 'strava:2']);
  });

  it('labels sources and recognizes their ids', () => {
    expect(sourceLabel('strava')).toBe('Strava');
    expect(sourceLabel('apple-health')).toBe('Apple Health');
    expect(sourceLabel('health-connect')).toBe('Health Connect');
    expect(isActivitySourceId('strava')).toBe(true);
    expect(isActivitySourceId('garmin')).toBe(false);
    expect(isActivitySourceId(3)).toBe(false);
  });
});

import { offlinePackGroup, trailPackPrefix } from './packIds';

describe('trailPackPrefix', () => {
  it('names a stage, or the whole trail', () => {
    expect(trailPackPrefix('gr20', 2)).toBe('trail-gr20-s3-');
    expect(trailPackPrefix('gr20', null)).toBe('trail-gr20-all-');
  });
});

describe('offlinePackGroup', () => {
  it('groups the parts of one trail download under its prefix', () => {
    expect(offlinePackGroup('trail-gr20-s3-1')).toBe('trail-gr20-s3-');
    expect(offlinePackGroup('trail-gr20-s3-30')).toBe('trail-gr20-s3-');
    expect(offlinePackGroup('trail-sentier-des-caps-all-4')).toBe('trail-sentier-des-caps-all-');
  });

  it('leaves every other region its own group', () => {
    expect(offlinePackGroup('k3j2h1-map')).toBe('k3j2h1-map');
    expect(offlinePackGroup('trail-gr20-s3-')).toBe('trail-gr20-s3-');
    expect(offlinePackGroup('trail-x-2')).toBe('trail-x-2');
    expect(offlinePackGroup('mytrail-gr20-s3-1')).toBe('mytrail-gr20-s3-1');
  });
});

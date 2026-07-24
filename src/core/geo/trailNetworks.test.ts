import {
  isTrailNetworkId,
  sanitizeTrailNetworks,
  TRAIL_NETWORKS,
  trailNetworkTileUrl,
} from './trailNetworks';

describe('trailNetworks', () => {
  it('builds the Waymarked tile URL per network', () => {
    expect(trailNetworkTileUrl('hiking')).toBe(
      'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png',
    );
    expect(trailNetworkTileUrl('slopes')).toContain('/slopes/');
  });

  it('recognizes exactly the catalogued ids', () => {
    for (const n of TRAIL_NETWORKS) expect(isTrailNetworkId(n.id)).toBe(true);
    expect(isTrailNetworkId('driving')).toBe(false);
    expect(isTrailNetworkId(3)).toBe(false);
  });

  it('sanitizes persisted junk to valid ids only', () => {
    expect(sanitizeTrailNetworks(['hiking', 'nope', 7, 'mtb'])).toEqual(['hiking', 'mtb']);
    expect(sanitizeTrailNetworks('hiking')).toEqual([]);
    expect(sanitizeTrailNetworks(undefined)).toEqual([]);
  });
});

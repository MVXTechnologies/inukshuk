import type { Json } from '@core/team/canonical';

import { parseWaypoint, waypointFields } from './shares';

/**
 * #675 — a shared waypoint carries its pin style, and 2.5.0 peers (which know
 * twelve icons and no colour or size) keep working in both directions.
 */
const T0 = 1_760_000_000_000;

/** What a 2.5.0 peer wrote: `ic` only, from its twelve icons. */
const OLD_PEER_FIELDS: Record<string, Json> = {
  n: 'Source',
  la: 46.81,
  lo: -71.21,
  by: 'old',
  at: T0,
  ic: 'water',
};

/** A 2.5.0 peer's waypoint parser, as it shipped (its own twelve-icon list). */
const OLD_ICONS = [
  'camp',
  'shelter',
  'water',
  'food',
  'trailhead',
  'parking',
  'summit',
  'viewpoint',
  'ford',
  'gate',
  'cache',
  'hazard',
];
function parseAsOldPeer(f: Record<string, Json>) {
  const icon = f['ic'];
  return {
    name: typeof f['n'] === 'string' ? f['n'] : 'Waypoint',
    lat: f['la'],
    lon: f['lo'],
    icon: typeof icon === 'string' && OLD_ICONS.includes(icon) ? icon : null,
  };
}

describe('team shares carry the pin style (#675)', () => {
  it('round-trips icon, colour and size', () => {
    const f = waypointFields(
      {
        latitude: 46.8,
        longitude: -71.2,
        label: 'Camp lac',
        icon: 'campfire',
        color: '#e8612c',
        size: 'L',
      },
      'me',
      T0,
    );
    expect(f).toMatchObject({ ic: 'campfire', co: '#E8612C', sz: 'L' });
    expect(parseWaypoint('w1', f)).toMatchObject({
      icon: 'campfire',
      color: '#E8612C',
      size: 'L',
    });
  });

  it('writes no style fields for a plain pin', () => {
    const f = waypointFields({ latitude: 46.8, longitude: -71.2, label: 'Plain' }, 'me', T0);
    expect(Object.keys(f).sort()).toEqual(['at', 'by', 'la', 'lo', 'n']);
  });

  it('reads a 2.5.0 peer’s share as the default colour and size', () => {
    expect(parseWaypoint('w', OLD_PEER_FIELDS)).toMatchObject({
      icon: 'water',
      color: null,
      size: null,
    });
  });

  it('lets a 2.5.0 peer read a new share: same place and name, a legacy icon kept', () => {
    const legacy = waypointFields(
      { latitude: 46.8, longitude: -71.2, label: 'Hut', icon: 'shelter', color: '#1E64C8' },
      'me',
      T0,
    );
    expect(parseAsOldPeer(legacy)).toEqual({ name: 'Hut', lat: 46.8, lon: -71.2, icon: 'shelter' });
    const fresh = waypointFields(
      { latitude: 46.8, longitude: -71.2, label: 'Fire', icon: 'campfire', size: 'XL' },
      'me',
      T0,
    );
    // An icon it does not know is its default pin, never a failure.
    expect(parseAsOldPeer(fresh)).toEqual({ name: 'Fire', lat: 46.8, lon: -71.2, icon: null });
  });

  it('drops junk style fields', () => {
    const w = parseWaypoint('w', { ...OLD_PEER_FIELDS, co: 'red', sz: 'XXL', ic: 42 });
    expect(w).toMatchObject({ icon: null, color: null, size: null });
  });
});

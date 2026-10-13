import { buildGpx, parseGpx } from '@core/geo/gpx';

import { WAYPOINT_ICONS } from './waypointIcons';
import { waypointFromGpx, waypointToGpx, type GpxWaypointFields } from './waypointGpx';

const roundTrip = (w: GpxWaypointFields): { xml: string; back: GpxWaypointFields } => {
  const xml = buildGpx({ points: [], waypoints: [waypointToGpx(w)] });
  const [read] = parseGpx(xml).waypoints;
  if (!read) throw new Error('no <wpt> read back');
  return { xml, back: waypointFromGpx(read, 'Waypoint') };
};

describe('waypoint ↔ GPX (#675)', () => {
  it('round-trips a styled pin through <sym> and the pin:style extension', () => {
    const w: GpxWaypointFields = {
      latitude: 46.8139,
      longitude: -71.2082,
      label: 'Camp lac',
      note: 'Sandy beach',
      icon: 'campfire',
      color: '#E8612C',
      size: 'L',
    };
    const { xml, back } = roundTrip(w);
    expect(xml).toContain('xmlns:pin="urn:inukshuk:pin:1"');
    expect(xml).toContain('<sym>Campfire</sym>');
    expect(xml).toContain('<pin:icon>campfire</pin:icon>');
    expect(xml).toContain('<pin:color>#E8612C</pin:color>');
    expect(xml).toContain('<pin:size>L</pin:size>');
    expect(back).toEqual(w);
  });

  it('keeps the #350 <sym> spellings for the twelve original icons', () => {
    const { xml, back } = roundTrip({
      latitude: 46.8,
      longitude: -71.2,
      label: 'Source',
      icon: 'water',
    });
    expect(xml).toContain('<sym>Drinking Water</sym>');
    expect(back.icon).toBe('water');
  });

  it('round-trips every catalogue icon', () => {
    // Exhaustive on purpose: an id that cannot come back is a silently lost pin.
    for (const spec of WAYPOINT_ICONS) {
      const { back } = roundTrip({ latitude: 1, longitude: 2, label: spec.label, icon: spec.id });
      expect([spec.id, back.icon]).toEqual([spec.id, spec.id]);
    }
  });

  it('writes no extension (and no namespace) for a plain pin', () => {
    const { xml, back } = roundTrip({ latitude: 46.8, longitude: -71.2, label: 'Waypoint 3' });
    expect(xml).not.toContain('pin:');
    expect(xml).not.toContain('<sym>');
    expect(back).toEqual({ latitude: 46.8, longitude: -71.2, label: 'Waypoint 3' });
  });

  it('reads <sym> alone (a 2.5.0 or foreign file) and ignores an unknown extension icon', () => {
    const xml = `<?xml version="1.0"?>
      <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:pin="urn:inukshuk:pin:1">
        <wpt lat="46.81" lon="-71.21"><name>Hut</name><sym>Lodging</sym>
          <extensions><pin:style><pin:icon>from-the-future</pin:icon><pin:color>junk</pin:color><pin:size>XXL</pin:size></pin:style></extensions>
        </wpt>
        <wpt lat="46.82" lon="-71.22"><sym>Campground</sym></wpt>
      </gpx>`;
    const [hut, camp] = parseGpx(xml).waypoints;
    expect(hut && waypointFromGpx(hut, 'Waypoint')).toEqual({
      latitude: 46.81,
      longitude: -71.21,
      label: 'Hut',
      icon: 'shelter',
    });
    expect(camp && waypointFromGpx(camp, 'Waypoint 9')).toMatchObject({
      label: 'Waypoint 9',
      icon: 'camp',
    });
  });

  it('lowercase colours come back upper case', () => {
    const { back } = roundTrip({ latitude: 1, longitude: 2, label: 'x', color: '#1e64c8' });
    expect(back.color).toBe('#1E64C8');
  });
});

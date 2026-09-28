import { buildGpx, parseGpx } from '@core/geo/gpx';
import type { WaypointIcon } from '@core/models';
import {
  DEFAULT_WAYPOINT_ICON_LABEL,
  WAYPOINT_ICONS,
  gpxSymForWaypointIcon,
  isWaypointIcon,
  waypointIconForGpxSym,
  waypointIconGlyph,
  waypointIconLabel,
  waypointIconSpec,
} from './waypointIcons';

describe('the waypoint icon catalogue', () => {
  it('offers the outdoor set the picker promises, each with a glyph and a <sym>', () => {
    expect(WAYPOINT_ICONS.map((s) => s.id)).toEqual([
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
    ]);
    for (const spec of WAYPOINT_ICONS) {
      expect(spec.label).not.toBe('');
      expect(spec.glyph).not.toBe('');
      expect(spec.sym).not.toBe('');
    }
  });

  it('lists every icon exactly once', () => {
    const ids = WAYPOINT_ICONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every icon its own glyph and its own <sym>', () => {
    expect(new Set(WAYPOINT_ICONS.map((s) => s.glyph)).size).toBe(WAYPOINT_ICONS.length);
    expect(new Set(WAYPOINT_ICONS.map((s) => s.sym.toLowerCase())).size).toBe(
      WAYPOINT_ICONS.length,
    );
  });

  it('never lets one <sym> alias claim two icons', () => {
    const claimed = new Map<string, WaypointIcon>();
    for (const spec of WAYPOINT_ICONS) {
      for (const alias of [spec.sym, ...(spec.symAliases ?? [])]) {
        const key = alias.toLowerCase();
        expect(claimed.get(key) ?? spec.id).toBe(spec.id);
        claimed.set(key, spec.id);
      }
    }
  });
});

describe('isWaypointIcon', () => {
  it('accepts a catalogue id', () => {
    expect(isWaypointIcon('camp')).toBe(true);
  });

  it('rejects an unknown id, and anything that is not a string', () => {
    for (const junk of ['', 'unicorn', 'Camp', 42, null, undefined, {}, ['camp']]) {
      expect(isWaypointIcon(junk)).toBe(false);
    }
  });

  it('rejects inherited Object properties, which a raw parsed JSON value can name', () => {
    expect(isWaypointIcon('toString')).toBe(false);
    expect(isWaypointIcon('constructor')).toBe(false);
  });
});

describe('waypointIconSpec / glyph / label', () => {
  it('describes a known icon', () => {
    expect(waypointIconSpec('summit')).toMatchObject({ id: 'summit', label: 'Summit' });
    expect(waypointIconGlyph('camp')).toBe('tent');
    expect(waypointIconLabel('hazard')).toBe('Hazard');
  });

  it('falls back to the default pin for a waypoint with no icon', () => {
    expect(waypointIconSpec(undefined)).toBeNull();
    expect(waypointIconGlyph(undefined)).toBeNull();
    expect(waypointIconLabel(undefined)).toBe(DEFAULT_WAYPOINT_ICON_LABEL);
  });

  it('falls back to the default pin for an icon a newer build wrote (downgrade)', () => {
    const fromTheFuture = 'zipline' as WaypointIcon;
    expect(waypointIconSpec(fromTheFuture)).toBeNull();
    expect(waypointIconGlyph(fromTheFuture)).toBeNull();
    expect(waypointIconLabel(fromTheFuture)).toBe(DEFAULT_WAYPOINT_ICON_LABEL);
  });
});

describe('GPX <sym> mapping', () => {
  it('writes the catalogue symbol for an icon', () => {
    expect(gpxSymForWaypointIcon('camp')).toBe('Campground');
    expect(gpxSymForWaypointIcon('trailhead')).toBe('Trail Head');
  });

  it('writes NO symbol for a waypoint with no icon', () => {
    expect(gpxSymForWaypointIcon(undefined)).toBeUndefined();
  });

  it('reads a symbol this app wrote back to the same icon (round trip)', () => {
    for (const spec of WAYPOINT_ICONS) {
      expect(waypointIconForGpxSym(gpxSymForWaypointIcon(spec.id))).toBe(spec.id);
    }
  });

  it('reads the spellings other apps write: case, underscores and hyphens', () => {
    expect(waypointIconForGpxSym('trail head')).toBe('trailhead');
    expect(waypointIconForGpxSym('TRAIL_HEAD')).toBe('trailhead');
    expect(waypointIconForGpxSym('Trail-Head')).toBe('trailhead');
    expect(waypointIconForGpxSym('  Drinking   Water  ')).toBe('water');
    expect(waypointIconForGpxSym('tourism_camp_site')).toBe('camp');
  });

  it('reads an unknown <sym> as the default pin rather than failing', () => {
    expect(waypointIconForGpxSym('Flag, Blue')).toBeUndefined();
    expect(waypointIconForGpxSym('Navaid, Red')).toBeUndefined();
    expect(waypointIconForGpxSym('')).toBeUndefined();
    expect(waypointIconForGpxSym('   ')).toBeUndefined();
  });

  it('reads a missing <sym> as the default pin', () => {
    expect(waypointIconForGpxSym(undefined)).toBeUndefined();
    expect(waypointIconForGpxSym(null)).toBeUndefined();
  });

  it('cannot be tricked into an icon by an inherited Object property name', () => {
    expect(waypointIconForGpxSym('constructor')).toBeUndefined();
    expect(waypointIconForGpxSym('hasOwnProperty')).toBeUndefined();
  });
});

describe('an icon through a real GPX file', () => {
  // What an exporter does with a waypoint, in the three lines it takes: the
  // icon becomes `<sym>`, and an iconless waypoint emits no `<sym>` at all.
  const toWpt = (w: {
    latitude: number;
    longitude: number;
    label: string;
    icon?: WaypointIcon;
  }) => {
    const symbol = gpxSymForWaypointIcon(w.icon);
    return {
      latitude: w.latitude,
      longitude: w.longitude,
      name: w.label,
      ...(symbol !== undefined ? { symbol } : {}),
    };
  };

  it('survives buildGpx → parseGpx as <sym>', () => {
    const xml = buildGpx({
      points: [],
      waypoints: [toWpt({ latitude: 46.81, longitude: -71.21, label: 'Source', icon: 'water' })],
    });
    expect(xml).toContain('<sym>Drinking Water</sym>');
    const [read] = parseGpx(xml).waypoints;
    expect(waypointIconForGpxSym(read?.symbol)).toBe('water');
  });

  it('writes no <sym> for a waypoint with no icon, and reads it back as the default pin', () => {
    const xml = buildGpx({
      points: [],
      waypoints: [toWpt({ latitude: 46.81, longitude: -71.21, label: 'Waypoint 1' })],
    });
    expect(xml).not.toContain('<sym>');
    const [read] = parseGpx(xml).waypoints;
    expect(read?.symbol).toBeUndefined();
    expect(waypointIconForGpxSym(read?.symbol)).toBeUndefined();
  });

  it('reads a foreign <sym> the catalogue has no icon for as the default pin', () => {
    const xml = `<?xml version="1.0"?>
      <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
        <wpt lat="46.81" lon="-71.21"><name>Buoy</name><sym>Navaid, Green</sym></wpt>
      </gpx>`;
    const [read] = parseGpx(xml).waypoints;
    expect(read?.symbol).toBe('Navaid, Green');
    expect(waypointIconForGpxSym(read?.symbol)).toBeUndefined();
  });
});

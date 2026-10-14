import { parseGpx } from '@core/geo/gpx';
import type { Area, Waypoint } from '@core/models';
import { XMLParser } from 'fast-xml-parser';

import { INUKSHUK_AREA_NS, waypointsGpx } from './shareGpx';

const waypoint: Waypoint = {
  id: 'w1',
  label: 'Refuge <du> Mont-Albert & co',
  note: 'Water at the spring',
  latitude: 48.92131234,
  longitude: -66.18789876,
  createdAt: Date.UTC(2026, 8, 21, 12),
};
const area: Area = {
  id: 'a1',
  name: 'Blueberry slope',
  ring: [
    [-71.2, 46.8],
    [-71.19, 46.8],
    [-71.19, 46.81],
  ],
  color: '#2563EB',
  note: 'Mid-August',
  tags: ['Berries', 'Private'],
  createdAt: 1,
};

describe('waypointsGpx', () => {
  it('writes waypoints any GPX reader understands, escaped', () => {
    const xml = waypointsGpx([waypoint], []);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).not.toContain('xmlns:inukshuk');
    const doc = parseGpx(xml);
    expect(doc.metadata.name).toBe('Waypoints');
    expect(doc.waypoints).toEqual([
      {
        latitude: 48.9213123,
        longitude: -66.1878988,
        name: 'Refuge <du> Mont-Albert & co',
        description: 'Water at the spring',
        time: Date.UTC(2026, 8, 21, 12),
      },
    ]);
  });

  it('carries areas as closed polygons in its own extension namespace', () => {
    const xml = waypointsGpx([], [area], 'Blueberry slope');
    expect(xml).toContain(`xmlns:inukshuk="${INUKSHUK_AREA_NS}"`);
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml);
    const node = parsed.gpx.extensions['inukshuk:area'];
    expect(node['inukshuk:name']).toBe('Blueberry slope');
    expect(node['inukshuk:color']).toBe('#2563EB');
    expect(node['inukshuk:note']).toBe('Mid-August');
    expect(node['inukshuk:tag']).toEqual(['Berries', 'Private']);
    const pts = node['inukshuk:polygon']['inukshuk:pt'];
    expect(pts).toHaveLength(4);
    expect(pts[0]).toEqual(pts[3]);
    expect(pts[1]).toEqual({ lat: '46.8', lon: '-71.19' });
    expect(parsed.gpx.metadata.name).toBe('Blueberry slope');
    expect(parsed.gpx.wpt).toBeUndefined();
  });

  it('leaves out empty notes and a degenerate ring', () => {
    const bare = waypointsGpx(
      [{ ...waypoint, note: '  ', createdAt: 0 }],
      [{ ...area, note: ' ', tags: [], ring: [] }],
    );
    expect(bare).not.toContain('<desc>');
    expect(bare).not.toContain('<time>');
    expect(bare).not.toContain('inukshuk:note');
    expect(bare).not.toContain('inukshuk:tag');
    expect(bare).not.toContain('inukshuk:pt');
  });
});

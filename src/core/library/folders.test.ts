import type { Folder, MapDocument, TrackSummary, Waypoint } from '@core/models';

import { folderItemCount, groupByFolder } from './folders';

const folder = (id: string, name: string): Folder => ({ id, name, createdAt: 0 });

const map = (id: string, folderId?: string): MapDocument =>
  ({
    id,
    name: `map-${id}`,
    fileUri: `file:///maps/${id}.pdf`,
    importedAt: 0,
    pageCount: 1,
    georeferences: [],
    activePages: [],
    folderId,
  }) as MapDocument;

const wp = (id: string, folderId?: string): Waypoint => ({
  id,
  latitude: 46,
  longitude: -71,
  label: `wp-${id}`,
  createdAt: 0,
  ...(folderId !== undefined ? { folderId } : {}),
});

const track = (id: string, folderId?: string): TrackSummary =>
  ({
    id,
    name: `track-${id}`,
    startedAt: 0,
    stats: {
      distanceM: 0,
      ascentM: 0,
      descentM: 0,
      durationS: 0,
      movingTimeS: 0,
      avgSpeedMps: 0,
      maxSpeedMps: 0,
      pointCount: 0,
    },
    fileUri: `file:///tracks/${id}.gpx`,
    folderId,
  }) as TrackSummary;

describe('groupByFolder', () => {
  it('buckets maps and trails into their folders, in folders order', () => {
    const folders = [folder('A', 'Alpha'), folder('B', 'Bravo')];
    const maps = [map('m1', 'B'), map('m2', 'A')];
    const tracks = [track('t1', 'A'), track('t2', 'B')];

    const { groups } = groupByFolder(folders, maps, tracks, []);

    expect(groups.map((g) => g.folder.id)).toEqual(['A', 'B']); // folders order, not item order
    expect(groups[0]!.maps.map((m) => m.id)).toEqual(['m2']);
    expect(groups[0]!.tracks.map((t) => t.id)).toEqual(['t1']);
    expect(groups[1]!.maps.map((m) => m.id)).toEqual(['m1']);
    expect(groups[1]!.tracks.map((t) => t.id)).toEqual(['t2']);
  });

  it('sends items with no folderId to the ungrouped leftovers, preserving order', () => {
    const { groups, ungroupedMaps, ungroupedTracks, ungroupedWaypoints } = groupByFolder(
      [folder('A', 'Alpha')],
      [map('m1'), map('m2', 'A'), map('m3')],
      [track('t1')],
      [wp('w1'), wp('w2', 'A')],
    );
    expect(groups[0]!.maps.map((m) => m.id)).toEqual(['m2']);
    expect(ungroupedMaps.map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(ungroupedTracks.map((t) => t.id)).toEqual(['t1']);
    expect(groups[0]!.waypoints.map((w) => w.id)).toEqual(['w2']);
    expect(ungroupedWaypoints.map((w) => w.id)).toEqual(['w1']);
  });

  it('treats a dangling folderId (deleted folder) as ungrouped', () => {
    const { groups, ungroupedMaps } = groupByFolder(
      [folder('A', 'Alpha')],
      [map('m1', 'GONE')],
      [],
      [],
    );
    expect(groups[0]!.maps).toHaveLength(0);
    expect(ungroupedMaps.map((m) => m.id)).toEqual(['m1']);
  });

  it('keeps empty folders as empty groups', () => {
    const { groups } = groupByFolder([folder('A', 'Alpha'), folder('B', 'Bravo')], [], [], []);
    expect(groups).toHaveLength(2);
    expect(folderItemCount(groups[0]!)).toBe(0);
    expect(folderItemCount(groups[1]!)).toBe(0);
  });

  it('counts maps + trails + waypoints together', () => {
    const { groups } = groupByFolder(
      [folder('A', 'Alpha')],
      [map('m1', 'A')],
      [track('t1', 'A'), track('t2', 'A')],
      [wp('w1', 'A')],
    );
    expect(folderItemCount(groups[0]!)).toBe(4);
  });
});

/**
 * Generic over the trail type, so a caller with a richer trail (the web
 * playground's `WebTrack` adds a preview polyline and a colour) reads its own
 * fields straight off the grouping instead of re-resolving every element
 * through an id map.
 */
describe('groupByFolder (widened trail types)', () => {
  interface RichTrack extends TrackSummary {
    color: string;
  }
  const richTrack = (id: string, folderId?: string): RichTrack => ({
    ...track(id, folderId),
    color: `#${id}`,
  });

  it('flows the caller trail type into groups and leftovers', () => {
    const grouping = groupByFolder(
      [folder('A', 'Alpha')],
      [],
      [richTrack('t1', 'A'), richTrack('t2')],
      [],
    );
    // Both reads are typed RichTrack — no cast, no id map. They are the
    // assertion: with a widened return type neither line would compile.
    expect(grouping.groups[0]!.tracks.map((t) => t.color)).toEqual(['#t1']);
    expect(grouping.ungroupedTracks.map((t) => t.color)).toEqual(['#t2']);
  });

  it('still counts a widened group', () => {
    const { groups } = groupByFolder([folder('A', 'Alpha')], [], [richTrack('t1', 'A')], []);
    expect(folderItemCount(groups[0]!)).toBe(1);
  });
});

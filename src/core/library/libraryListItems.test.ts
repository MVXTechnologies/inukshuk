import type { Folder, MapDocument, TrackSummary, Waypoint } from '@core/models';

import { groupByFolder } from './folders';
import { libraryListItems, type LibraryListInput, type LibraryListItem } from './libraryListItems';

const track = (i: number, folderId?: string): TrackSummary => ({
  id: `t${i}`,
  name: `Run ${i}`,
  fileUri: `file:///t${i}.gpx`,
  startedAt: i,
  stats: {
    distanceM: 1,
    ascentM: 0,
    descentM: 0,
    durationS: 1,
    movingTimeS: 1,
    avgSpeedMps: 1,
    maxSpeedMps: 1,
    pointCount: 2,
  },
  ...(folderId ? { folderId } : {}),
});
const map = (id: string, folderId?: string) =>
  ({ id, name: id, ...(folderId ? { folderId } : {}) }) as unknown as MapDocument;
const waypoint = (id: string, folderId?: string) =>
  ({
    id,
    label: id,
    latitude: 0,
    longitude: 0,
    createdAt: 0,
    ...(folderId ? { folderId } : {}),
  }) as Waypoint;

function input(over: Partial<LibraryListInput> & { tracks?: TrackSummary[] } = {}) {
  const tracks = over.tracks ?? [];
  const maps = over.maps ?? [];
  const waypoints = [...(over.sortedWaypoints ?? [])];
  const folders: Folder[] = [];
  const grouped = over.grouped ?? groupByFolder(folders, [...maps], tracks, waypoints);
  const base: LibraryListInput = {
    maps,
    trackCount: tracks.length,
    visibleTracks: tracks,
    sortedWaypoints: waypoints,
    hasFolders: false,
    grouped,
    sortedFolderWaypoints: new Map(),
    sortedUngroupedWaypoints: grouped.ungroupedWaypoints,
    showMaps: true,
    showTrails: true,
    showWaypoints: true,
    effectiveType: 'all',
    organizing: false,
    collapsed: {},
    narrowed: false,
    searchText: null,
    activeFilterCount: 0,
  };
  return { ...base, ...over };
}

const shape = (items: LibraryListItem[]) =>
  items.map((i) =>
    i.kind === 'header'
      ? `# ${i.title} ${i.count}`.trim()
      : i.kind === 'empty'
        ? `~ ${i.title}`
        : i.kind === 'track'
          ? `${i.divider ? '-' : ''}track ${i.track.id}`
          : i.kind === 'map'
            ? `${i.divider ? '-' : ''}map ${i.map.id}`
            : `${i.divider ? '-' : ''}wp ${i.waypoint.id}`,
  );

describe('libraryListItems without folders', () => {
  it('lists Maps, Recorded trails and Waypoints with dividers between rows', () => {
    const items = libraryListItems(
      input({
        maps: [map('m1')],
        tracks: [track(1), track(2)],
        sortedWaypoints: [waypoint('w1')],
      }),
    );
    expect(shape(items)).toEqual([
      '# Maps (1)',
      'map m1',
      '# Recorded trails (2)',
      'track t1',
      '-track t2',
      '# Waypoints (1)',
      'wp w1',
    ]);
    expect(items.map((i) => i.key)).toEqual([...new Set(items.map((i) => i.key))]);
    expect(items[0]).toMatchObject({ kind: 'header', first: true, section: 'maps' });
    expect(items[2]).toMatchObject({ kind: 'header', first: false, section: 'trails' });
  });

  it('shows empty states and hides an empty Waypoints section', () => {
    expect(shape(libraryListItems(input()))).toEqual([
      '# Maps',
      '~ No maps yet',
      '# Recorded trails',
      '~ No trails yet',
    ]);
    expect(
      shape(
        libraryListItems(input({ effectiveType: 'waypoints', showMaps: false, showTrails: false })),
      ),
    ).toEqual(['# Waypoints', '~ No waypoints yet']);
  });

  it('says why a narrowed list is empty', () => {
    const tracks = [track(1)];
    const searched = libraryListItems(
      input({ tracks, visibleTracks: [], narrowed: true, searchText: 'zz', showMaps: false }),
    );
    expect(shape(searched)).toEqual(['# Recorded trails (0/1)', '~ No trails match “zz”']);
    expect(searched[1]).toMatchObject({ description: 'Try another word, or a folder name' });
    const both = libraryListItems(
      input({ tracks, visibleTracks: [], searchText: 'zz', activeFilterCount: 1, showMaps: false }),
    );
    expect(both[1]).toMatchObject({ description: 'Try another word, or clear the filters too' });
    expect(
      shape(
        libraryListItems(input({ tracks, visibleTracks: [], narrowed: true, showMaps: false })),
      ),
    ).toEqual(['# Recorded trails (0/1)', '~ No trails match the filters']);
  });

  it('builds no rows for a collapsed section', () => {
    const items = libraryListItems(
      input({ tracks: [track(1)], collapsed: { trails: true, maps: true } }),
    );
    expect(shape(items)).toEqual(['# Maps', '# Recorded trails (1)']);
  });

  it('holds one item per trail for a 2,000-trail library (no paging)', () => {
    const tracks = Array.from({ length: 2000 }, (_, i) => track(i));
    const items = libraryListItems(input({ tracks, showMaps: false }));
    expect(items).toHaveLength(2001);
  });
});

describe('libraryListItems with folders', () => {
  const folders: Folder[] = [
    { id: 'f1', name: 'Commutes', createdAt: 1 },
    { id: 'f2', name: 'Empty', createdAt: 2 },
  ];
  const tracks = [track(1, 'f1'), track(2), track(3, 'f1')];
  const maps = [map('m1', 'f1'), map('m2')];
  const waypoints = [waypoint('w1', 'f1')];
  const grouped = groupByFolder(folders, maps, tracks, waypoints);
  const folderInput = (over: Partial<LibraryListInput> = {}) =>
    input({
      tracks,
      maps,
      grouped,
      hasFolders: true,
      sortedFolderWaypoints: new Map(grouped.groups.map((g) => [g.folder.id, g.waypoints])),
      sortedUngroupedWaypoints: grouped.ungroupedWaypoints,
      ...over,
    });

  it('lists each folder (maps, trails, waypoints) then Ungrouped', () => {
    const items = libraryListItems(folderInput());
    expect(shape(items)).toEqual([
      '# Commutes (4)',
      'map m1',
      '-track t1',
      '-track t3',
      '-wp w1',
      '# Empty',
      '~ Empty folder',
      '# Ungrouped (2)',
      'map m2',
      '-track t2',
    ]);
    expect(items[0]).toMatchObject({ dropTarget: 'f1', folderId: 'f1', first: true });
    expect(items[7]).toMatchObject({ dropTarget: null, section: 'ungrouped' });
    expect(items.find((i) => i.kind === 'empty')).toMatchObject({
      description: 'Move items here from their ⋮ menu',
    });
  });

  it('steps a folder aside under a type chip unless organizing', () => {
    const trailsOnly = { effectiveType: 'trails' as const, showMaps: false, showWaypoints: false };
    expect(shape(libraryListItems(folderInput(trailsOnly)))).toEqual([
      '# Commutes (2)',
      'track t1',
      '-track t3',
      '# Ungrouped (1)',
      'track t2',
    ]);
    const organizing = libraryListItems(folderInput({ ...trailsOnly, organizing: true }));
    expect(shape(organizing)).toContain('~ Empty folder');
    expect(organizing.find((i) => i.kind === 'empty')).toMatchObject({
      description: "Drag an item's grip here, or use its ⋮ menu",
    });
  });

  it('collapses a folder to its header and adds one row for a fruitless search', () => {
    const items = libraryListItems(
      folderInput({
        visibleTracks: [],
        grouped: groupByFolder(folders, maps, [], waypoints),
        searchText: 'zz',
        collapsed: { 'folder:f1': true, ungrouped: true },
      }),
    );
    expect(shape(items)).toEqual([
      '~ No trails match “zz”',
      '# Commutes (2)',
      '# Empty',
      '~ Empty folder',
      '# Ungrouped (1)',
    ]);
  });
});

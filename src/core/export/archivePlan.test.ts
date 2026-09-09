import type { Folder, MapDocument, TrackStats, TrackSummary, Waypoint } from '@core/models';
import { dataArchiveName, describeDataArchive, planDataArchive } from './archivePlan';

const stats: TrackStats = {
  distanceM: 1000,
  ascentM: 10,
  descentM: 5,
  durationS: 600,
  movingTimeS: 500,
  avgSpeedMps: 1.6,
  maxSpeedMps: 3,
  pointCount: 100,
};

function track(partial: Partial<TrackSummary> & { id: string; fileUri: string }): TrackSummary {
  return { name: partial.id, startedAt: 0, stats, ...partial };
}

function map(partial: Partial<MapDocument> & { id: string; fileUri: string }): MapDocument {
  return {
    name: partial.id,
    importedAt: 0,
    pageCount: 1,
    georeferences: [],
    activePages: [],
    ...partial,
  };
}

function folder(id: string, name: string): Folder {
  return { id, name, createdAt: 0 };
}

function waypoint(partial: Partial<Waypoint> & { id: string }): Waypoint {
  return { label: partial.id, latitude: 0, longitude: 0, createdAt: 0, ...partial };
}

describe('dataArchiveName', () => {
  it('stamps the date with zero-padding', () => {
    expect(dataArchiveName(new Date(2026, 6, 4))).toBe('inukshuk-data-2026-07-04.zip');
    expect(dataArchiveName(new Date(2026, 11, 31))).toBe('inukshuk-data-2026-12-31.zip');
  });
});

describe('planDataArchive', () => {
  it('returns an empty plan for an empty library', () => {
    const plan = planDataArchive({ folders: [], maps: [], tracks: [], waypoints: [] });
    expect(plan.entries).toEqual([]);
    expect(plan.mapCount).toBe(0);
    expect(plan.trackCount).toBe(0);
    expect(plan.photoCount).toBe(0);
  });

  it('places ungrouped items at the archive root', () => {
    const plan = planDataArchive({
      folders: [],
      waypoints: [],
      maps: [map({ id: 'm1', name: 'Trail Map', fileUri: 'file:///maps/m1.pdf' })],
      tracks: [track({ id: 't1', name: 'Morning Hike', fileUri: 'file:///tracks/t1.gpx' })],
    });
    expect(plan.entries.map((e) => e.zipPath)).toEqual(['Trail_Map.pdf', 'Morning_Hike.gpx']);
    expect(plan.mapCount).toBe(1);
    expect(plan.trackCount).toBe(1);
  });

  it('mirrors folders as directories, in library order, maps before trails', () => {
    const plan = planDataArchive({
      folders: [folder('f1', 'Alps 2026'), folder('f2', 'Local')],
      waypoints: [],
      maps: [
        map({ id: 'm-loc', name: 'Town', fileUri: 'file:///maps/a.pdf', folderId: 'f2' }),
        map({ id: 'm-alp', name: 'Massif', fileUri: 'file:///maps/b.pdf', folderId: 'f1' }),
        map({ id: 'm-root', name: 'Loose', fileUri: 'file:///maps/c.pdf' }),
      ],
      tracks: [
        track({ id: 't-alp', name: 'Summit', fileUri: 'file:///tracks/a.gpx', folderId: 'f1' }),
        track({ id: 't-root', name: 'Stroll', fileUri: 'file:///tracks/b.gpx' }),
      ],
    });
    expect(plan.entries.map((e) => e.zipPath)).toEqual([
      'Alps_2026/Massif.pdf',
      'Alps_2026/Summit.gpx',
      'Local/Town.pdf',
      'Loose.pdf',
      'Stroll.gpx',
    ]);
  });

  it('drops items of a deleted folder back to the root, like the Library UI', () => {
    const plan = planDataArchive({
      folders: [],
      waypoints: [],
      tracks: [track({ id: 't1', fileUri: 'file:///t1.gpx', folderId: 'gone' })],
      maps: [],
    });
    expect(plan.entries.map((e) => e.zipPath)).toEqual(['t1.gpx']);
  });

  it('sanitizes weird characters in folder and item names', () => {
    const plan = planDataArchive({
      folders: [folder('f1', 'Côte/Nord: été')],
      waypoints: [],
      maps: [
        map({ id: 'm1', name: 'Carte *officielle*?', fileUri: 'file:///m.pdf', folderId: 'f1' }),
      ],
      tracks: [
        track({ id: 't1', name: '../..\\evil name', fileUri: 'file:///t.gpx', folderId: 'f1' }),
      ],
    });
    const paths = plan.entries.map((e) => e.zipPath);
    expect(paths).toEqual(['C_te_Nord_t_/Carte_officielle_.pdf', 'C_te_Nord_t_/_evil_name.gpx']);
    for (const p of paths) {
      expect(p).not.toMatch(/\.\./);
      expect(p.split('/').length).toBe(2); // no injected sub-directories
    }
  });

  it('dedupes colliding item names within a directory', () => {
    const plan = planDataArchive({
      folders: [folder('f1', 'Trips')],
      waypoints: [],
      maps: [],
      tracks: [
        track({ id: 'a', name: 'Hike', fileUri: 'file:///a.gpx', folderId: 'f1' }),
        track({ id: 'b', name: 'Hike', fileUri: 'file:///b.gpx', folderId: 'f1' }),
        track({ id: 'c', name: 'Hike', fileUri: 'file:///c.gpx' }),
      ],
    });
    expect(plan.entries.map((e) => e.zipPath)).toEqual([
      'Trips/Hike.gpx',
      'Trips/Hike-2.gpx',
      'Hike.gpx', // same name in a different directory does not collide
    ]);
  });

  it('dedupes folders that share a display name', () => {
    const plan = planDataArchive({
      folders: [folder('f1', 'Alps'), folder('f2', 'Alps')],
      waypoints: [],
      maps: [],
      tracks: [
        track({ id: 'a', name: 'One', fileUri: 'file:///a.gpx', folderId: 'f1' }),
        track({ id: 'b', name: 'Two', fileUri: 'file:///b.gpx', folderId: 'f2' }),
      ],
    });
    expect(plan.entries.map((e) => e.zipPath)).toEqual(['Alps/One.gpx', 'Alps-2/Two.gpx']);
  });

  it('never claims the reserved library.json root slot', () => {
    const plan = planDataArchive({
      folders: [],
      waypoints: [],
      maps: [],
      tracks: [track({ id: 't1', name: 'library.json', fileUri: 'file:///t.gpx' })],
    });
    // ".gpx" is appended (the name lacks it), so the reserved slot stays free.
    expect(plan.entries[0]?.zipPath).toBe('library.json.gpx');
  });

  it('keeps a map original extension and does not double an existing one', () => {
    const plan = planDataArchive({
      folders: [],
      waypoints: [],
      maps: [
        map({ id: 'm1', name: 'Scan.PDF', fileUri: 'file:///maps/m1.PDF' }),
        map({ id: 'm2', name: 'NoExt', fileUri: 'file:///maps/m2' }),
      ],
      tracks: [track({ id: 't1', name: 'Run.gpx', fileUri: 'file:///t1.gpx' })],
    });
    expect(plan.entries.map((e) => e.zipPath)).toEqual(['Scan.PDF', 'NoExt.pdf', 'Run.gpx']);
  });

  it('packs note photos under photos/ next to their trail, once per source uri', () => {
    const shared = 'file:///photos/p1.jpg';
    const plan = planDataArchive({
      folders: [folder('f1', 'Trips')],
      waypoints: [],
      maps: [],
      tracks: [
        track({
          id: 't1',
          name: 'Hike',
          fileUri: 'file:///t1.gpx',
          folderId: 'f1',
          notes: [
            { id: 'n1', distanceM: 0, text: 'a', createdAt: 0, photoUri: shared },
            { id: 'n2', distanceM: 5, text: 'b', createdAt: 0, photoUri: shared },
            { id: 'n3', distanceM: 9, text: 'c', createdAt: 0 },
          ],
        }),
        track({
          id: 't2',
          name: 'Walk',
          fileUri: 'file:///t2.gpx',
          notes: [
            { id: 'n4', distanceM: 1, text: 'd', createdAt: 0, photoUri: 'file:///photos/p2.png' },
          ],
        }),
      ],
    });
    expect(plan.entries.map((e) => e.zipPath)).toEqual([
      'Trips/Hike.gpx',
      'Trips/photos/p1.jpg',
      'Walk.gpx',
      'photos/p2.png',
    ]);
    expect(plan.photoCount).toBe(2);
  });

  it('packs a source uri referenced by two items only once', () => {
    const plan = planDataArchive({
      folders: [],
      waypoints: [],
      maps: [],
      tracks: [
        track({ id: 'a', name: 'One', fileUri: 'file:///same.gpx' }),
        track({ id: 'b', name: 'Two', fileUri: 'file:///same.gpx' }),
      ],
    });
    expect(plan.entries).toHaveLength(1);
    expect(plan.trackCount).toBe(1);
  });

  it('deflates GPX but stores maps and photos uncompressed', () => {
    const plan = planDataArchive({
      folders: [],
      waypoints: [],
      maps: [map({ id: 'm1', fileUri: 'file:///m1.pdf' })],
      tracks: [
        track({
          id: 't1',
          fileUri: 'file:///t1.gpx',
          notes: [{ id: 'n1', distanceM: 0, text: '', createdAt: 0, photoUri: 'file:///p.jpg' }],
        }),
      ],
    });
    const byKind = Object.fromEntries(plan.entries.map((e) => [e.kind, e.deflate]));
    expect(byKind).toEqual({ map: false, gpx: true, photo: false });
  });

  it('is deterministic for the same input', () => {
    const input = {
      folders: [folder('f1', 'Alps')],
      waypoints: [],
      maps: [map({ id: 'm1', fileUri: 'file:///m1.pdf', folderId: 'f1' })],
      tracks: [track({ id: 't1', fileUri: 'file:///t1.gpx' })],
    };
    expect(planDataArchive(input)).toEqual(planDataArchive(input));
  });
});

describe('planDataArchive — standalone waypoints (#288)', () => {
  it('packs waypoint photos under photos/ for a waypoint-only library', () => {
    const plan = planDataArchive({
      folders: [folder('f1', 'Trips')],
      maps: [],
      tracks: [],
      waypoints: [
        waypoint({ id: 'w1', folderId: 'f1', photoUri: 'file:///photos/w1.jpg' }),
        waypoint({ id: 'w2', photoUri: 'file:///photos/w2.jpg' }),
        waypoint({ id: 'w3' }), // no photo: index-only, still counted
      ],
    });
    expect(plan.entries.map((e) => e.zipPath)).toEqual(['Trips/photos/w1.jpg', 'photos/w2.jpg']);
    expect(plan.entries.every((e) => e.kind === 'photo' && !e.deflate)).toBe(true);
    expect(plan.waypointCount).toBe(3);
    expect(plan.photoCount).toBe(2);
    expect(plan.mapCount).toBe(0);
    expect(plan.trackCount).toBe(0);
  });

  it('counts photo-less waypoints so a waypoint-only library is not "empty"', () => {
    const plan = planDataArchive({
      folders: [],
      maps: [],
      tracks: [],
      waypoints: [waypoint({ id: 'w1' })],
    });
    expect(plan.entries).toEqual([]);
    expect(plan.waypointCount).toBe(1);
  });

  it('orders a mixed library maps, trails, then waypoints within each directory', () => {
    const plan = planDataArchive({
      folders: [folder('f1', 'Alps')],
      maps: [map({ id: 'm1', name: 'Massif', fileUri: 'file:///m1.pdf', folderId: 'f1' })],
      tracks: [
        track({
          id: 't1',
          name: 'Summit',
          fileUri: 'file:///t1.gpx',
          folderId: 'f1',
          notes: [{ id: 'n1', distanceM: 0, text: '', createdAt: 0, photoUri: 'file:///n1.jpg' }],
        }),
        track({ id: 't2', name: 'Stroll', fileUri: 'file:///t2.gpx' }),
      ],
      waypoints: [
        waypoint({ id: 'w-root', photoUri: 'file:///w-root.jpg' }),
        waypoint({ id: 'w-alp', folderId: 'f1', photoUri: 'file:///w-alp.jpg' }),
      ],
    });
    expect(plan.entries.map((e) => e.zipPath)).toEqual([
      'Alps/Massif.pdf',
      'Alps/Summit.gpx',
      'Alps/photos/n1.jpg',
      'Alps/photos/w-alp.jpg',
      'Stroll.gpx',
      'photos/w-root.jpg',
    ]);
    expect(plan).toMatchObject({ mapCount: 1, trackCount: 2, waypointCount: 2, photoCount: 3 });
  });

  it('packs a photo shared by waypoints and notes exactly once', () => {
    const shared = 'file:///photos/shared.jpg';
    const plan = planDataArchive({
      folders: [folder('f1', 'Trips')],
      maps: [],
      tracks: [
        track({
          id: 't1',
          name: 'Hike',
          fileUri: 'file:///t1.gpx',
          folderId: 'f1',
          notes: [{ id: 'n1', distanceM: 0, text: '', createdAt: 0, photoUri: shared }],
        }),
      ],
      waypoints: [
        waypoint({ id: 'w1', photoUri: shared }), // same file, different directory
        waypoint({ id: 'w2', photoUri: shared }),
        waypoint({ id: 'w3', photoUri: 'file:///photos/own.jpg' }),
      ],
    });
    expect(plan.entries.map((e) => e.zipPath)).toEqual([
      'Trips/Hike.gpx',
      'Trips/photos/shared.jpg',
      'photos/own.jpg',
    ]);
    expect(plan.photoCount).toBe(2);
    expect(plan.waypointCount).toBe(3);
  });

  it('dedupes colliding photo basenames from different source files', () => {
    const plan = planDataArchive({
      folders: [],
      maps: [],
      tracks: [],
      waypoints: [
        waypoint({ id: 'w1', photoUri: 'file:///a/photo.jpg' }),
        waypoint({ id: 'w2', photoUri: 'file:///b/photo.jpg' }),
      ],
    });
    expect(plan.entries.map((e) => e.zipPath)).toEqual(['photos/photo.jpg', 'photos/photo-2.jpg']);
    expect(plan.photoCount).toBe(2);
  });
});

describe('describeDataArchive', () => {
  const empty = { entries: [], mapCount: 0, trackCount: 0, waypointCount: 0, photoCount: 0 };
  const photo = {
    zipPath: 'photos/p.jpg',
    sourceUri: 'file:///p.jpg',
    kind: 'photo',
    deflate: false,
  } as const;

  it('never calls the archive un-exportable: an empty library still exports its index', () => {
    expect(describeDataArchive(empty, 0)).toBe('Your library is empty · exports the index only');
  });

  it('describes a waypoint-only library without a misleading 0 KB size', () => {
    expect(describeDataArchive({ ...empty, waypointCount: 2 }, 0)).toBe(
      '0 trails, 0 maps, 2 waypoints · index only',
    );
  });

  it('lists waypoints and photos when present, with the estimated zip size', () => {
    expect(
      describeDataArchive(
        { entries: [photo], mapCount: 1, trackCount: 2, waypointCount: 1, photoCount: 1 },
        2_500_000,
      ),
    ).toBe('2 trails, 1 map, 1 waypoint, 1 photo · ~3 MB zip');
  });
});

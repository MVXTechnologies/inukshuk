import type { Area, MapDocument, TrackSummary, Waypoint } from '@core/models';

import { removeItems, type LibraryIndexSlice } from './bulkEdits';
import {
  launchPurgePlan,
  pendingPurgeOf,
  sanitizePendingPurges,
  withoutPurge,
  type PendingPurge,
} from './pendingPurges';

const map = (id: string): MapDocument => ({
  id,
  name: id,
  fileUri: `file:///${id}.pdf`,
  importedAt: 1,
  pageCount: 1,
  georeferences: [],
  activePages: [],
});
const track = (id: string, photo?: string): TrackSummary =>
  ({
    id,
    name: id,
    fileUri: `file:///${id}.gpx`,
    startedAt: 1,
    stats: {},
    ...(photo
      ? { notes: [{ id: 'n', distanceM: 0, text: '', createdAt: 1, photoUri: photo }] }
      : {}),
  }) as TrackSummary;
const waypoint = (id: string, photoUri?: string): Waypoint => ({
  id,
  label: id,
  latitude: 47,
  longitude: -71,
  createdAt: 1,
  ...(photoUri ? { photoUri } : {}),
});
const area = (id: string, photoUris?: string[]): Area => ({
  id,
  name: id,
  ring: [
    [-71, 47],
    [-70, 47],
    [-70, 46],
  ],
  color: '#2563EB',
  createdAt: 1,
  ...(photoUris ? { photoUris } : {}),
});

const slice = (over: Partial<LibraryIndexSlice> = {}): LibraryIndexSlice => ({
  maps: [map('m1')],
  tracks: [track('t1', 'file:///p/t1.jpg'), track('t2')],
  waypoints: [waypoint('w1', 'file:///p/w1.jpg')],
  areas: [area('a1', ['file:///p/a1.jpg'])],
  folders: [],
  activeTrackIds: [],
  activeMapId: null,
  visibleFolderIds: [],
  ...over,
});

describe('pendingPurgeOf', () => {
  it('names every file of the delete and the trails whose photo folders go', () => {
    const { removed } = removeItems(slice(), [
      { kind: 'map', id: 'm1' },
      { kind: 'track', id: 't1' },
      { kind: 'waypoint', id: 'w1' },
      { kind: 'area', id: 'a1' },
    ]);
    expect(pendingPurgeOf('d1', removed)).toEqual({
      id: 'd1',
      fileUris: [
        'file:///m1.pdf',
        'file:///t1.gpx',
        'file:///p/t1.jpg',
        'file:///p/w1.jpg',
        'file:///p/a1.jpg',
      ],
      trackIds: ['t1'],
    });
  });
});

describe('withoutPurge', () => {
  const a: PendingPurge = { id: 'a', fileUris: ['x'], trackIds: [] };
  const b: PendingPurge = { id: 'b', fileUris: ['y'], trackIds: ['t'] };
  it('drops one entry, keeps the others', () => {
    expect(withoutPurge([a, b], 'a')).toEqual([b]);
    expect(withoutPurge([a, b], 'zz')).toEqual([a, b]);
  });
  it('an absent journal or id is an empty or unchanged journal', () => {
    expect(withoutPurge(undefined, 'a')).toEqual([]);
    expect(withoutPurge([a], undefined)).toEqual([a]);
  });
});

describe('sanitizePendingPurges', () => {
  it('keeps well-formed entries and drops junk, never throws', () => {
    expect(sanitizePendingPurges(null)).toEqual([]);
    expect(sanitizePendingPurges({ id: 'x' })).toEqual([]);
    expect(
      sanitizePendingPurges([
        null,
        7,
        { id: '' },
        { fileUris: ['a'] },
        { id: 'ok', fileUris: ['a', 3, '', 'b'], trackIds: 'nope' },
        { id: 'ok2', trackIds: ['t'] },
      ]),
    ).toEqual([
      { id: 'ok', fileUris: ['a', 'b'], trackIds: [] },
      { id: 'ok2', fileUris: [], trackIds: ['t'] },
    ]);
  });
});

describe('launchPurgePlan (a kill inside the Undo window)', () => {
  it('purges what the delete left, each file and folder once', () => {
    const { next, removed } = removeItems(slice(), [
      { kind: 'track', id: 't1' },
      { kind: 'waypoint', id: 'w1' },
    ]);
    const entry = pendingPurgeOf('d1', removed);
    expect(launchPurgePlan([entry, { ...entry, id: 'dup' }], next)).toEqual({
      fileUris: ['file:///t1.gpx', 'file:///p/t1.jpg', 'file:///p/w1.jpg'],
      trackIds: ['t1'],
    });
  });

  it('never touches a file or trail the live index names (a write that never landed)', () => {
    const s = slice();
    const { removed } = removeItems(s, [
      { kind: 'map', id: 'm1' },
      { kind: 'track', id: 't2' },
      { kind: 'area', id: 'a1' },
    ]);
    // The index on disk still holds everything: nothing may go.
    expect(launchPurgePlan([pendingPurgeOf('d1', removed)], s)).toEqual({
      fileUris: [],
      trackIds: [],
    });
  });

  it('an empty journal is nothing to do', () => {
    expect(launchPurgePlan([], slice())).toEqual({ fileUris: [], trackIds: [] });
  });
});

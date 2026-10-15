import type { Area, Folder, GeoReference, MapDocument, TrackSummary, Waypoint } from '@core/models';

import type { LibraryListItem } from './libraryListItems';
import {
  allInScopeSelected,
  canShowMap,
  folderActions,
  folderCounts,
  itemsPhrase,
  kindSummary,
  moveOptions,
  plannedMoves,
  refKey,
  resolveSelection,
  scopeRefs,
  selectAllInScope,
  selectionActions,
  selectionKeys,
  showTargets,
  toggleRef,
  undoMoves,
  type ItemRef,
} from './selection';

const geo: GeoReference = {
  pageIndex: 0,
  source: 'adobe-geo',
  pageWidthPt: 612,
  pageHeightPt: 792,
  viewport: {
    rect: { x0: 0, y0: 0, x1: 600, y1: 600 },
    corners: {
      topLeft: [-71.3, 46.9],
      topRight: [-71.1, 46.9],
      bottomRight: [-71.1, 46.7],
      bottomLeft: [-71.3, 46.7],
    },
  },
  bbox: { minLat: 46.7, minLng: -71.3, maxLat: 46.9, maxLng: -71.1 },
};

const map = (id: string, over: Partial<MapDocument> = {}): MapDocument => ({
  id,
  name: `Map ${id}`,
  fileUri: `file:///${id}.pdf`,
  importedAt: 1,
  pageCount: 1,
  georeferences: [geo],
  activePages: [],
  ...over,
});
const track = (id: string, over: Partial<TrackSummary> = {}): TrackSummary =>
  ({
    id,
    name: `Trail ${id}`,
    fileUri: `file:///${id}.gpx`,
    startedAt: 1,
    stats: {},
    ...over,
  }) as TrackSummary;
const waypoint = (id: string, over: Partial<Waypoint> = {}): Waypoint => ({
  id,
  label: `Waypoint ${id}`,
  latitude: 47,
  longitude: -71,
  createdAt: 1,
  ...over,
});
const area = (id: string, over: Partial<Area> = {}): Area => ({
  id,
  name: `Area ${id}`,
  ring: [
    [-71, 47],
    [-70, 47],
    [-70, 46],
  ],
  color: '#2563EB',
  createdAt: 1,
  ...over,
});

const M = (id: string): ItemRef => ({ kind: 'map', id });
const T = (id: string): ItemRef => ({ kind: 'track', id });
const W = (id: string): ItemRef => ({ kind: 'waypoint', id });
const A = (id: string): ItemRef => ({ kind: 'area', id });

describe('toggle and keys', () => {
  it('adds in selection order and removes on a second tap', () => {
    let sel = toggleRef([], T('a'));
    sel = toggleRef(sel, M('a')); // same id, another kind: a different item
    sel = toggleRef(sel, T('b'));
    expect(sel.map(refKey)).toEqual(['track:a', 'map:a', 'track:b']);
    expect(toggleRef(sel, T('a')).map(refKey)).toEqual(['map:a', 'track:b']);
    expect(selectionKeys(sel).has('map:a')).toBe(true);
    expect(selectionKeys(sel).has('waypoint:a')).toBe(false);
  });
});

describe('select all, scoped to what is in view', () => {
  const items: LibraryListItem[] = [
    { kind: 'header', key: 'h', section: 'maps', title: 'Maps', count: '(1)', first: true },
    { kind: 'map', key: 'map:m1', map: map('m1'), divider: false },
    { kind: 'track', key: 'track:t1', track: track('t1'), divider: true },
    { kind: 'empty', key: 'e', title: 'x', description: 'y' },
    { kind: 'waypoint', key: 'wp:w1', waypoint: waypoint('w1'), divider: false },
    { kind: 'area', key: 'area:a1', area: area('a1'), divider: false },
  ];

  it('takes the rows of the list, in display order, and nothing else', () => {
    expect(scopeRefs(items).map(refKey)).toEqual(['map:m1', 'track:t1', 'waypoint:w1', 'area:a1']);
  });

  it('adds the scope after what was selected, then deselects it all', () => {
    const scope = scopeRefs(items);
    const before = [T('elsewhere'), M('m1')];
    const all = selectAllInScope(before, scope);
    expect(all.map(refKey)).toEqual([
      'track:elsewhere',
      'map:m1',
      'track:t1',
      'waypoint:w1',
      'area:a1',
    ]);
    expect(allInScopeSelected(all, scope)).toBe(true);
    // A second tap is Deselect all: the scope goes, the rest stays.
    expect(selectAllInScope(all, scope).map(refKey)).toEqual(['track:elsewhere']);
  });

  it('an empty scope is never "all selected"', () => {
    expect(allInScopeSelected([T('a')], [])).toBe(false);
    expect(selectAllInScope([T('a')], [])).toEqual([T('a')]);
  });
});

describe('summaries', () => {
  it('reads kinds in a fixed order, singular and plural', () => {
    expect(kindSummary([T('1'), M('1'), M('2'), W('1'), T('2')])).toBe(
      '2 maps · 2 trails · 1 waypoint',
    );
    expect(kindSummary([A('1')])).toBe('1 area');
    expect(kindSummary([])).toBe('');
  });

  it('names one kind, and counts items when kinds mix', () => {
    expect(itemsPhrase([T('1'), T('2'), T('3')])).toBe('3 trails');
    expect(itemsPhrase([M('1')])).toBe('1 map');
    expect(itemsPhrase([M('1'), T('1'), W('1'), A('1'), T('2')])).toBe('5 items');
    expect(itemsPhrase([])).toBe('0 items');
  });
});

describe('resolveSelection', () => {
  it('keeps selection order per kind and drops refs whose item is gone', () => {
    const lib = {
      maps: [map('m1')],
      tracks: [track('t1'), track('t2')],
      waypoints: [waypoint('w1')],
      areas: [area('a1')],
    };
    const sel = resolveSelection([T('t2'), M('gone'), T('t1'), A('a1'), W('w1'), W('x')], lib);
    expect(sel.refs.map(refKey)).toEqual(['track:t2', 'track:t1', 'area:a1', 'waypoint:w1']);
    expect(sel.tracks.map((t) => t.id)).toEqual(['t2', 't1']);
    expect(sel.maps).toEqual([]);
  });
});

const resolve = (refs: ItemRef[], lib: Partial<Parameters<typeof resolveSelection>[1]>) =>
  resolveSelection(refs, { maps: [], tracks: [], waypoints: [], areas: [], ...lib });

describe('show on map', () => {
  it('a map shows when it has a drawable page', () => {
    expect(canShowMap(map('m'))).toBe(true);
    expect(canShowMap(map('m', { georeferences: [] }))).toBe(false);
  });

  it('acts on maps and trails; Hide only when every one is shown', () => {
    const sel = resolve([M('m1'), T('t1'), W('w1')], {
      maps: [map('m1', { activePages: [0] })],
      tracks: [track('t1')],
      waypoints: [waypoint('w1')],
    });
    expect(showTargets(sel, []).refs.map(refKey)).toEqual(['map:m1', 'track:t1']);
    expect(showTargets(sel, []).allShown).toBe(false);
    expect(showTargets(sel, ['t1']).allShown).toBe(true);
    expect(selectionActions(sel, ['t1']).show.label).toBe('Hide from map');
    expect(selectionActions(sel, []).show.label).toBe('Show on map');
  });

  it('is dimmed with a reason when nothing selected can be shown or hidden', () => {
    const pins = resolve([W('w1'), A('a1')], { waypoints: [waypoint('w1')], areas: [area('a1')] });
    expect(selectionActions(pins, []).show).toEqual({
      label: 'Show on map',
      enabled: false,
      reason: 'Waypoints and areas are always on the map.',
    });
    const unplaced = resolve([M('m1')], { maps: [map('m1', { georeferences: [] })] });
    expect(selectionActions(unplaced, []).show.reason).toBe(
      'This map cannot be placed on the map.',
    );
    const mixed = resolve([M('m1'), W('w1')], {
      maps: [map('m1', { georeferences: [] })],
      waypoints: [waypoint('w1')],
    });
    expect(selectionActions(mixed, []).show.reason).toMatch(/^Nothing selected can be shown/);
  });
});

describe('merge availability', () => {
  it('needs two or more trails and nothing else, and says why otherwise', () => {
    const lib = {
      maps: [map('m1'), map('m2')],
      tracks: [track('t1'), track('t2')],
      waypoints: [waypoint('w1')],
    };
    expect(selectionActions(resolve([T('t1'), T('t2')], lib), []).merge).toEqual({
      label: 'Merge',
      enabled: true,
      reason: null,
    });
    expect(selectionActions(resolve([T('t1')], lib), []).merge.reason).toBe(
      'Select 2 or more trails to merge them.',
    );
    expect(
      selectionActions(resolve([M('m1'), M('m2'), T('t1'), T('t2'), W('w1')], lib), []).merge
        .reason,
    ).toBe(
      'Merge joins trails only. This selection also has 2 maps and 1 waypoint. Select only trails to merge them.',
    );
    expect(
      selectionActions(resolve([M('m1'), W('w1'), T('t1')], { ...lib, areas: [area('a')] }), [])
        .merge.reason,
    ).toMatch(/also has 1 map and 1 waypoint\./);
  });

  it('move, share and delete always apply to a non-empty selection', () => {
    const a = selectionActions(resolve([W('w1')], { waypoints: [waypoint('w1')] }), []);
    expect([a.move.enabled, a.share.enabled, a.delete.enabled]).toEqual([true, true, true]);
    const none = selectionActions(resolve([], {}), []);
    expect(none.share.enabled).toBe(false);
    expect(none.delete.reason).toBe('Nothing is selected.');
    expect(none.show.reason).toBe('Nothing is selected.');
    expect(none.merge.enabled).toBe(false);
  });
});

describe('folder actions', () => {
  it('a folder with trails can be shared and shown', () => {
    const acts = folderActions({ maps: [], tracks: [track('t1')], waypoints: [], areas: [] }, [
      't1',
    ]);
    expect(acts.share).toEqual({ label: 'Share folder', enabled: true, reason: null });
    expect(acts.show.label).toBe('Hide from map');
    expect(acts.rename.enabled && acts.delete.enabled).toBe(true);
  });

  it('an empty folder dims Share and Show with the reason', () => {
    const acts = folderActions({ maps: [], tracks: [], waypoints: [], areas: [] }, []);
    expect(acts.share.reason).toBe('This folder is empty.');
    expect(acts.show.reason).toBe('This folder is empty.');
    const unplaced = folderActions(
      { maps: [map('m', { georeferences: [] })], tracks: [], waypoints: [], areas: [] },
      [],
    );
    expect(unplaced.show.reason).toMatch(/its maps cannot be placed/);
  });
});

describe('move to folder', () => {
  const folders: Folder[] = [
    { id: 'f1', name: 'Gaspésie 2026', createdAt: 1 },
    { id: 'f2', name: 'Charlevoix', createdAt: 2 },
  ];
  const lib = {
    maps: [map('m1', { folderId: 'f1' })],
    tracks: [track('t1', { folderId: 'f1' }), track('t2', { folderId: 'gone' }), track('t3')],
    waypoints: [waypoint('w1', { folderId: 'f2' })],
    areas: [area('a1', { folderId: 'f1' })],
  };

  it('counts every kind per folder', () => {
    const counts = folderCounts(lib);
    expect(counts.get('f1')).toBe(3);
    expect(counts.get('f2')).toBe(1);
    expect(counts.get('gone')).toBe(1);
  });

  it('marks the folder every selected item is in as current, and offers Remove when it applies', () => {
    const inF1 = resolve([M('m1'), T('t1'), A('a1')], lib);
    const opts = moveOptions(folders, inF1, folderCounts(lib));
    expect(opts.options.map((o) => [o.folder.name, o.count, o.current])).toEqual([
      ['Gaspésie 2026', 3, true],
      ['Charlevoix', 1, false],
    ]);
    expect(opts.canRemove).toBe(true);
    // An unknown folder id is Ungrouped: nothing to remove from.
    const loose = resolve([T('t2'), T('t3')], lib);
    expect(moveOptions(folders, loose, folderCounts(lib)).canRemove).toBe(false);
    expect(moveOptions(folders, loose, folderCounts(lib)).options.some((o) => o.current)).toBe(
      false,
    );
    expect(moveOptions(folders, resolve([], lib), new Map()).options[0]?.current).toBe(false);
  });

  it('plans only the items that change folder, and Undo sends each back to its own', () => {
    const sel = resolve([M('m1'), T('t2'), T('t3'), W('w1')], lib);
    const moves = plannedMoves(sel, 'f1', folders);
    expect(moves).toEqual([
      { ref: T('t2'), from: null, to: 'f1' },
      { ref: T('t3'), from: null, to: 'f1' },
      { ref: W('w1'), from: 'f2', to: 'f1' },
    ]);
    expect(undoMoves(moves)).toEqual([
      { ref: T('t2'), from: 'f1', to: null },
      { ref: T('t3'), from: 'f1', to: null },
      { ref: W('w1'), from: 'f1', to: 'f2' },
    ]);
    expect(plannedMoves(sel, null, folders).map((m) => refKey(m.ref))).toEqual([
      'map:m1',
      'waypoint:w1',
    ]);
  });
});

import type { Folder, MapDocument, TrackSummary } from '@core/models';

import { folderTree, groupByFolder } from './folders';
import { libraryListItems, type LibraryListInput } from './libraryListItems';

const f = (id: string, parentId?: string): Folder => ({
  id,
  name: id,
  createdAt: 1,
  ...(parentId !== undefined ? { parentId } : {}),
});

describe('folderTree (#712 sub-folders)', () => {
  it('orders parents before children, depth first, siblings as given', () => {
    const tree = folderTree([f('b'), f('a1', 'a'), f('a'), f('a1x', 'a1'), f('a2', 'a')]);
    expect(tree.map((n) => [n.folder.id, n.depth])).toEqual([
      ['b', 0],
      ['a', 0],
      ['a1', 1],
      ['a1x', 2],
      ['a2', 1],
    ]);
    expect(tree.find((n) => n.folder.id === 'a1x')!.ancestors).toEqual(['a1', 'a']);
  });

  it('a missing parent or a cycle puts a folder at the top level', () => {
    const tree = folderTree([f('x', 'gone'), f('c1', 'c2'), f('c2', 'c1')]);
    expect(tree.map((n) => [n.folder.id, n.depth]).sort()).toEqual([
      ['c1', 0],
      ['c2', 0],
      ['x', 0],
    ]);
  });

  it('the list indents sub-folders and a collapsed folder hides them', () => {
    const folders = [f('day', 'trip'), f('trip')];
    const input = (collapsed: Record<string, boolean>): LibraryListInput => ({
      maps: [] as MapDocument[],
      trackCount: 0,
      visibleTracks: [] as TrackSummary[],
      sortedWaypoints: [],
      hasFolders: true,
      grouped: groupByFolder(folders, [], [], []),
      sortedFolderWaypoints: new Map(),
      sortedUngroupedWaypoints: [],
      showMaps: true,
      showTrails: true,
      showWaypoints: true,
      effectiveType: 'all',
      organizing: false,
      collapsed,
      narrowed: false,
      searchText: null,
      activeFilterCount: 0,
    });
    const headers = (c: Record<string, boolean>) =>
      libraryListItems(input(c))
        .filter((i) => i.kind === 'header')
        .map((i) => (i.kind === 'header' ? [i.title, i.depth ?? 0] : []));
    expect(headers({})).toEqual([
      ['trip', 0],
      ['day', 1],
    ]);
    expect(headers({ 'folder:trip': true })).toEqual([['trip', 0]]);
  });
});

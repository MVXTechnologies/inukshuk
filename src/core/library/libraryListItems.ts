/**
 * The Library as one flat, virtualizable list (#494). The screen used to
 * render every section into a ScrollView and only page trail rows in, so a
 * long scroll ended with every row of a 2,000-trail library mounted. It now
 * hands this list to a FlatList, which mounts only the rows near the screen.
 *
 * One item per section header, empty-state row, map, trail and waypoint, in
 * display order. `divider` marks a row that follows another row of the same
 * section (the indented hairline goes above it). Built once per data or view
 * change — never per scroll.
 *
 * Pure.
 */

import type { Area, MapDocument, TrackSummary, Waypoint } from '@core/models';

import { folderItemCount, folderTree, type FolderGrouping } from './folders';
import type { LibraryTypeFilter } from './libraryRows';

export type LibraryListItem =
  | {
      kind: 'header';
      key: string;
      /** Collapse key (`folder:<id>`, `ungrouped`, `maps`, `trails`, `waypoints`). */
      section: string;
      title: string;
      count: string;
      first: boolean;
      /** Drop target for Organize-mode drags: a folder id, or null for Ungrouped. */
      dropTarget?: string | null;
      /** Set on a folder's header (its rename/delete actions). */
      folderId?: string;
      /** A sub-folder's depth (0 or absent: top level). */
      depth?: number;
    }
  | { kind: 'empty'; key: string; title: string; description: string }
  | { kind: 'map'; key: string; map: MapDocument; divider: boolean }
  | { kind: 'track'; key: string; track: TrackSummary; divider: boolean }
  | { kind: 'waypoint'; key: string; waypoint: Waypoint; divider: boolean }
  | { kind: 'area'; key: string; area: Area; divider: boolean };

export interface LibraryListInput {
  maps: readonly MapDocument[];
  /** Every trail (for the section's total). */
  trackCount: number;
  /** Trails after search/filter/source/sort. */
  visibleTracks: readonly TrackSummary[];
  /** Every waypoint, newest first (the flat Waypoints section). */
  sortedWaypoints: readonly Waypoint[];
  hasFolders: boolean;
  grouped: FolderGrouping;
  /** Folder id → its waypoints, newest first. */
  sortedFolderWaypoints: ReadonlyMap<string, readonly Waypoint[]>;
  sortedUngroupedWaypoints: readonly Waypoint[];
  showMaps: boolean;
  showTrails: boolean;
  showWaypoints: boolean;
  effectiveType: LibraryTypeFilter;
  organizing: boolean;
  /** Section key → collapsed. */
  collapsed: Readonly<Record<string, boolean>>;
  /** Search/filter/source narrowing in effect (the "(visible/total)" count). */
  narrowed: boolean;
  /** Trimmed search text when a search is active, else null. */
  searchText: string | null;
  activeFilterCount: number;
  /**
   * Drawn areas, newest first (#503): one "Areas" section at the end (with
   * folders, the unfiled ones; filed ones come from `grouped`).
   */
  sortedAreas?: readonly Area[];
  /** Whether the type chip shows areas (defaults to off when absent). */
  showAreas?: boolean;
}

type Row = Extract<LibraryListItem, { kind: 'map' | 'track' | 'waypoint' | 'area' }>;

function rows(
  maps: readonly MapDocument[],
  tracks: readonly TrackSummary[],
  waypoints: readonly Waypoint[],
  areas: readonly Area[] = [],
): Row[] {
  const out: Row[] = [];
  const divider = () => out.length > 0;
  for (const map of maps) out.push({ kind: 'map', key: `map:${map.id}`, map, divider: divider() });
  for (const track of tracks) {
    out.push({ kind: 'track', key: `track:${track.id}`, track, divider: divider() });
  }
  for (const waypoint of waypoints) {
    out.push({ kind: 'waypoint', key: `wp:${waypoint.id}`, waypoint, divider: divider() });
  }
  for (const area of areas) {
    out.push({ kind: 'area', key: `area:${area.id}`, area, divider: divider() });
  }
  return out;
}

const empty = (key: string, title: string, description: string): LibraryListItem => ({
  kind: 'empty',
  key: `empty:${key}`,
  title,
  description,
});

/** The Library's list items, in display order (see the module comment). */
export function libraryListItems(input: LibraryListInput): LibraryListItem[] {
  const items = input.hasFolders ? folderItems(input) : typeItems(input);
  return [...items, ...areaItems(input, items.length === 0)];
}

/**
 * Drawn areas (#503): their own section after everything else, in both
 * layouts. With folders, an area filed in one (#711) is listed in its folder
 * and this section holds the unfiled ones. Hidden while there are none,
 * unless the Areas chip asked for them; a trail search or filter is about
 * trails, so it stands the section down like it does Maps.
 */
function areaItems(input: LibraryListInput, first: boolean): LibraryListItem[] {
  if (!input.showAreas || input.narrowed) return [];
  const filed = input.hasFolders
    ? new Set(input.grouped.groups.flatMap((g) => g.areas.map((a) => a.id)))
    : null;
  const areas = (input.sortedAreas ?? []).filter((a) => filed === null || !filed.has(a.id));
  if (areas.length === 0 && input.effectiveType !== 'areas') return [];
  const items: LibraryListItem[] = [
    {
      kind: 'header',
      key: 'header:areas',
      section: 'areas',
      title: 'Areas',
      count: areas.length ? `(${areas.length})` : '',
      first,
    },
  ];
  if (input.collapsed.areas) return items;
  if (areas.length === 0) {
    items.push(empty('areas', 'No areas yet', 'Draw one on the map from its + sheet'));
    return items;
  }
  areas.forEach((area, i) => {
    items.push({ kind: 'area', key: `area:${area.id}`, area, divider: i > 0 });
  });
  return items;
}

/** Folders first (cross-type groups), then one "Ungrouped" catch-all. */
function folderItems(input: LibraryListInput): LibraryListItem[] {
  const { grouped, showMaps, showTrails, showWaypoints, effectiveType, organizing, collapsed } =
    input;
  const items: LibraryListItem[] = [];
  // The folder layout has no per-section empty state (each folder just lists
  // its matches), so a search that found nothing gets one row of its own.
  if (input.searchText !== null && input.visibleTracks.length === 0) {
    items.push(
      empty(
        'search',
        `No trails match “${input.searchText}”`,
        'Try another word, or a folder name',
      ),
    );
  }
  const nodes = folderTree(grouped.groups.map((g) => g.folder));
  const tree = new Map(nodes.map((n) => [n.folder.id, n]));
  const position = new Map(nodes.map((n, i) => [n.folder.id, i]));
  const order = [...grouped.groups].sort(
    (a, b) => (position.get(a.folder.id) ?? 0) - (position.get(b.folder.id) ?? 0),
  );
  order.forEach((g, index) => {
    const node = tree.get(g.folder.id);
    // A collapsed folder hides its sub-folders too.
    if (node?.ancestors.some((a) => collapsed[`folder:${a}`]) === true) return;
    const section = `folder:${g.folder.id}`;
    const folderWaypoints = showWaypoints
      ? (input.sortedFolderWaypoints.get(g.folder.id) ?? [])
      : [];
    // Like Maps, areas stand down while a trail search or filter narrows.
    const folderAreas = input.showAreas && !input.narrowed ? g.areas : [];
    const rowCount =
      (showMaps ? g.maps.length : 0) +
      (showTrails ? g.tracks.length : 0) +
      folderWaypoints.length +
      folderAreas.length;
    // Under a type chip, a folder holding none of that type steps aside.
    if (effectiveType !== 'all' && rowCount === 0 && !organizing) return;
    const count = effectiveType === 'all' ? folderItemCount(g) : rowCount;
    items.push({
      kind: 'header',
      key: `header:${section}`,
      section,
      title: g.folder.name,
      count: count ? `(${count})` : '',
      first: index === 0,
      dropTarget: g.folder.id,
      folderId: g.folder.id,
      ...(node !== undefined && node.depth > 0 ? { depth: node.depth } : {}),
    });
    if (collapsed[section]) return;
    if (rowCount === 0) {
      items.push(
        empty(
          section,
          'Empty folder',
          organizing
            ? "Drag an item's grip here, or use its ⋮ menu"
            : 'Move items here from their ⋮ menu',
        ),
      );
      return;
    }
    // Trail filters and trail search are about trails — maps drop out of
    // results while either narrowing is active (the caller's showMaps).
    items.push(
      ...rows(showMaps ? g.maps : [], showTrails ? g.tracks : [], folderWaypoints, folderAreas),
    );
  });

  const ungroupedMaps = showMaps ? grouped.ungroupedMaps : [];
  const ungroupedTracks = showTrails ? grouped.ungroupedTracks : [];
  const ungroupedWaypoints = showWaypoints ? input.sortedUngroupedWaypoints : [];
  const ungroupedCount = ungroupedMaps.length + ungroupedTracks.length + ungroupedWaypoints.length;
  if (ungroupedCount > 0) {
    items.push({
      kind: 'header',
      key: 'header:ungrouped',
      section: 'ungrouped',
      title: 'Ungrouped',
      count: `(${ungroupedCount})`,
      first: grouped.groups.length === 0,
      dropTarget: null,
    });
    if (!collapsed.ungrouped)
      items.push(...rows(ungroupedMaps, ungroupedTracks, ungroupedWaypoints));
  }
  return items;
}

/** No folders yet: the familiar Maps / Recorded trails / Waypoints split. */
function typeItems(input: LibraryListInput): LibraryListItem[] {
  const { maps, showMaps, showTrails, showWaypoints, collapsed, visibleTracks, trackCount } = input;
  const items: LibraryListItem[] = [];
  let first = true;
  const header = (section: string, title: string, count: string) => {
    items.push({ kind: 'header', key: `header:${section}`, section, title, count, first });
    first = false;
  };
  if (showMaps) {
    header('maps', 'Maps', maps.length ? `(${maps.length})` : '');
    if (!collapsed.maps) {
      if (maps.length === 0) {
        items.push(empty('maps', 'No maps yet', 'Import a PDF map with +, or find one in Explore'));
      } else items.push(...rows(maps, [], []));
    }
  }
  if (showTrails) {
    const count = trackCount
      ? input.narrowed
        ? `(${visibleTracks.length}/${trackCount})`
        : `(${trackCount})`
      : '';
    header('trails', 'Recorded trails', count);
    if (!collapsed.trails) {
      if (trackCount === 0) {
        items.push(
          empty('trails', 'No trails yet', 'Record one on the map, or import a GPX file with +'),
        );
      } else if (visibleTracks.length === 0) {
        // Two honest empty states, not one: a query that found nothing says
        // so, and quotes what was typed, instead of blaming filters the user
        // may not have set.
        items.push(
          input.searchText !== null
            ? empty(
                'trails',
                `No trails match “${input.searchText}”`,
                input.activeFilterCount > 0
                  ? 'Try another word, or clear the filters too'
                  : 'Try another word, or a folder name',
              )
            : empty(
                'trails',
                'No trails match the filters',
                'Adjust or clear the filters from the sort and filter button',
              ),
        );
      } else items.push(...rows([], visibleTracks, []));
    }
  }
  // Standalone waypoints (map "+" sheet). Hidden entirely while there are
  // none, unless the Waypoints chip asked for them.
  const waypoints = input.sortedWaypoints;
  if (showWaypoints && (waypoints.length > 0 || input.effectiveType === 'waypoints')) {
    header('waypoints', 'Waypoints', waypoints.length ? `(${waypoints.length})` : '');
    if (!collapsed.waypoints) {
      if (waypoints.length === 0) {
        items.push(empty('waypoints', 'No waypoints yet', 'Add one on the map from its + sheet'));
      } else items.push(...rows([], [], waypoints));
    }
  }
  return items;
}

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

import type { SavedCrag } from '@core/climbing/saved';
import type { Area, MapDocument, TrackSummary, Waypoint } from '@core/models';

import { folderItemCount, type FolderGrouping } from './folders';
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
    }
  | { kind: 'empty'; key: string; title: string; description: string }
  | { kind: 'map'; key: string; map: MapDocument; divider: boolean }
  | { kind: 'track'; key: string; track: TrackSummary; divider: boolean }
  | { kind: 'waypoint'; key: string; waypoint: Waypoint; divider: boolean }
  | { kind: 'area'; key: string; area: Area; divider: boolean }
  | { kind: 'crag'; key: string; crag: SavedCrag; divider: boolean };

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
  /** Drawn areas, newest first (#503) — one flat "Areas" section at the end. */
  sortedAreas?: readonly Area[];
  /** Whether the type chip shows areas (defaults to off when absent). */
  showAreas?: boolean;
  /** Saved crags, by name — the "Climbing" shelf (owner decision Q9-A). */
  crags?: readonly SavedCrag[];
  /** Whether the type chip shows the Climbing shelf (defaults to off when absent). */
  showClimbing?: boolean;
}

type Row = Extract<LibraryListItem, { kind: 'map' | 'track' | 'waypoint' }>;

function rows(
  maps: readonly MapDocument[],
  tracks: readonly TrackSummary[],
  waypoints: readonly Waypoint[],
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
  const areas = areaItems(input, items.length === 0);
  return [...items, ...areas, ...cragItems(input, items.length + areas.length === 0)];
}

/**
 * The Climbing shelf: crags saved for offline (Explore → Climbing), after
 * everything else, by name. Hidden while there are none, unless its chip
 * asked; a trail search or filter stands it down like Maps.
 */
function cragItems(input: LibraryListInput, first: boolean): LibraryListItem[] {
  const crags = [...(input.crags ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (!input.showClimbing || input.narrowed) return [];
  if (crags.length === 0 && input.effectiveType !== 'climbing') return [];
  const items: LibraryListItem[] = [
    {
      kind: 'header',
      key: 'header:climbing',
      section: 'climbing',
      title: 'Climbing',
      count: crags.length ? `(${crags.length})` : '',
      first,
    },
  ];
  if (input.collapsed.climbing) return items;
  if (crags.length === 0) {
    items.push(
      empty('climbing', 'No crags yet', 'Download one from Explore › Climbing to keep its topo'),
    );
    return items;
  }
  crags.forEach((crag, i) => {
    items.push({ kind: 'crag', key: `crag:${crag.uid}`, crag, divider: i > 0 });
  });
  return items;
}

/**
 * Drawn areas (#503): their own section after everything else, in both
 * layouts (areas are not filed into folders yet). Hidden while there are
 * none, unless the Areas chip asked for them; a trail search or filter is
 * about trails, so it stands the section down like it does Maps.
 */
function areaItems(input: LibraryListInput, first: boolean): LibraryListItem[] {
  const areas = input.sortedAreas ?? [];
  if (!input.showAreas || input.narrowed) return [];
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
  grouped.groups.forEach((g, index) => {
    const section = `folder:${g.folder.id}`;
    const folderWaypoints = showWaypoints
      ? (input.sortedFolderWaypoints.get(g.folder.id) ?? [])
      : [];
    const rowCount =
      (showMaps ? g.maps.length : 0) + (showTrails ? g.tracks.length : 0) + folderWaypoints.length;
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
    items.push(...rows(showMaps ? g.maps : [], showTrails ? g.tracks : [], folderWaypoints));
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

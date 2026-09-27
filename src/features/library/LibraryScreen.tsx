import { primaryGeoreferences } from '@core/geo/geopdf/primary';
import type { MapDocument, TrackSummary, Waypoint } from '@core/models';
import { describeUploadOutcome } from '@core/strava/upload';
import { reportError } from '@lib/errorReporting';
import { uploadTrackToStrava } from '@lib/strava';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { useOverlayStatusStore } from '@state/overlayStatusStore';
import { useSettingsStore } from '@state/settingsStore';
import { useStravaStore } from '@state/stravaStore';
import * as Sharing from 'expo-sharing';
import { useRouter } from 'expo-router';
import { Fragment, type ReactNode, useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Divider,
  Icon,
  IconButton,
  List,
  Menu,
  Portal,
  Searchbar,
  Snackbar,
  Text,
  useTheme,
} from 'react-native-paper';
import { findCategory } from '@core/library/categories';
import { countActiveFilters, filterTracks, type TrackFilter } from '@core/library/filterTracks';
import {
  shortDate,
  showsKind,
  trailCaption,
  trailStatsLine,
  typeCounts,
  type LibraryTypeFilter,
} from '@core/library/libraryRows';
import { isSearchActive, searchTracks } from '@core/library/searchTracks';
import { sortTracks, type SortKey } from '@core/library/sortTracks';
import { folderItemCount, groupByFolder } from '@core/library/folders';
import { georeferenceNotice } from '@core/library/overlayPages';
import {
  overlayDetailStatusKey,
  overlayStatusKey,
  renderStatusLine,
} from '@core/library/overlayStatus';
import { notePreview, sortWaypointsNewestFirst } from '@core/library/waypoints';
import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ElevationProfile } from '../common/components/ElevationProfile';
import { WaypointEditorDialog } from '../map/components/WaypointEditorDialog';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import {
  ContourTexture,
  LibraryEmptyState,
  SectionHeader,
  TypeFilterChips,
} from './components/LibraryChrome';
import { MapRow, OnMapChip, RowDivider, TrailRow, WaypointRow } from './components/LibraryRows';
import { pickAndImportGpxFiles } from './importGpx';
import { pickAndImportMaps } from './importMap';
import { mergeLibraryTracks } from './mergeTracks';
import { NameDialog } from './NameDialog';
import { DragGhost } from './DragGhost';
import { useDragToFolder, type DragItem } from './useDragToFolder';
import { SetCategoryDialog } from './SetCategoryDialog';
import { TrackFilterDialog } from './TrackFilterDialog';
import { useTrackElevationPreview } from './useTrackElevationPreview';

// One confirm flow covers every destructive delete in the Library; the copy
// spells out exactly what is (and is not) lost for each kind.
type DeleteTarget = {
  kind: 'map' | 'track' | 'folder' | 'waypoint';
  id: string;
  name: string;
};

const DELETE_COPY: Record<DeleteTarget['kind'], { title: string; body: (name: string) => string }> =
  {
    map: {
      title: 'Delete map',
      body: (name) => `Delete map "${name}"? Its PDF file is permanently deleted.`,
    },
    track: {
      title: 'Delete trail',
      body: (name) =>
        `Delete trail "${name}"? Its GPX file, notes and photos are permanently deleted.`,
    },
    folder: {
      title: 'Delete folder',
      body: (name) => `Delete folder "${name}"? Its items fall back to Ungrouped.`,
    },
    waypoint: {
      title: 'Delete waypoint',
      body: (name) => `Delete waypoint "${name}"? Its note and photo are permanently deleted.`,
    },
  };

/** Interleave rows with the indented row hairline. */
function withDividers(rows: ReactNode[]): ReactNode[] {
  return rows.map((row, i) => (
    <Fragment key={i}>
      {i > 0 && <RowDivider />}
      {row}
    </Fragment>
  ));
}

/**
 * The Library (revamp §5, boards `After-Library.html` / `After-Empty.html`):
 * a header with Organize, sort/filter, the "+" import menu and Settings; the
 * All · Trails · Maps · Waypoints chips; collapsible folder sections; 76 dp
 * rows with route thumbnails; and a first-run empty state. Nothing floats
 * over the list.
 */
export function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const theme = useTheme();
  const tokens = useSchemeTokens();

  const maps = useLibraryStore((s) => s.maps);
  const tracks = useLibraryStore((s) => s.tracks);
  const addMaps = useLibraryStore((s) => s.addMaps);
  const removeMap = useLibraryStore((s) => s.removeMap);
  const renameMap = useLibraryStore((s) => s.renameMap);
  const setActiveMap = useLibraryStore((s) => s.setActiveMap);
  const toggleMapPage = useLibraryStore((s) => s.toggleMapPage);
  const retryMapPage = useLibraryStore((s) => s.retryMapPage);
  // Per-page render outcome from the map's overlay pipeline (#269).
  const overlayStatuses = useOverlayStatusStore((s) => s.statuses);
  const addTrack = useLibraryStore((s) => s.addTrack);
  const addTracks = useLibraryStore((s) => s.addTracks);
  const removeTrack = useLibraryStore((s) => s.removeTrack);
  const renameTrack = useLibraryStore((s) => s.renameTrack);
  const folders = useLibraryStore((s) => s.folders);
  const addFolder = useLibraryStore((s) => s.addFolder);
  const renameFolder = useLibraryStore((s) => s.renameFolder);
  const removeFolder = useLibraryStore((s) => s.removeFolder);
  const setItemFolder = useLibraryStore((s) => s.setItemFolder);
  const setActiveTrackIds = useLibraryStore((s) => s.setActiveTrackIds);
  const customCategories = useLibraryStore((s) => s.customCategories);
  const waypoints = useLibraryStore((s) => s.waypoints);
  const updateWaypoint = useLibraryStore((s) => s.updateWaypoint);
  const removeWaypoint = useLibraryStore((s) => s.removeWaypoint);
  const renameWaypoint = useLibraryStore((s) => s.renameWaypoint);
  const setFocusBounds = useMapStore((s) => s.setFocusBounds);
  const setFocusWaypoint = useMapStore((s) => s.setFocusWaypoint);
  const setRecordRequested = useMapStore((s) => s.setRecordRequested);
  const stravaConnected = useStravaStore((s) => s.connection !== null);
  const units = useSettingsStore((s) => s.units);
  // "Now" for the row dates ("Aug 29" this year, with the year otherwise).
  // Captured once per mount: a date caption never needs a live clock.
  const [nowMs] = useState(() => Date.now());

  const [busy, setBusy] = useState(false);
  const { message: snack, show: showSnack, dismiss: dismissSnack } = useTimedSnackbar(3500);
  const [expandedTrack, setExpandedTrack] = useState<string | null>(null);
  const [expandedMap, setExpandedMap] = useState<string | null>(null);
  const onElevationError = useCallback(
    (error: Error) => {
      reportError(error, 'track-elevation-load');
      showSnack('Could not load elevation');
      setExpandedTrack(null);
    },
    [showSnack],
  );
  const elevationPreview = useTrackElevationPreview(
    tracks.find((track) => track.id === expandedTrack),
    onElevationError,
  );
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleSection = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));
  const [cardMenu, setCardMenu] = useState<{
    kind: 'map' | 'track' | 'waypoint';
    id: string;
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // Organize mode (revamp §5): drag grips and folder rename/delete appear
  // only here, like Files/Photos — the everyday list carries none of them.
  const [organizing, setOrganizing] = useState(false);
  // All · Trails · Maps · Waypoints. A view, not a preference: session-only.
  const [typeFilter, setTypeFilter] = useState<LibraryTypeFilter>('all');
  const [newFolderVisible, setNewFolderVisible] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<{ id: string; name: string } | null>(null);
  const [renamingTrack, setRenamingTrack] = useState<{ id: string; name: string } | null>(null);
  const [renamingMap, setRenamingMap] = useState<{ id: string; name: string } | null>(null);
  const [renamingWaypoint, setRenamingWaypoint] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState<DeleteTarget | null>(null);
  // Trail multi-select (long-press a trail to enter): ids in selection order,
  // which is the merge order for untimed tracks.
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const selectionMode = selectedTrackIds.length > 0;
  // "Set category" dialog target (opened from a trail's ⋮ menu).
  const [categoryTarget, setCategoryTarget] = useState<string | null>(null);
  // Trail filter (header sort/filter button). The criteria are built by the
  // filter dialog; the pure predicate lives in @core/library/filterTracks.
  const [filter, setFilter] = useState<TrackFilter>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const activeFilterCount = countActiveFilters(filter);
  // Trail order, chosen in the same panel. Unlike the filter (a session-scoped
  // query) this is a durable preference, so it lives in settings.json.
  const sortKey = useSettingsStore((s) => s.librarySortKey);
  const setSetting = useSettingsStore((s) => s.set);
  const applyFilterAndSort = (next: TrackFilter, nextSort: SortKey) => {
    setFilter(next);
    setSetting('librarySortKey', nextSort);
  };
  // Trail search (the magnifier at the end of the chip row). A query is not a
  // preference: it is never persisted, and closing the field CLEARS it, so a
  // library can never come back narrowed by a needle the user can no longer
  // see — the same reasoning that keeps `filter` session-only, one step
  // stricter because the search field, unlike the filter button, has no badge
  // once it is collapsed.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searching = isSearchActive(searchQuery);
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery('');
  };
  // Either narrowing in effect: both hide trails, so both switch the section
  // header to its "(visible/total)" form and stand the Maps section down.
  const narrowed = activeFilterCount > 0 || searching;
  // Derived once per data change, not per render: this screen re-renders on
  // every card-menu open, every section collapse, every selection tap and every
  // drag-hover, and both of these walk (and re-allocate) the whole library.
  // search → filter → sort → group, the same four pure passes in the same
  // order everywhere. Search runs first because it is the coarsest cut; sorting
  // BEFORE grouping is what orders trails inside each folder while leaving the
  // folders themselves in their user-defined order.
  const visibleTracks = useMemo(
    () => sortTracks(filterTracks(searchTracks(tracks, searchQuery, folders), filter), sortKey),
    [tracks, searchQuery, folders, filter, sortKey],
  );

  const grouped = useMemo(
    () => groupByFolder(folders, maps, visibleTracks, waypoints),
    [folders, maps, visibleTracks, waypoints],
  );
  // Same for the newest-first waypoint lists rendered below — each call copies
  // and sorts. There are three of them: the flat "Waypoints" section, the
  // Ungrouped section, and one PER FOLDER GROUP (sorted here as a map keyed by
  // folder id, since the folder sections are built inside a render callback).
  const sortedWaypoints = useMemo(() => sortWaypointsNewestFirst(waypoints), [waypoints]);
  const sortedUngroupedWaypoints = useMemo(
    () => sortWaypointsNewestFirst(grouped.ungroupedWaypoints),
    [grouped],
  );
  const sortedFolderWaypoints = useMemo(
    () =>
      new Map(
        grouped.groups.map((g) => [g.folder.id, sortWaypointsNewestFirst(g.waypoints)] as const),
      ),
    [grouped],
  );
  const chipCounts = typeCounts({
    trails: tracks.length,
    maps: maps.length,
    waypoints: waypoints.length,
  });
  const showMaps = showsKind(typeFilter, 'maps') && !narrowed;
  const showTrails = showsKind(typeFilter, 'trails');
  const showWaypoints = showsKind(typeFilter, 'waypoints');

  // Drag-and-drop moves (Organize mode): each row's grip drags a ghost chip
  // onto a folder (or Ungrouped) header. The ⋮ move-to-folder menu remains
  // for one-handed use. Grips render only once a folder exists.
  const {
    dragging,
    hovered: dragHovered,
    ghost: dragGhost,
    registerTarget,
    handleProps,
    scrollRef: dragScrollRef,
    onScroll: onDragScroll,
    onWindowHeight: onDragWindowHeight,
  } = useDragToFolder({
    onDrop: (item, target) => {
      const folderName = target === null ? null : folders.find((f) => f.id === target)?.name;
      // A target that no longer exists (deleted mid-drag, #303) is not a move.
      if (folderName === undefined) return;
      setItemFolder(item.kind, item.id, target);
      showSnack(folderName === null ? 'Removed from folder' : `Moved to "${folderName}"`);
    },
  });
  const hasFolders = folders.length > 0;
  const dragHandle = (item: DragItem) =>
    hasFolders && organizing ? (
      <View
        style={styles.dragHandle}
        {...handleProps(item)}
        accessibilityLabel={`Drag ${item.label} to a folder`}
      >
        <Icon source="drag-vertical" size={22} color={tokens.inkMuted} />
      </View>
    ) : null;

  const onImport = async () => {
    setBusy(true);
    const result = await pickAndImportMaps();
    setBusy(false);
    if (result.kind === 'imported') {
      // One write for the whole pick — adding them one by one re-serialized
      // the entire index per file.
      addMaps(result.docs);
      const n = result.docs.length;
      showSnack(
        `Imported ${n} map${n === 1 ? '' : 's'}${result.failed ? `, ${result.failed} failed` : ''}`,
      );
    } else if (result.kind === 'error') {
      showSnack(`Import failed: ${result.message}`);
    }
  };

  const onImportGpx = async () => {
    setBusy(true);
    const result = await pickAndImportGpxFiles();
    setBusy(false);
    if (result.kind === 'imported') {
      addTracks(result.items);
      const n = result.items.length;
      showSnack(
        `Imported ${n} trail${n === 1 ? '' : 's'}${result.failed ? `, ${result.failed} failed` : ''}`,
      );
    } else if (result.kind === 'error') {
      showSnack(`Import failed: ${result.message}`);
    }
  };

  const openMap = (id: string) => {
    setActiveMap(id);
    router.navigate('/');
  };

  const viewTrack = (id: string) => {
    setActiveTrackIds([id]);
    const bbox = tracks.find((t) => t.id === id)?.stats.bbox;
    if (bbox) setFocusBounds(bbox); // center the map on the trail, not the user
    router.navigate('/');
  };

  // "Trim" menu item: opens the trail viewer straight into its Trim mode
  // (the `trim=1` param it reads on mount) — trimming lives in the focused
  // viewer now, not the map's inspect panel.
  const trimTrack = (id: string) => {
    router.push(`/trail3d/${id}?trim=1`);
  };

  // Empty state: "Record a trail" hands the map a one-shot request to open
  // its record-start sheet; "Browse maps near you" opens the Maps tab.
  const recordFromEmpty = () => {
    setRecordRequested(true);
    router.navigate('/');
  };

  // Waypoint editor (same dialog + libraryStore semantics as tapping a pin on
  // the map). The dialog stays live against the store row while editing, so a
  // photo picked inside it shows up immediately.
  const [editWpId, setEditWpId] = useState<string | null>(null);
  const [wpDraft, setWpDraft] = useState('');
  // #232 — the editor's Name field. Here it is a second way to the same
  // rename the row's ⋮ → Rename does; the row menu stays, since it renames
  // without opening the note/photo form.
  const [wpName, setWpName] = useState('');
  const editWaypoint =
    editWpId === null ? null : (waypoints.find((w) => w.id === editWpId) ?? null);

  const openWaypointEditor = (w: Waypoint) => {
    setWpName(w.label);
    setWpDraft(w.note ?? '');
    setEditWpId(w.id);
  };
  const saveWaypoint = () => {
    if (editWpId) {
      updateWaypoint(editWpId, { note: wpDraft.trim() });
      // Blank is a no-op in the store — the label is never lost.
      renameWaypoint(editWpId, wpName);
    }
    setEditWpId(null);
  };
  const deleteWaypointFromEditor = () => {
    if (editWpId) removeWaypoint(editWpId);
    setEditWpId(null);
  };
  const setWaypointPhoto = (uri: string) => {
    if (editWpId) updateWaypoint(editWpId, { photoUri: uri });
  };

  // "Show on map": one-shot camera intent the Map tab consumes by flying to
  // the pin (same pattern as viewTrack's focusBounds).
  const showWaypointOnMap = (w: Waypoint) => {
    setFocusWaypoint({ latitude: w.latitude, longitude: w.longitude });
    router.navigate('/');
  };

  const createFolder = (name: string) => {
    setNewFolderVisible(false);
    addFolder(name || 'New folder');
  };

  const commitRenameFolder = (name: string) => {
    if (renamingFolder && name) renameFolder(renamingFolder.id, name);
    setRenamingFolder(null);
  };

  // Same guard as folders: NameDialog hands back a trimmed string, and an
  // empty one means "the user cleared the field" — keep the current name.
  const commitRenameTrack = (name: string) => {
    if (renamingTrack && name) renameTrack(renamingTrack.id, name);
    setRenamingTrack(null);
  };

  const commitRenameMap = (name: string) => {
    if (renamingMap && name) renameMap(renamingMap.id, name);
    setRenamingMap(null);
  };

  const commitRenameWaypoint = (name: string) => {
    if (renamingWaypoint && name) renameWaypoint(renamingWaypoint.id, name);
    setRenamingWaypoint(null);
  };

  const onConfirmDelete = () => {
    if (!confirmDelete) return;
    const { kind, id } = confirmDelete;
    setConfirmDelete(null);
    if (kind === 'map') removeMap(id);
    else if (kind === 'track') removeTrack(id);
    else if (kind === 'waypoint')
      removeWaypoint(id); // photo cleanup is the store's job
    else removeFolder(id);
  };

  const toggleElevation = (id: string) => {
    setExpandedTrack((current) => (current === id ? null : id));
  };

  const toggleTrackSelected = (id: string) => {
    if (selectedTrackIds.length === 0) {
      showSnack('Select 2 or more trails, then tap the merge button');
    }
    setSelectedTrackIds((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));
  };

  const onMergeSelected = async () => {
    // Resolve in selection order; mergeTracks re-orders by timestamp when all
    // sources carry one.
    const chosen = selectedTrackIds
      .map((id) => tracks.find((t) => t.id === id))
      .filter((t): t is TrackSummary => t !== undefined);
    if (chosen.length < 2) return;
    setMerging(true);
    try {
      const { track, fileUri, notes } = await mergeLibraryTracks(chosen);
      addTrack(track, fileUri, notes);
      setSelectedTrackIds([]);
      showSnack(`Merged ${chosen.length} trails into "${track.name}"`);
    } catch (err) {
      showSnack(`Merge failed: ${err instanceof Error ? err.message : 'could not read a trail'}`);
    } finally {
      setMerging(false);
    }
  };

  const shareTrack = async (fileUri: string) => {
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(fileUri, { mimeType: 'application/gpx+xml', UTI: 'public.xml' });
    } else {
      showSnack('Sharing is not available on this device');
    }
  };

  // Push an older saved trail to Strava (the ⋮ menu item only shows while a
  // Strava account is connected). Outcomes land in the same timed snackbar.
  const sendToStrava = async (t: TrackSummary) => {
    showSnack(`Uploading "${t.name}" to Strava…`);
    const outcome = await uploadTrackToStrava({ id: t.id, name: t.name, fileUri: t.fileUri });
    showSnack(describeUploadOutcome(outcome, t.name));
  };

  // A section header that is also a drop target for Organize-mode drags
  // (`dropTarget`: a folder id, or null for Ungrouped).
  const sectionHeader = ({
    key,
    title,
    count,
    first,
    actions,
    dropTarget,
  }: {
    key: string;
    title: string;
    count: string;
    first?: boolean;
    actions?: ReactNode;
    dropTarget?: string | null;
  }) => (
    <SectionHeader
      title={title}
      count={count}
      first={first}
      collapsed={collapsed[key] === true}
      onToggle={() => toggleSection(key)}
      actions={actions}
      dropRef={dropTarget === undefined ? undefined : registerTarget(dropTarget)}
      highlighted={dropTarget !== undefined && dragging !== null && dragHovered === dropTarget}
    />
  );

  // The "Move to folder" block shared by every ⋮ menu. It only appears once a
  // folder exists — a section of nothing but greyed-out placeholders is
  // clutter, not guidance.
  const moveToFolderItems = (
    kind: 'map' | 'track' | 'waypoint',
    id: string,
    folderId: string | undefined,
  ) =>
    folders.length > 0 && (
      <>
        <Divider />
        <Menu.Item disabled title="Move to folder" />
        {folders.map((f) => (
          <Menu.Item
            key={f.id}
            leadingIcon={folderId === f.id ? 'folder-check' : 'folder-outline'}
            title={f.name}
            // Distinct from the folder section header's text (screen readers
            // and the e2e driver would otherwise hit the header first).
            accessibilityLabel={`Move to ${f.name}`}
            onPress={() => setItemFolder(kind, id, folderId === f.id ? null : f.id)}
          />
        ))}
        {folderId !== undefined && (
          <Menu.Item
            leadingIcon="folder-off-outline"
            title="Remove from folder"
            onPress={() => setItemFolder(kind, id, null)}
          />
        )}
      </>
    );

  const menuAnchor = (kind: 'map' | 'track' | 'waypoint', id: string, label: string) => (
    <IconButton
      icon="dots-vertical"
      size={22}
      iconColor={tokens.inkMuted}
      style={styles.menuButton}
      onPress={() => setCardMenu({ kind, id })}
      accessibilityLabel={label}
    />
  );

  // A map's ⋮: rename, its page list, folders, delete. (The row itself opens
  // the map; the "On map" chip shows/hides it.)
  const mapMenu = (m: MapDocument, hasPages: boolean) => (
    <Menu
      visible={cardMenu?.kind === 'map' && cardMenu.id === m.id}
      onDismiss={() => setCardMenu(null)}
      // "Map options", not "Organize": the header's Organize button owns that name.
      anchor={menuAnchor('map', m.id, 'Map options')}
    >
      {/* The rename is index-level only: the stored PDF is never rewritten,
          so its own embedded title is left alone — same as a trail's GPX. */}
      <Menu.Item
        leadingIcon="pencil-outline"
        title="Rename"
        onPress={() => {
          setCardMenu(null);
          setRenamingMap({ id: m.id, name: m.name });
        }}
      />
      {hasPages && (
        <Menu.Item
          leadingIcon="layers-outline"
          title={expandedMap === m.id ? 'Hide overlay pages' : 'Overlay pages'}
          accessibilityLabel="Overlay pages"
          onPress={() => {
            setCardMenu(null);
            setExpandedMap(expandedMap === m.id ? null : m.id);
          }}
        />
      )}
      {moveToFolderItems('map', m.id, m.folderId)}
      <Divider />
      <Menu.Item
        leadingIcon="trash-can-outline"
        title="Delete map"
        onPress={() => {
          setCardMenu(null);
          setConfirmDelete({ kind: 'map', id: m.id, name: m.name });
        }}
      />
    </Menu>
  );

  // "On map": every drawable page on, or all off. Pages that failed to render
  // stay off when others can be shown; re-enabling a failed page is the
  // Retry button's job (or the page list's).
  const toggleMapOnMap = (m: MapDocument) => {
    if (m.activePages.length > 0) {
      for (const page of m.activePages) toggleMapPage(m.id, page);
      return;
    }
    const pages = primaryGeoreferences(m.georeferences).map((g) => g.pageIndex);
    const failed = new Set((m.renderRecoveryErrors ?? []).map((e) => e.pageIndex));
    const healthy = pages.filter((p) => !failed.has(p));
    for (const page of healthy.length > 0 ? healthy : pages.slice(0, 1)) {
      toggleMapPage(m.id, page);
    }
  };

  const renderMapRow = (m: MapDocument) => {
    const primaries = primaryGeoreferences(m.georeferences);
    const hasPages = m.georeferences.length > 0;
    // Non-null when the map can never be drawn: no georeferencing at all, or a
    // projection we could not resolve (#243). Shown INSTEAD of the size and
    // page counts, and the map gets no "On map" chip.
    const notice = georeferenceNotice(m);
    // "Rendering page N…" / "Couldn't render page N: <reason>" — so a page
    // that never appears on the map always says why, here, not only in a
    // four-second snackbar on the map screen (#269).
    const renderStatus = renderStatusLine(m, overlayStatuses);
    const rendering = m.activePages.some((page) => {
      const key = overlayStatusKey(m.id, page);
      return (
        overlayStatuses[key]?.phase === 'rendering' ||
        overlayStatuses[overlayDetailStatusKey(key)]?.phase === 'rendering'
      );
    });
    return (
      <MapRow
        key={m.id}
        map={m}
        title={m.pageCount > 1 ? `${m.name} · ${m.pageCount} pages` : m.name}
        notice={notice}
        pagesLine={
          primaries.length > 1 ? `${m.activePages.length}/${primaries.length} pages on map` : null
        }
        status={
          renderStatus ? { text: renderStatus.text, failed: renderStatus.kind === 'failed' } : null
        }
        rendering={rendering}
        renderingLabel={`Rendering ${m.name}`}
        accessibilityLabel={`${m.name} — view on map`}
        onPress={() => openMap(m.id)}
        leading={dragHandle({ kind: 'map', id: m.id, label: m.name })}
        toggle={
          notice === null && hasPages ? (
            <OnMapChip
              on={m.activePages.length > 0}
              name={m.name}
              onToggle={() => toggleMapOnMap(m)}
            />
          ) : null
        }
        trailing={mapMenu(m, hasPages)}
      >
        {m.renderRecoveryErrors?.map((error) => (
          <View key={`recovery-${error.pageIndex}`} style={styles.rowExtra}>
            <Text variant="bodySmall" style={{ color: theme.colors.error }}>
              {error.reason === 'interrupted'
                ? `Page ${error.pageIndex + 1}: Rendering was interrupted. This page was turned off to keep other maps available.`
                : `Page ${error.pageIndex + 1}: ${error.message} This page was turned off to keep other maps available.`}
            </Text>
            <Button
              style={styles.retry}
              accessibilityLabel={`Retry page ${error.pageIndex + 1} of ${m.name}`}
              onPress={() => {
                try {
                  retryMapPage(m.id, error.pageIndex);
                } catch (failure) {
                  reportError(failure, 'pdf-page-retry');
                  showSnack('Could not save the retry. The page remains turned off.');
                }
              }}
            >
              Retry
            </Button>
          </View>
        ))}
        {hasPages && expandedMap === m.id && (
          <View style={styles.rowExtra}>
            <Text variant="labelMedium" style={styles.overlayLabel}>
              Show as overlay
            </Text>
            {/* mode="android" is REQUIRED, not cosmetic. Paper's default
                Checkbox is platform-adaptive, and its iOS variant renders the
                checkmark at `opacity: 0` when unchecked — so on iPhone an
                inactive page showed no control at all, only a stranded "Page
                N" label, and a page toggled off could never be toggled back
                on. That is #236: "imported PDFs have no checkbox". The
                Material box draws both states on both platforms.
                labelStyle keeps the label beside its box: `position="leading"`
                makes Paper right-align the label, which parked it against the
                far edge of the row. */}
            {primaries.map((g) => (
              <Checkbox.Item
                key={g.pageIndex}
                mode="android"
                label={`Page ${g.pageIndex + 1}`}
                position="leading"
                labelStyle={styles.checkboxLabel}
                status={m.activePages.includes(g.pageIndex) ? 'checked' : 'unchecked'}
                onPress={() => toggleMapPage(m.id, g.pageIndex)}
                style={styles.checkboxItem}
              />
            ))}
          </View>
        )}
      </MapRow>
    );
  };

  // Full overflow menu for a trail: every secondary action plus folder
  // membership — the row itself only opens the trail (revamp §5).
  const trackMenu = (t: TrackSummary) => (
    <Menu
      visible={cardMenu?.kind === 'track' && cardMenu.id === t.id}
      onDismiss={() => setCardMenu(null)}
      anchor={menuAnchor('track', t.id, 'More options')}
    >
      <Menu.Item
        leadingIcon="pencil-outline"
        title="Rename"
        onPress={() => {
          setCardMenu(null);
          setRenamingTrack({ id: t.id, name: t.name });
        }}
      />
      <Menu.Item
        leadingIcon="map-outline"
        title="View on map"
        onPress={() => {
          setCardMenu(null);
          viewTrack(t.id);
        }}
      />
      {/* The row's old chart button: an inline profile peek under the row. */}
      <Menu.Item
        leadingIcon="chart-areaspline"
        title={expandedTrack === t.id ? 'Hide elevation profile' : 'Elevation profile'}
        accessibilityLabel="Elevation profile"
        onPress={() => {
          setCardMenu(null);
          toggleElevation(t.id);
        }}
      />
      <Menu.Item
        leadingIcon="share-variant"
        title="Share GPX"
        onPress={() => {
          setCardMenu(null);
          void shareTrack(t.fileUri);
        }}
      />
      {stravaConnected && (
        <Menu.Item
          leadingIcon="cloud-upload-outline"
          title="Send to Strava"
          onPress={() => {
            setCardMenu(null);
            void sendToStrava(t);
          }}
        />
      )}
      <Menu.Item
        leadingIcon="content-cut"
        title="Trim"
        onPress={() => {
          setCardMenu(null);
          trimTrack(t.id);
        }}
      />
      <Menu.Item
        leadingIcon="call-merge"
        title="Merge"
        onPress={() => {
          // Enter the multi-select mode (same one long-press opens) with this
          // trail pre-selected; the user then taps the others and confirms.
          setCardMenu(null);
          if (!selectedTrackIds.includes(t.id)) toggleTrackSelected(t.id);
        }}
      />
      <Menu.Item
        leadingIcon="tag-outline"
        title="Set category"
        onPress={() => {
          setCardMenu(null);
          setCategoryTarget(t.id);
        }}
      />
      {moveToFolderItems('track', t.id, t.folderId)}
      <Divider />
      <Menu.Item
        leadingIcon="trash-can-outline"
        title="Delete trail"
        onPress={() => {
          setCardMenu(null);
          setConfirmDelete({ kind: 'track', id: t.id, name: t.name });
        }}
      />
    </Menu>
  );

  const renderTrackRow = (t: TrackSummary) => {
    const selected = selectedTrackIds.includes(t.id);
    // Decision 7: the type is a badge on the thumbnail, a word in the caption
    // and part of the spoken label — never colour alone.
    const category = findCategory(t.category, customCategories);
    const stats = trailStatsLine(t.stats, units);
    const caption = trailCaption(t.startedAt, category?.name ?? null, nowMs);
    const spoken = [t.name, category?.name, shortDate(t.startedAt, nowMs), stats]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(', ');
    return (
      <TrailRow
        key={t.id}
        track={t}
        category={category}
        stats={stats}
        caption={caption}
        // Long-press enters trail selection (for merging); while selecting,
        // taps toggle membership instead of opening the trail.
        accessibilityLabel={
          selectionMode
            ? `${t.name} — ${selected ? 'deselect' : 'select'} for merge`
            : `${spoken} — open 3D view, long-press to select`
        }
        onPress={() =>
          selectionMode ? toggleTrackSelected(t.id) : router.navigate(`/trail3d/${t.id}`)
        }
        onLongPress={() => toggleTrackSelected(t.id)}
        selecting={selectionMode}
        selected={selected}
        leading={dragHandle({ kind: 'track', id: t.id, label: t.name })}
        trailing={trackMenu(t)}
      >
        {expandedTrack === t.id &&
          (elevationPreview?.points ? (
            <ElevationProfile
              points={elevationPreview.points}
              ascentM={t.stats.ascentM}
              descentM={t.stats.descentM}
            />
          ) : (
            <ActivityIndicator style={styles.loader} />
          ))}
      </TrailRow>
    );
  };

  // ⋮ / long-press menu for a waypoint row: rename, jump the map to the pin,
  // folders, or delete (through the same confirm flow as every other delete).
  const waypointMenu = (w: Waypoint) => (
    <Menu
      visible={cardMenu?.kind === 'waypoint' && cardMenu.id === w.id}
      onDismiss={() => setCardMenu(null)}
      // Distinct from the trail row's "More options": two buttons sharing one
      // label is ambiguous for screen readers AND for Maestro, which could not
      // resolve the trail menu once a saved waypoint was on screen
      // (folders.yaml failed on main, 2026-08-10).
      anchor={menuAnchor('waypoint', w.id, 'Waypoint options')}
    >
      {/* Renaming without opening the note/photo form. The editor dialog grew
          its own Name field in #232 (an inline TextInput, NOT a stacked
          NameDialog Portal over an open Paper Dialog — that is the
          touch-swallow trap); this row is the quick path from the list. */}
      <Menu.Item
        leadingIcon="pencil-outline"
        title="Rename"
        onPress={() => {
          setCardMenu(null);
          setRenamingWaypoint({ id: w.id, name: w.label });
        }}
      />
      <Menu.Item
        leadingIcon="map-marker-radius-outline"
        title="Show on map"
        onPress={() => {
          setCardMenu(null);
          showWaypointOnMap(w);
        }}
      />
      {moveToFolderItems('waypoint', w.id, w.folderId)}
      <Divider />
      <Menu.Item
        leadingIcon="trash-can-outline"
        title="Delete waypoint"
        onPress={() => {
          setCardMenu(null);
          setConfirmDelete({ kind: 'waypoint', id: w.id, name: w.label });
        }}
      />
    </Menu>
  );

  const renderWaypointRow = (w: Waypoint) => {
    const preview = notePreview(w.note);
    return (
      <WaypointRow
        key={w.id}
        name={w.label}
        detail={preview !== null ? `Waypoint · ${preview}` : 'Waypoint'}
        caption={shortDate(w.createdAt, nowMs)}
        photoUri={w.photoUri}
        accessibilityLabel={`${w.label} — edit note and photo, long-press for more options`}
        onPress={() => openWaypointEditor(w)}
        onLongPress={() => setCardMenu({ kind: 'waypoint', id: w.id })}
        leading={dragHandle({ kind: 'waypoint', id: w.id, label: w.label })}
        trailing={waypointMenu(w)}
      />
    );
  };

  const emptyRow = (title: string, description: string) => (
    <List.Item title={title} description={description} titleStyle={styles.emptyRowTitle} />
  );

  // Folder groups (cross-type: each folder shows its maps, trails, waypoints),
  // narrowed to the selected type chip.
  const renderFolderGroups = () =>
    grouped.groups.flatMap((g, index) => {
      const key = `folder:${g.folder.id}`;
      const rows = [
        // Trail filters and trail search are about trails — maps drop out of
        // results while either narrowing is active.
        ...(showMaps ? g.maps.map(renderMapRow) : []),
        ...(showTrails ? g.tracks.map(renderTrackRow) : []),
        ...(showWaypoints
          ? (sortedFolderWaypoints.get(g.folder.id) ?? []).map(renderWaypointRow)
          : []),
      ];
      const count = typeFilter === 'all' ? folderItemCount(g) : rows.length;
      // Under a type chip, a folder holding none of that type steps aside.
      if (typeFilter !== 'all' && rows.length === 0 && !organizing) return [];
      return [
        <View key={key}>
          {sectionHeader({
            key,
            title: g.folder.name,
            count: count ? `(${count})` : '',
            first: index === 0,
            dropTarget: g.folder.id,
            actions: organizing ? (
              <View style={styles.folderActions}>
                <IconButton
                  icon="pencil-outline"
                  size={20}
                  onPress={() => setRenamingFolder({ id: g.folder.id, name: g.folder.name })}
                  accessibilityLabel="Rename folder"
                />
                <IconButton
                  icon="trash-can-outline"
                  size={20}
                  onPress={() =>
                    setConfirmDelete({ kind: 'folder', id: g.folder.id, name: g.folder.name })
                  }
                  accessibilityLabel="Delete folder"
                />
              </View>
            ) : undefined,
          })}
          {collapsed[key]
            ? null
            : rows.length === 0
              ? emptyRow(
                  'Empty folder',
                  organizing
                    ? "Drag an item's grip here, or use its ⋮ menu"
                    : 'Move items here from their ⋮ menu',
                )
              : withDividers(rows)}
        </View>,
      ];
    });

  const ungroupedRows = [
    ...(showMaps ? grouped.ungroupedMaps.map(renderMapRow) : []),
    ...(showTrails ? grouped.ungroupedTracks.map(renderTrackRow) : []),
    ...(showWaypoints ? sortedUngroupedWaypoints.map(renderWaypointRow) : []),
  ];

  const trailsCount = tracks.length
    ? narrowed
      ? `(${visibleTracks.length}/${tracks.length})`
      : `(${tracks.length})`
    : '';

  // No folders yet: the familiar Maps / Recorded trails / Waypoints split.
  const renderTypeSections = () => {
    const sections: ReactNode[] = [];
    if (showMaps) {
      sections.push(
        <View key="maps">
          {sectionHeader({
            key: 'maps',
            title: 'Maps',
            count: maps.length ? `(${maps.length})` : '',
            first: sections.length === 0,
          })}
          {collapsed.maps
            ? null
            : maps.length === 0
              ? emptyRow('No maps yet', 'Import a PDF map with +, or get one from the Maps tab')
              : withDividers(maps.map(renderMapRow))}
        </View>,
      );
    }
    if (showTrails) {
      sections.push(
        <View key="trails">
          {sectionHeader({
            key: 'trails',
            title: 'Recorded trails',
            count: trailsCount,
            first: sections.length === 0,
          })}
          {collapsed.trails
            ? null
            : tracks.length === 0
              ? emptyRow('No trails yet', 'Record one on the map, or import a GPX file with +')
              : visibleTracks.length === 0
                ? // Two honest empty states, not one: a query that found
                  // nothing says so, and quotes what was typed, instead of
                  // blaming filters the user may not have set.
                  // `library-filter` asserts on the filter wording.
                  searching
                  ? emptyRow(
                      `No trails match “${searchQuery.trim()}”`,
                      activeFilterCount > 0
                        ? 'Try another word, or clear the filters too'
                        : 'Try another word, or a folder name',
                    )
                  : emptyRow(
                      'No trails match the filters',
                      'Adjust or clear the filters from the sort and filter button',
                    )
                : withDividers(visibleTracks.map(renderTrackRow))}
        </View>,
      );
    }
    // Standalone waypoints (map "+" sheet). Hidden entirely while there are
    // none, unless the Waypoints chip asked for them.
    if (showWaypoints && (waypoints.length > 0 || typeFilter === 'waypoints')) {
      sections.push(
        <View key="waypoints">
          {sectionHeader({
            key: 'waypoints',
            title: 'Waypoints',
            count: waypoints.length ? `(${waypoints.length})` : '',
            first: sections.length === 0,
          })}
          {collapsed.waypoints
            ? null
            : waypoints.length === 0
              ? emptyRow('No waypoints yet', 'Add one on the map from its + sheet')
              : withDividers(sortedWaypoints.map(renderWaypointRow))}
        </View>,
      );
    }
    return sections;
  };

  // First run: nothing at all in the Library.
  const libraryEmpty =
    maps.length === 0 && tracks.length === 0 && waypoints.length === 0 && !hasFolders;

  const importMenu = (
    <Menu
      visible={importOpen}
      onDismiss={() => setImportOpen(false)}
      anchor={
        busy ? (
          <View style={styles.headerIcon}>
            <ActivityIndicator accessibilityLabel="Importing" color={tokens.ink} />
          </View>
        ) : (
          <IconButton
            icon="plus"
            size={26}
            iconColor={tokens.ink}
            style={styles.headerButton}
            onPress={() => setImportOpen(true)}
            // "Import" is also the e2e mount proof for this screen (heatmap.yaml).
            accessibilityLabel="Import"
          />
        )
      }
    >
      <Menu.Item
        leadingIcon="map-marker-path"
        title="Import GPX trail"
        onPress={() => {
          setImportOpen(false);
          void onImportGpx();
        }}
      />
      <Menu.Item
        leadingIcon="map"
        title="Import PDF map"
        onPress={() => {
          setImportOpen(false);
          void onImport();
        }}
      />
      <Divider />
      <Menu.Item
        leadingIcon="folder-plus-outline"
        title="New folder"
        onPress={() => {
          setImportOpen(false);
          setNewFolderVisible(true);
        }}
      />
    </Menu>
  );

  const header = selectionMode ? (
    // Trail selection mode (entered by long-pressing a trail row).
    <View style={styles.header}>
      <IconButton
        icon="close"
        iconColor={tokens.ink}
        style={styles.headerButton}
        onPress={() => setSelectedTrackIds([])}
        accessibilityLabel="Exit selection"
      />
      <Text style={[styles.selectionTitle, { color: tokens.ink }]}>
        {`${selectedTrackIds.length} selected`}
      </Text>
      <IconButton
        icon="call-merge"
        iconColor={tokens.ink}
        style={styles.headerButton}
        onPress={() => void onMergeSelected()}
        disabled={selectedTrackIds.length < 2 || merging}
        accessibilityLabel="Merge selected trails"
      />
    </View>
  ) : (
    <View style={styles.header}>
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        // 360 dp phones: shrink a little rather than truncate "Library".
        adjustsFontSizeToFit
        minimumFontScale={0.8}
        style={[styles.title, { color: tokens.ink }]}
      >
        Library
      </Text>
      {!libraryEmpty && (
        <Pressable
          onPress={() => setOrganizing((o) => !o)}
          accessibilityRole="button"
          accessibilityState={{ selected: organizing }}
          style={({ pressed }) => [styles.organize, pressed && styles.pressed]}
        >
          <Text style={[styles.organizeLabel, { color: tokens.ink }]}>
            {organizing ? 'Done' : 'Organize'}
          </Text>
        </Pressable>
      )}
      {!libraryEmpty && (
        // Sort & filter: the badge counts active criteria (distance, date,
        // category, …) so a filtered-down list is never mistaken for a small
        // library.
        <View>
          <IconButton
            icon="filter-variant"
            iconColor={tokens.ink}
            style={styles.headerButton}
            onPress={() => setFilterOpen(true)}
            accessibilityLabel="Filter trails"
          />
          {activeFilterCount > 0 && (
            <Badge size={16} style={styles.filterBadge}>
              {activeFilterCount}
            </Badge>
          )}
        </View>
      )}
      {/* Import is a header "+" menu: nothing floats over the list. */}
      {importMenu}
      {/* Settings left the tab bar (revamp decision 6): a gear here and in
          the Logbook header, plus a row in the map's "+" sheet. */}
      <IconButton
        icon="cog-outline"
        iconColor={tokens.ink}
        style={styles.headerButton}
        onPress={() => router.push('/settings')}
        accessibilityLabel="Settings"
      />
    </View>
  );

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      <View style={{ paddingTop: insets.top }}>
        <ContourTexture variant="header" />
        {header}
        {!selectionMode &&
          !libraryEmpty &&
          (searchOpen ? (
            <Searchbar
              placeholder="Search trails"
              value={searchQuery}
              onChangeText={setSearchQuery}
              onIconPress={closeSearch}
              icon="arrow-left"
              searchAccessibilityLabel="Close search"
              autoFocus
              // #235 — the search key is this field's iOS exit: the list is
              // already live-filtered, so Return only needs to free the screen.
              returnKeyType="search"
              blurOnSubmit
              onSubmitEditing={() => Keyboard.dismiss()}
              style={styles.searchbar}
              accessibilityLabel="Search trails by name or folder"
            />
          ) : (
            <TypeFilterChips
              value={typeFilter}
              counts={chipCounts}
              onChange={setTypeFilter}
              trailing={
                // Search is a collapsible field, not a permanent row: collapsed
                // it costs one icon at the end of the chips.
                <IconButton
                  icon="magnify"
                  iconColor={tokens.ink}
                  style={styles.headerButton}
                  onPress={() => setSearchOpen(true)}
                  accessibilityLabel="Search trails"
                />
              }
            />
          ))}
      </View>

      {libraryEmpty ? (
        <LibraryEmptyState
          busy={busy}
          onRecord={recordFromEmpty}
          onImportGpx={() => void onImportGpx()}
          onBrowseMaps={() => router.navigate('/maps')}
        />
      ) : (
        <ScrollView
          ref={dragScrollRef}
          scrollEnabled={dragging === null}
          onScroll={(e) => onDragScroll(e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={32}
          onLayout={(e) => onDragWindowHeight(e.nativeEvent.layout.height + e.nativeEvent.layout.y)}
          contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
        >
          {organizing && !hasFolders && (
            <Text style={[styles.hint, { color: tokens.inkMuted }]}>
              Create a folder with + to group trails, maps and waypoints. Grips, rename and delete
              for folders appear here.
            </Text>
          )}

          {/* The folder layout has no per-section empty state (each folder just
              renders its matches), so a search that found nothing needs one row
              of its own — otherwise the screen is a wall of folder headers with
              nothing under them and no explanation. */}
          {hasFolders &&
            searching &&
            visibleTracks.length === 0 &&
            emptyRow(
              `No trails match “${searchQuery.trim()}”`,
              'Try another word, or a folder name',
            )}

          {hasFolders ? (
            <>
              {renderFolderGroups()}
              {/* With folders: one cross-type "Ungrouped" catch-all for leftovers. */}
              {ungroupedRows.length > 0 && (
                <View>
                  {sectionHeader({
                    key: 'ungrouped',
                    title: 'Ungrouped',
                    count: `(${ungroupedRows.length})`,
                    first: grouped.groups.length === 0,
                    dropTarget: null,
                  })}
                  {collapsed.ungrouped ? null : withDividers(ungroupedRows)}
                </View>
              )}
            </>
          ) : (
            renderTypeSections()
          )}
        </ScrollView>
      )}

      <DragGhost
        dragging={dragging}
        ghost={dragGhost}
        backgroundColor={theme.colors.inverseSurface}
        color={theme.colors.inverseOnSurface}
        renderLabel={(label, color) => (
          <Text variant="labelLarge" numberOfLines={1} style={{ color, maxWidth: 220 }}>
            {label}
          </Text>
        )}
      />

      <Portal>
        <NameDialog
          visible={newFolderVisible}
          title="New folder"
          label="Folder name"
          onDismiss={() => setNewFolderVisible(false)}
          onSubmit={createFolder}
        />

        <NameDialog
          visible={renamingFolder !== null}
          title="Rename folder"
          label="Folder name"
          confirmLabel="Rename"
          initialValue={renamingFolder?.name ?? ''}
          onDismiss={() => setRenamingFolder(null)}
          onSubmit={commitRenameFolder}
        />

        <NameDialog
          visible={renamingTrack !== null}
          title="Rename trail"
          label="Trail name"
          confirmLabel="Rename"
          initialValue={renamingTrack?.name ?? ''}
          onDismiss={() => setRenamingTrack(null)}
          onSubmit={commitRenameTrack}
        />

        <NameDialog
          visible={renamingMap !== null}
          title="Rename map"
          label="Map name"
          confirmLabel="Rename"
          initialValue={renamingMap?.name ?? ''}
          onDismiss={() => setRenamingMap(null)}
          onSubmit={commitRenameMap}
        />

        <NameDialog
          visible={renamingWaypoint !== null}
          title="Rename waypoint"
          label="Waypoint name"
          confirmLabel="Rename"
          initialValue={renamingWaypoint?.name ?? ''}
          onDismiss={() => setRenamingWaypoint(null)}
          onSubmit={commitRenameWaypoint}
        />

        {/* Single confirm flow for every destructive delete (map/trail/folder/waypoint). */}
        <Dialog visible={confirmDelete !== null} onDismiss={() => setConfirmDelete(null)}>
          <Dialog.Title>{confirmDelete ? DELETE_COPY[confirmDelete.kind].title : ''}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {confirmDelete ? DELETE_COPY[confirmDelete.kind].body(confirmDelete.name) : ''}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmDelete(null)}>Cancel</Button>
            <Button textColor={theme.colors.error} onPress={onConfirmDelete}>
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {/* "Set category" for an existing trail (⋮ menu → Set category). */}
      <SetCategoryDialog trackId={categoryTarget} onDismiss={() => setCategoryTarget(null)} />

      {/* Waypoint note + photo editor (row tap) — the same dialog the map's
          pins open, dispatching to the same libraryStore actions. */}
      <WaypointEditorDialog
        waypoint={editWaypoint}
        name={wpName}
        onChangeName={setWpName}
        draft={wpDraft}
        onChangeDraft={setWpDraft}
        onSave={saveWaypoint}
        onDelete={deleteWaypointFromEditor}
        onSetPhoto={setWaypointPhoto}
      />

      {/* Trail filter panel (header sort/filter button). Stays mounted so its
          draft inputs survive close/reopen and keep matching the active filter. */}
      <TrackFilterDialog
        visible={filterOpen}
        onDismiss={() => setFilterOpen(false)}
        sortKey={sortKey}
        onApply={applyFilterAndSort}
      />

      <Snackbar
        visible={snack !== null}
        onDismiss={dismissSnack}
        duration={Number.POSITIVE_INFINITY}
      >
        {snack ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Board: 52 dp, 16 dp left / 4 dp right, 28/800 title then 48 dp actions.
  header: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.lg,
    paddingRight: space.xs,
    gap: 2,
  },
  title: { flex: 1, fontSize: 28, lineHeight: 34, fontWeight: '800', letterSpacing: -0.3 },
  selectionTitle: { flex: 1, fontSize: 20, lineHeight: 26, fontWeight: '700' },
  organize: {
    minHeight: target.min,
    paddingHorizontal: 10,
    justifyContent: 'center',
  },
  organizeLabel: { fontSize: 16, lineHeight: 20, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  headerButton: { margin: 0, width: target.min, height: target.min },
  headerIcon: {
    width: target.min,
    height: target.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBadge: { position: 'absolute', top: 4, right: 4 },
  searchbar: { marginHorizontal: space.md, marginVertical: space.xs },
  menuButton: { margin: 0, width: 44, height: target.min },
  dragHandle: {
    width: 36,
    height: target.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  folderActions: { flexDirection: 'row', alignItems: 'center' },
  rowExtra: { paddingLeft: space.lg, paddingRight: space.lg, paddingBottom: space.sm },
  retry: { alignSelf: 'flex-start' },
  overlayLabel: { marginBottom: 2, marginTop: 4 },
  checkboxItem: { paddingVertical: 0, paddingHorizontal: 0 },
  // Paper right-aligns a leading-position label; left-align it so "Page N"
  // reads as the label of the box next to it, not as a stray right-edge word.
  checkboxLabel: { textAlign: 'left', marginLeft: 4 },
  loader: { paddingVertical: 24 },
  hint: { paddingHorizontal: space.lg, paddingVertical: space.md, fontSize: 14, lineHeight: 20 },
  emptyRowTitle: { fontWeight: '700' },
});

import { mapDocumentBounds } from '@core/library/mapBounds';
import { primaryGeoreferences } from '@core/geo/geopdf/primary';
import type { Area, MapDocument, TrackSummary, Waypoint, WaypointIcon } from '@core/models';
import { polygonAreaM2 } from '@core/draw/geometry';
import { formatAreaSize, sortAreasNewestFirst } from '@core/library/areas';
import { describeUploadOutcome } from '@core/strava/upload';
import { reportError } from '@lib/errorReporting';
import { uploadTrackToStrava } from '@lib/strava';
import { useImportStore } from '@state/importStore';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { useOverlayStatusStore } from '@state/overlayStatusStore';
import { useSettingsStore } from '@state/settingsStore';
import { useStravaStore } from '@state/stravaStore';
import * as Sharing from 'expo-sharing';
import { useRouter } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ListRenderItem,
} from 'react-native';
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
import { countBySource, sourceLabel } from '@core/import/origin';
import type { ActivitySourceId } from '@core/import/sources';
import { countActiveFilters, filterTracks, type TrackFilter } from '@core/library/filterTracks';
import {
  shortDate,
  showsKind,
  typeCounts,
  type LibraryTypeFilter,
} from '@core/library/libraryRows';
import { isSearchActive, searchTracks } from '@core/library/searchTracks';
import { sortTracks, type SortKey } from '@core/library/sortTracks';
import { groupByFolder } from '@core/library/folders';
import { libraryListItems, type LibraryListItem } from '@core/library/libraryListItems';
import { georeferenceNotice } from '@core/library/overlayPages';
import {
  overlayDetailStatusKey,
  overlayStatusKey,
  renderStatusLine,
} from '@core/library/overlayStatus';
import { notePreview, sortWaypointsNewestFirst } from '@core/library/waypoints';
import { space, target } from '@ui/tokens';
import { useDisplayCondition } from '@ui/displayCondition';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { ScreenHeader } from '@ui/components/ScreenHeader';
import { waypointIconGlyph } from '@core/library/waypointIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WaypointEditorDialog } from '../map/components/WaypointEditorDialog';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import {
  ContourTexture,
  LibraryEmptyState,
  SectionHeader,
  TypeFilterChips,
} from './components/LibraryChrome';
import { AreaRow, MapRow, OnMapChip, RowDivider, WaypointRow } from './components/LibraryRows';
import { writeAreaGeoJson } from '../map/draw/saveDrawn';
import { MoveToFolderItems } from './components/MoveToFolderItems';
import { TrackListRow, type TrackRowActions } from './components/TrackListRow';
import { useDebouncedValue } from '@features/common/useDebouncedValue';
import { ImportJobCard } from '../import/ImportJobCard';
import { ImportSheet } from '../import/ImportSheet';
import { activityImportMessage, pickAndImportActivityFiles } from './importActivities';
import { pickAndImportMaps } from './importMap';
import { mergeLibraryTracks } from './mergeTracks';
import { NameDialog } from './NameDialog';
import { DragGhost } from './DragGhost';
import { useDragToFolder, type DragItem } from './useDragToFolder';
import { SetCategoryDialog } from './SetCategoryDialog';
import { TrackFilterDialog } from './TrackFilterDialog';
import { useTrackElevationPreview } from './useTrackElevationPreview';

/** Quiet time after a keystroke before the list re-filters. */
const SEARCH_DEBOUNCE_MS = 200;

const keyOfItem = (item: LibraryListItem) => item.key;

// One confirm flow covers every destructive delete in the Library; the copy
// spells out exactly what is (and is not) lost for each kind.
type DeleteTarget = {
  kind: 'map' | 'track' | 'folder' | 'waypoint' | 'area';
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
    area: {
      title: 'Delete area',
      body: (name) => `Delete area "${name}"? Its note and photos are permanently deleted.`,
    },
  };

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
  const night = useDisplayCondition() === 'night';

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
  // Drawn areas (#503) and the map's drawing-tool requests (#502/#503).
  const areas = useLibraryStore((s) => s.areas);
  const removeArea = useLibraryStore((s) => s.removeArea);
  const setDrawRequest = useMapStore((s) => s.setDrawRequest);
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
    kind: 'map' | 'track' | 'waypoint' | 'area';
    id: string;
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // Organize mode (revamp §5): drag grips and folder rename/delete appear
  // only here, like Files/Photos — the everyday list carries none of them.
  const [organizing, setOrganizing] = useState(false);
  // All · Trails · Maps · Waypoints. A view, not a preference: session-only.
  const [typeFilter, setTypeFilter] = useState<LibraryTypeFilter>('all');
  // "From Strava" (etc.) chips: trails imported from one connected source.
  // Session-only like the type chips; a source with no trails left drops out.
  const [sourceFilter, setSourceFilter] = useState<ActivitySourceId | null>(null);
  const sourceCounts = useMemo(() => countBySource(tracks), [tracks]);
  const activeSource = sourceFilter !== null && sourceCounts[sourceFilter] ? sourceFilter : null;
  // The Import activities sheet: opened from the "+" menu here, or asked for
  // from Settings › Connections (a store request, so it survives the tab switch).
  const [importSheetOpen, setImportSheetOpen] = useState(false);
  const sheetRequest = useImportStore((s) => s.sheetRequest);
  const clearSheetRequest = useImportStore((s) => s.clearSheetRequest);
  const closeImportSheet = () => {
    setImportSheetOpen(false);
    clearSheetRequest();
  };
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
  // The list filters on the query once typing pauses (#494): re-filtering and
  // re-laying out a 2,000-trail list per keystroke made the field lag.
  // Clearing applies at once.
  const appliedQuery = useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS, (q) => q.trim() === '');
  const searching = isSearchActive(appliedQuery);
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery('');
  };
  // Either narrowing in effect: both hide trails, so both switch the section
  // header to its "(visible/total)" form and stand the Maps section down.
  const narrowed = activeFilterCount > 0 || searching || activeSource !== null;
  // Derived once per data change, not per render: this screen re-renders on
  // every card-menu open, every section collapse, every selection tap and every
  // drag-hover, and both of these walk (and re-allocate) the whole library.
  // search → filter → sort → group, the same four pure passes in the same
  // order everywhere. Search runs first because it is the coarsest cut; sorting
  // BEFORE grouping is what orders trails inside each folder while leaving the
  // folders themselves in their user-defined order.
  const visibleTracks = useMemo(
    () =>
      sortTracks(
        filterTracks(searchTracks(tracks, appliedQuery, folders), filter).filter(
          (t) => activeSource === null || t.origin?.source === activeSource,
        ),
        sortKey,
      ),
    [tracks, appliedQuery, folders, filter, sortKey, activeSource],
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
  const sortedAreas = useMemo(() => sortAreasNewestFirst(areas), [areas]);
  const chipCounts = typeCounts({
    trails: tracks.length,
    maps: maps.length,
    waypoints: waypoints.length,
    areas: areas.length,
  });
  // A source chip shows that source's trails only (like the Trails chip).
  const effectiveType: LibraryTypeFilter = activeSource ? 'trails' : typeFilter;
  const showMaps = showsKind(effectiveType, 'maps') && !narrowed;
  const showTrails = showsKind(effectiveType, 'trails');
  const showWaypoints = showsKind(effectiveType, 'waypoints');
  const showAreas = showsKind(effectiveType, 'areas');
  const sourceChips = (Object.keys(sourceCounts) as ActivitySourceId[]).map((id) => ({
    id,
    label: `From ${sourceLabel(id)}`,
    count: sourceCounts[id] ?? 0,
  }));

  // Drag-and-drop moves (Organize mode): each row's grip drags a ghost chip
  // onto a folder (or Ungrouped) header. The ⋮ move-to-folder menu remains
  // for one-handed use. Grips render only once a folder exists.
  const listRef = useRef<FlatList<LibraryListItem>>(null);
  const scrollListTo = useCallback(
    (y: number) => listRef.current?.scrollToOffset({ offset: y, animated: false }),
    [],
  );
  const {
    dragging,
    hovered: dragHovered,
    ghost: dragGhost,
    registerTarget,
    handleProps,
    onScroll: onDragScroll,
    onWindowHeight: onDragWindowHeight,
  } = useDragToFolder({
    scrollTo: scrollListTo,
    onDrop: (item, target) => {
      const folderName = target === null ? null : folders.find((f) => f.id === target)?.name;
      // A target that no longer exists (deleted mid-drag, #303) is not a move.
      if (folderName === undefined) return;
      setItemFolder(item.kind, item.id, target);
      showSnack(folderName === null ? 'Removed from folder' : `Moved to "${folderName}"`);
    },
  });
  const hasFolders = folders.length > 0;
  const grip = hasFolders && organizing;
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

  // GPX, FIT, TCX and Strava/Garmin export archives (#431). A bulk archive can
  // hold thousands of activities: the header spinner shows it's working, and
  // the snackbar counts progress (throttled) until the final summary.
  const onImportGpx = async () => {
    setBusy(true);
    let lastProgressAt = 0;
    const result = await pickAndImportActivityFiles(tracks, (done, total) => {
      const now = Date.now();
      if (total < 10 || now - lastProgressAt < 1000) return;
      lastProgressAt = now;
      showSnack(`Importing activities… ${done} of ${total}`);
    });
    setBusy(false);
    if (result.kind === 'imported') {
      addTracks(result.items);
      showSnack(activityImportMessage(result));
    } else if (result.kind === 'error') {
      showSnack(`Import failed: ${result.message}`);
    }
  };

  const openMap = (id: string) => {
    setActiveMap(id);
    // Fly to it, like a trail: the map may be far from where the camera is.
    const doc = maps.find((m) => m.id === id);
    const bbox = doc ? mapDocumentBounds(doc) : null;
    if (bbox) setFocusBounds(bbox);
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
  // its record-start sheet; "Browse maps near you" opens the Explore tab.
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
  const setWaypointIcon = (icon: WaypointIcon | undefined) => {
    // Applied straight away, like the photo: the row behind the dialog redraws
    // with the new mark, which is the whole point of choosing one.
    if (editWpId) updateWaypoint(editWpId, { icon: icon ?? null });
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
    else if (kind === 'area') removeArea(id);
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

  const moveToFolderItems = (
    kind: 'map' | 'track' | 'waypoint',
    id: string,
    folderId: string | undefined,
  ) => (
    <MoveToFolderItems
      folders={folders}
      folderId={folderId}
      onMove={(target) => setItemFolder(kind, id, target)}
    />
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

  // Trail rows are memoized (TrackListRow): they get ONE actions object whose
  // identity never changes, each entry forwarding to the latest handler, so a
  // re-render of this screen (a menu, a selection tap, a drag hover) re-renders
  // only the rows whose own props changed.
  const trackHandlers = {
    press: (t: TrackSummary) =>
      selectionMode ? toggleTrackSelected(t.id) : router.navigate(`/trail3d/${t.id}`),
    longPress: (t: TrackSummary) => toggleTrackSelected(t.id),
    openMenu: (t: TrackSummary) => setCardMenu({ kind: 'track', id: t.id }),
    closeMenu: () => setCardMenu(null),
    rename: (t: TrackSummary) => setRenamingTrack({ id: t.id, name: t.name }),
    viewOnMap: (t: TrackSummary) => viewTrack(t.id),
    toggleElevation: (t: TrackSummary) => toggleElevation(t.id),
    share: (t: TrackSummary) => void shareTrack(t.fileUri),
    sendToStrava: (t: TrackSummary) => void sendToStrava(t),
    trim: (t: TrackSummary) => trimTrack(t.id),
    // A route drawn on the map reopens in the drawing tool (#502).
    editRoute: (t: TrackSummary) => {
      setDrawRequest({ kind: 'edit-route', trackId: t.id });
      router.navigate('/');
    },
    merge: (t: TrackSummary) => {
      if (!selectedTrackIds.includes(t.id)) toggleTrackSelected(t.id);
    },
    setCategory: (t: TrackSummary) => setCategoryTarget(t.id),
    moveToFolder: (t: TrackSummary, folderId: string | null) =>
      setItemFolder('track', t.id, folderId),
    remove: (t: TrackSummary) => setConfirmDelete({ kind: 'track', id: t.id, name: t.name }),
    dragHandleProps: handleProps,
  } satisfies TrackRowActions;
  const trackHandlersRef = useRef(trackHandlers);
  useEffect(() => {
    trackHandlersRef.current = trackHandlers;
  });
  const [trackActions] = useState<TrackRowActions>(() => ({
    press: (t) => trackHandlersRef.current.press(t),
    longPress: (t) => trackHandlersRef.current.longPress(t),
    openMenu: (t) => trackHandlersRef.current.openMenu(t),
    closeMenu: () => trackHandlersRef.current.closeMenu(),
    rename: (t) => trackHandlersRef.current.rename(t),
    viewOnMap: (t) => trackHandlersRef.current.viewOnMap(t),
    toggleElevation: (t) => trackHandlersRef.current.toggleElevation(t),
    share: (t) => trackHandlersRef.current.share(t),
    sendToStrava: (t) => trackHandlersRef.current.sendToStrava(t),
    trim: (t) => trackHandlersRef.current.trim(t),
    editRoute: (t) => trackHandlersRef.current.editRoute(t),
    merge: (t) => trackHandlersRef.current.merge(t),
    setCategory: (t) => trackHandlersRef.current.setCategory(t),
    moveToFolder: (t, folderId) => trackHandlersRef.current.moveToFolder(t, folderId),
    remove: (t) => trackHandlersRef.current.remove(t),
    dragHandleProps: (item) => trackHandlersRef.current.dragHandleProps(item),
  }));
  const selectedSet = useMemo(() => new Set(selectedTrackIds), [selectedTrackIds]);
  const menuTrackId = cardMenu?.kind === 'track' ? cardMenu.id : null;

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
        glyph={waypointIconGlyph(w.icon)}
        accessibilityLabel={`${w.label} — edit note and photo, long-press for more options`}
        onPress={() => openWaypointEditor(w)}
        onLongPress={() => setCardMenu({ kind: 'waypoint', id: w.id })}
        leading={dragHandle({ kind: 'waypoint', id: w.id, label: w.label })}
        trailing={waypointMenu(w)}
      />
    );
  };

  // Drawn areas (#503): the row opens the area's card on the map; the ⋮ menu
  // reshapes it, shares it as GeoJSON, or deletes it (the shared confirm).
  const showAreaOnMap = (a: Area) => {
    setDrawRequest({ kind: 'show-area', areaId: a.id });
    router.navigate('/');
  };
  const shareArea = async (a: Area) => {
    try {
      if (!(await Sharing.isAvailableAsync())) {
        showSnack('Sharing is not available on this device');
        return;
      }
      await Sharing.shareAsync(writeAreaGeoJson(a), {
        mimeType: 'application/geo+json',
        UTI: 'public.json',
      });
    } catch (err) {
      reportError(err, 'area-share');
      showSnack('Could not share the area');
    }
  };
  const areaMenu = (a: Area) => (
    <Menu
      visible={cardMenu?.kind === 'area' && cardMenu.id === a.id}
      onDismiss={() => setCardMenu(null)}
      anchor={
        <IconButton
          icon="dots-vertical"
          size={22}
          iconColor={tokens.inkMuted}
          style={styles.menuButton}
          onPress={() => setCardMenu({ kind: 'area', id: a.id })}
          accessibilityLabel="Area options"
        />
      }
    >
      <Menu.Item
        leadingIcon="map-marker-radius-outline"
        title="Show on map"
        onPress={() => {
          setCardMenu(null);
          showAreaOnMap(a);
        }}
      />
      <Menu.Item
        leadingIcon="vector-polygon"
        title="Edit shape"
        onPress={() => {
          setCardMenu(null);
          setDrawRequest({ kind: 'edit-area-shape', areaId: a.id });
          router.navigate('/');
        }}
      />
      <Menu.Item
        leadingIcon="share-variant"
        title="Share GeoJSON"
        onPress={() => {
          setCardMenu(null);
          void shareArea(a);
        }}
      />
      <Divider />
      <Menu.Item
        leadingIcon="trash-can-outline"
        title="Delete area"
        onPress={() => {
          setCardMenu(null);
          setConfirmDelete({ kind: 'area', id: a.id, name: a.name });
        }}
      />
    </Menu>
  );
  const renderAreaRow = (a: Area) => {
    const preview = notePreview(a.note);
    const size = formatAreaSize(polygonAreaM2(a.ring), units);
    return (
      <AreaRow
        key={a.id}
        name={a.name}
        detail={preview !== null ? `${size} · ${preview}` : size}
        caption={[shortDate(a.createdAt, nowMs), ...(a.tags ?? [])].join(' · ')}
        color={a.color}
        photoUri={a.photoUris?.[0]}
        accessibilityLabel={`${a.name}, area ${size} — show on map, long-press for more options`}
        onPress={() => showAreaOnMap(a)}
        onLongPress={() => setCardMenu({ kind: 'area', id: a.id })}
        trailing={areaMenu(a)}
      />
    );
  };

  const emptyRow = (title: string, description: string) => (
    <List.Item title={title} description={description} titleStyle={styles.emptyRowTitle} />
  );

  // The whole Library as one flat list (headers, rows, empty states), built
  // once per data or view change and virtualized by the FlatList below.
  const items = useMemo(
    () =>
      libraryListItems({
        maps,
        trackCount: tracks.length,
        visibleTracks,
        sortedWaypoints,
        hasFolders,
        grouped,
        sortedFolderWaypoints,
        sortedUngroupedWaypoints,
        showMaps,
        showTrails,
        showWaypoints,
        effectiveType,
        organizing,
        collapsed,
        narrowed,
        searchText: searching ? appliedQuery.trim() : null,
        activeFilterCount,
        sortedAreas,
        showAreas,
      }),
    [
      maps,
      tracks.length,
      visibleTracks,
      sortedWaypoints,
      hasFolders,
      grouped,
      sortedFolderWaypoints,
      sortedUngroupedWaypoints,
      showMaps,
      showTrails,
      showWaypoints,
      effectiveType,
      organizing,
      collapsed,
      narrowed,
      searching,
      appliedQuery,
      activeFilterCount,
      sortedAreas,
      showAreas,
    ],
  );

  const renderItem: ListRenderItem<LibraryListItem> = ({ item }) => {
    switch (item.kind) {
      case 'header':
        return sectionHeader({
          key: item.section,
          title: item.title,
          count: item.count,
          first: item.first,
          dropTarget: item.dropTarget,
          actions:
            organizing && item.folderId !== undefined
              ? folderActions(item.folderId, item.title)
              : undefined,
        });
      case 'empty':
        return emptyRow(item.title, item.description);
      case 'map':
        return (
          <>
            {item.divider && <RowDivider />}
            {renderMapRow(item.map)}
          </>
        );
      case 'waypoint':
        return (
          <>
            {item.divider && <RowDivider />}
            {renderWaypointRow(item.waypoint)}
          </>
        );
      case 'area':
        return (
          <>
            {item.divider && <RowDivider />}
            {renderAreaRow(item.area)}
          </>
        );
      case 'track': {
        const t = item.track;
        const expanded = expandedTrack === t.id;
        return (
          <TrackListRow
            track={t}
            divider={item.divider}
            customCategories={customCategories}
            night={night}
            units={units}
            nowMs={nowMs}
            selecting={selectionMode}
            selected={selectedSet.has(t.id)}
            menuOpen={menuTrackId === t.id}
            elevation={expanded ? (elevationPreview?.points ?? null) : undefined}
            grip={grip}
            stravaConnected={stravaConnected}
            folders={folders}
            actions={trackActions}
          />
        );
      }
    }
  };

  const folderActions = (id: string, name: string) => (
    <View style={styles.folderActions}>
      <IconButton
        icon="pencil-outline"
        size={20}
        onPress={() => setRenamingFolder({ id, name })}
        accessibilityLabel="Rename folder"
      />
      <IconButton
        icon="trash-can-outline"
        size={20}
        onPress={() => setConfirmDelete({ kind: 'folder', id, name })}
        accessibilityLabel="Delete folder"
      />
    </View>
  );

  // First run: nothing at all in the Library.
  const libraryEmpty =
    maps.length === 0 &&
    tracks.length === 0 &&
    waypoints.length === 0 &&
    areas.length === 0 &&
    !hasFolders;

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
        leadingIcon="cloud-download-outline"
        title="Import activities…"
        onPress={() => {
          setImportOpen(false);
          setImportSheetOpen(true);
        }}
      />
      <Menu.Item
        leadingIcon="map-marker-path"
        title="Import trails (GPX, FIT, TCX, zip)"
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
    <ScreenHeader title="Library">
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
    </ScreenHeader>
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
              onChange={(next) => {
                setTypeFilter(next);
                setSourceFilter(null);
              }}
              extraChips={sourceChips}
              extraValue={activeSource}
              onExtraChange={(id) =>
                setSourceFilter((current) => (current === id ? null : (id as ActivitySourceId)))
              }
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
        <>
          <ImportJobCard />
          <LibraryEmptyState
            busy={busy}
            onRecord={recordFromEmpty}
            onImportGpx={() => void onImportGpx()}
            onBrowseMaps={() => router.navigate('/maps')}
          />
        </>
      ) : (
        <FlatList
          testID="library-list"
          ref={listRef}
          data={items}
          keyExtractor={keyOfItem}
          renderItem={renderItem}
          // Only rows near the screen are mounted (#494): ~3 screens above and
          // below, filled in 10 rows at a time. Rows are mixed (headers, maps
          // with notices, expandable trails), so heights are measured rather
          // than declared with getItemLayout.
          initialNumToRender={14}
          maxToRenderPerBatch={10}
          windowSize={7}
          updateCellsBatchingPeriod={40}
          removeClippedSubviews={Platform.OS === 'android'}
          ListHeaderComponent={
            <>
              <ImportJobCard />
              {organizing && !hasFolders && (
                <Text style={[styles.hint, { color: tokens.inkMuted }]}>
                  Create a folder with + to group trails, maps and waypoints. Grips, rename and
                  delete for folders appear here.
                </Text>
              )}
            </>
          }
          scrollEnabled={dragging === null}
          onScroll={(e) => onDragScroll(e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={32}
          onLayout={(e) => onDragWindowHeight(e.nativeEvent.layout.height + e.nativeEvent.layout.y)}
          contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
        />
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
        onSetIcon={setWaypointIcon}
      />

      {/* Trail filter panel (header sort/filter button). Stays mounted so its
          draft inputs survive close/reopen and keep matching the active filter. */}
      <TrackFilterDialog
        visible={filterOpen}
        onDismiss={() => setFilterOpen(false)}
        sortKey={sortKey}
        onApply={applyFilterAndSort}
      />

      <ImportSheet
        visible={importSheetOpen || sheetRequest !== null}
        initialSource={sheetRequest?.source ?? null}
        onClose={closeImportSheet}
        onImportFiles={() => void onImportGpx()}
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
  showMore: { alignSelf: 'center', marginVertical: space.md },
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

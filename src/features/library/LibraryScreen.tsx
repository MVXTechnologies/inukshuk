import { parseGpx } from '@core/geo/gpx';
import type { TrackPoint, TrackSummary, Waypoint } from '@core/models';
import { describeUploadOutcome } from '@core/strava/upload';
import * as storage from '@data/storage';
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatPace,
  formatTimestamp,
} from '@lib/format';
import { reportError } from '@lib/errorReporting';
import { uploadTrackToStrava } from '@lib/strava';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { useStravaStore } from '@state/stravaStore';
import * as Sharing from 'expo-sharing';
import { useRouter } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Appbar,
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  Dialog,
  Divider,
  FAB,
  Icon,
  IconButton,
  List,
  Menu,
  Portal,
  Snackbar,
  Text,
  TouchableRipple,
  useTheme,
} from 'react-native-paper';
import { bundleCounts } from '@core/library/bundles';
import { findCategory } from '@core/library/categories';
import { countActiveFilters, filterTracks, type TrackFilter } from '@core/library/filterTracks';
import { folderItemCount, groupByFolder } from '@core/library/folders';
import { notePreview, sortWaypointsNewestFirst } from '@core/library/waypoints';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ElevationProfile } from '../common/components/ElevationProfile';
import { WaypointEditorDialog } from '../map/components/WaypointEditorDialog';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { pickAndImportGpxFiles } from './importGpx';
import { pickAndImportMaps } from './importMap';
import { mergeLibraryTracks } from './mergeTracks';
import { NameDialog } from './NameDialog';
import { SetCategoryDialog } from './SetCategoryDialog';
import { TrackFilterDialog } from './TrackFilterDialog';

// One confirm flow covers every destructive delete in the Library; the copy
// spells out exactly what is (and is not) lost for each kind.
type DeleteTarget = {
  kind: 'map' | 'track' | 'bundle' | 'folder' | 'waypoint';
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
    bundle: {
      title: 'Delete bundle',
      body: (name) => `Delete bundle "${name}"? Its maps and trails stay in the library.`,
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

export function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const theme = useTheme();

  const maps = useLibraryStore((s) => s.maps);
  const tracks = useLibraryStore((s) => s.tracks);
  const addMap = useLibraryStore((s) => s.addMap);
  const removeMap = useLibraryStore((s) => s.removeMap);
  const setActiveMap = useLibraryStore((s) => s.setActiveMap);
  const toggleMapPage = useLibraryStore((s) => s.toggleMapPage);
  const addTrack = useLibraryStore((s) => s.addTrack);
  const removeTrack = useLibraryStore((s) => s.removeTrack);
  const bundles = useLibraryStore((s) => s.bundles);
  const addBundle = useLibraryStore((s) => s.addBundle);
  const removeBundle = useLibraryStore((s) => s.removeBundle);
  const toggleBundleMap = useLibraryStore((s) => s.toggleBundleMap);
  const toggleBundleTrack = useLibraryStore((s) => s.toggleBundleTrack);
  const activateBundle = useLibraryStore((s) => s.activateBundle);
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
  const setFocusBounds = useMapStore((s) => s.setFocusBounds);
  const setInspectIntent = useMapStore((s) => s.setInspectIntent);
  const setFocusWaypoint = useMapStore((s) => s.setFocusWaypoint);
  const stravaConnected = useStravaStore((s) => s.connection !== null);

  const [busy, setBusy] = useState(false);
  const { message: snack, show: showSnack, dismiss: dismissSnack } = useTimedSnackbar(3500);
  const [expandedTrack, setExpandedTrack] = useState<string | null>(null);
  const [expandedMap, setExpandedMap] = useState<string | null>(null);
  const [trackPoints, setTrackPoints] = useState<Record<string, TrackPoint[]>>({});
  const [editingBundle, setEditingBundle] = useState<string | null>(null);
  const [newBundleVisible, setNewBundleVisible] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleSection = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));
  const [cardMenu, setCardMenu] = useState<{
    kind: 'map' | 'track' | 'waypoint';
    id: string;
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [newFolderVisible, setNewFolderVisible] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DeleteTarget | null>(null);
  // Trail multi-select (long-press a trail to enter): ids in selection order,
  // which is the merge order for untimed tracks.
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const selectionMode = selectedTrackIds.length > 0;
  // "Set category" dialog target (opened from a trail's ⋮ menu).
  const [categoryTarget, setCategoryTarget] = useState<string | null>(null);
  // Trail filter (appbar filter icon). The criteria are built by the filter
  // dialog; the pure predicate lives in @core/library/filterTracks.
  const [filter, setFilter] = useState<TrackFilter>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const activeFilterCount = countActiveFilters(filter);
  const visibleTracks = filterTracks(tracks, filter);

  const grouped = groupByFolder(folders, maps, visibleTracks);

  const onImport = async () => {
    setBusy(true);
    const result = await pickAndImportMaps();
    setBusy(false);
    if (result.kind === 'imported') {
      // Add in picked order (addMap prepends, so add last-first to preserve it).
      [...result.docs].reverse().forEach(addMap);
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
      [...result.items]
        .reverse()
        .forEach(({ track, fileUri, notes }) => addTrack(track, fileUri, notes));
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

  // "Trim" menu item: same as "View on map", plus a one-shot intent the Map
  // screen consumes to open the trail's inspect panel straight into trim mode.
  const trimTrack = (id: string) => {
    setInspectIntent({ trackId: id, trim: true });
    viewTrack(id);
  };

  // Waypoint editor (same dialog + libraryStore semantics as tapping a pin on
  // the map). The dialog stays live against the store row while editing, so a
  // photo picked inside it shows up immediately.
  const [editWpId, setEditWpId] = useState<string | null>(null);
  const [wpDraft, setWpDraft] = useState('');
  const editWaypoint =
    editWpId === null ? null : (waypoints.find((w) => w.id === editWpId) ?? null);

  const openWaypointEditor = (w: Waypoint) => {
    setWpDraft(w.note ?? '');
    setEditWpId(w.id);
  };
  const saveWaypoint = () => {
    if (editWpId) updateWaypoint(editWpId, { note: wpDraft.trim() });
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

  const createBundle = (name: string) => {
    setNewBundleVisible(false);
    const id = addBundle(name || 'New bundle');
    setEditingBundle(id); // open it so the user can pick members right away
  };

  const createFolder = (name: string) => {
    setNewFolderVisible(false);
    addFolder(name || 'New folder');
  };

  const commitRenameFolder = (name: string) => {
    if (renamingFolder && name) renameFolder(renamingFolder.id, name);
    setRenamingFolder(null);
  };

  const onConfirmDelete = () => {
    if (!confirmDelete) return;
    const { kind, id } = confirmDelete;
    setConfirmDelete(null);
    if (kind === 'map') removeMap(id);
    else if (kind === 'track') removeTrack(id);
    else if (kind === 'bundle') removeBundle(id);
    else if (kind === 'waypoint')
      removeWaypoint(id); // photo cleanup is the store's job
    else removeFolder(id);
  };

  const onActivateBundle = (id: string, name: string) => {
    activateBundle(id); // turns on member maps' page overlays + member trails
    showSnack(`Activated "${name}"`);
    router.navigate('/');
  };

  const toggleElevation = async (id: string, fileUri: string) => {
    if (expandedTrack === id) {
      setExpandedTrack(null);
      return;
    }
    setExpandedTrack(id);
    if (!trackPoints[id]) {
      try {
        const gpx = await storage.readFileText(fileUri);
        const { points } = parseGpx(gpx);
        setTrackPoints((cache) => ({ ...cache, [id]: points }));
      } catch (err) {
        reportError(err, 'track-elevation-load');
        showSnack('Could not load elevation');
        setExpandedTrack(null);
      }
    }
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
      const { track, fileUri } = await mergeLibraryTracks(chosen);
      addTrack(track, fileUri);
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

  const sectionHeader = (key: string, title: string, action?: ReactNode) => (
    <TouchableRipple onPress={() => toggleSection(key)} accessibilityRole="button">
      <View style={styles.sectionHeaderRow}>
        <View style={styles.sectionHeaderLeft}>
          <Icon
            source={collapsed[key] ? 'chevron-right' : 'chevron-down'}
            size={24}
            color={theme.colors.onSurface}
          />
          <Text variant="titleSmall" style={styles.sectionTitle}>
            {title}
          </Text>
        </View>
        {action}
      </View>
    </TouchableRipple>
  );

  // A per-card overflow menu that handles both organization concerns: moving the
  // item into a folder (exclusive) and toggling its membership in bundles. The
  // menu stays open across taps so several bundles can be picked in one go.
  // Each organize section only appears once a folder/bundle exists — a section
  // of nothing but greyed-out placeholders is clutter, not guidance.
  const itemMenu = (kind: 'map' | 'track', id: string, name: string, folderId?: string) => (
    <Menu
      visible={cardMenu?.kind === kind && cardMenu.id === id}
      onDismiss={() => setCardMenu(null)}
      anchor={
        <IconButton
          icon="dots-vertical"
          onPress={() => setCardMenu({ kind, id })}
          accessibilityLabel="Organize"
        />
      }
    >
      {folders.length > 0 && (
        <>
          <Menu.Item disabled title="Move to folder" />
          {folders.map((f) => (
            <Menu.Item
              key={f.id}
              leadingIcon={folderId === f.id ? 'folder-check' : 'folder-outline'}
              title={f.name}
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
          <Divider />
        </>
      )}
      {bundles.length > 0 && (
        <>
          <Menu.Item disabled title="Add to bundle" />
          {bundles.map((b) => {
            const inBundle = kind === 'map' ? b.mapIds.includes(id) : b.trackIds.includes(id);
            return (
              <Menu.Item
                key={b.id}
                leadingIcon={inBundle ? 'checkbox-marked' : 'checkbox-blank-outline'}
                title={b.name}
                onPress={() =>
                  kind === 'map' ? toggleBundleMap(b.id, id) : toggleBundleTrack(b.id, id)
                }
              />
            );
          })}
          <Divider />
        </>
      )}
      <Menu.Item
        leadingIcon="trash-can-outline"
        title={kind === 'map' ? 'Delete map' : 'Delete trail'}
        onPress={() => {
          setCardMenu(null);
          setConfirmDelete({ kind, id, name });
        }}
      />
    </Menu>
  );

  const renderMapCard = (m: (typeof maps)[number]) => {
    const hasPages = m.georeferences.length > 0;
    const active = m.activePages.length;
    const expanded = expandedMap === m.id;
    return (
      <Card key={m.id} style={styles.trackCard} mode="contained">
        <View style={styles.trackRow}>
          <Pressable
            style={styles.trackMain}
            onPress={() => openMap(m.id)}
            accessibilityLabel={`${m.name} — view on map`}
          >
            <Icon source="map" size={22} color={theme.colors.onSurfaceVariant} />
            <View style={styles.mapTitleCol}>
              <Text variant="titleSmall" numberOfLines={1}>
                {m.name}
              </Text>
              <Text
                variant="bodySmall"
                numberOfLines={1}
                style={{ color: theme.colors.onSurfaceVariant }}
              >
                {hasPages
                  ? `${m.pageCount} page(s) · ${active}/${m.georeferences.length} shown`
                  : m.georeferenceWarning}
              </Text>
            </View>
          </Pressable>
          {hasPages && (
            <IconButton
              icon={expanded ? 'chevron-up' : 'chevron-down'}
              size={22}
              onPress={() => setExpandedMap(expanded ? null : m.id)}
              accessibilityLabel="Overlay pages"
            />
          )}
          {itemMenu('map', m.id, m.name, m.folderId)}
        </View>
        {hasPages && expanded && (
          <Card.Content>
            <Text variant="labelMedium" style={styles.overlayLabel}>
              Show as overlay
            </Text>
            {m.georeferences.map((g) => (
              <Checkbox.Item
                key={g.pageIndex}
                label={`Page ${g.pageIndex + 1}`}
                position="leading"
                status={m.activePages.includes(g.pageIndex) ? 'checked' : 'unchecked'}
                onPress={() => toggleMapPage(m.id, g.pageIndex)}
                style={styles.checkboxItem}
              />
            ))}
          </Card.Content>
        )}
      </Card>
    );
  };

  // Full overflow menu for a trail: every secondary action plus folder/bundle
  // membership, so the card itself only needs the profile-peek + this button.
  // The organize sections only appear once a folder/bundle exists (same rule
  // as itemMenu): placeholders like "No folders yet" were pure clutter.
  const trackMenu = (t: (typeof tracks)[number]) => (
    <Menu
      visible={cardMenu?.kind === 'track' && cardMenu.id === t.id}
      onDismiss={() => setCardMenu(null)}
      anchor={
        <IconButton
          icon="dots-vertical"
          size={22}
          onPress={() => setCardMenu({ kind: 'track', id: t.id })}
          accessibilityLabel="More options"
        />
      }
    >
      <Menu.Item
        leadingIcon="map-outline"
        title="View on map"
        onPress={() => {
          setCardMenu(null);
          viewTrack(t.id);
        }}
      />
      <Menu.Item
        leadingIcon="share-variant"
        title="Share GPX"
        onPress={() => {
          setCardMenu(null);
          shareTrack(t.fileUri);
        }}
      />
      {stravaConnected && (
        <Menu.Item
          leadingIcon="cloud-upload-outline"
          title="Send to Strava"
          onPress={() => {
            setCardMenu(null);
            sendToStrava(t);
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
      {folders.length > 0 && (
        <>
          <Divider />
          <Menu.Item disabled title="Move to folder" />
          {folders.map((f) => (
            <Menu.Item
              key={f.id}
              leadingIcon={t.folderId === f.id ? 'folder-check' : 'folder-outline'}
              title={f.name}
              onPress={() => setItemFolder('track', t.id, t.folderId === f.id ? null : f.id)}
            />
          ))}
          {t.folderId !== undefined && (
            <Menu.Item
              leadingIcon="folder-off-outline"
              title="Remove from folder"
              onPress={() => setItemFolder('track', t.id, null)}
            />
          )}
        </>
      )}
      {bundles.length > 0 && (
        <>
          <Divider />
          <Menu.Item disabled title="Add to bundle" />
          {bundles.map((b) => (
            <Menu.Item
              key={b.id}
              leadingIcon={b.trackIds.includes(t.id) ? 'checkbox-marked' : 'checkbox-blank-outline'}
              title={b.name}
              onPress={() => toggleBundleTrack(b.id, t.id)}
            />
          ))}
        </>
      )}
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

  const renderTrackCard = (t: (typeof tracks)[number]) => {
    const s = t.stats;
    const selected = selectedTrackIds.includes(t.id);
    // Activity category: colored left border + icon; uncategorized stays
    // neutral (no border, no icon). Colors are theme-safe (see categories.ts).
    const category = findCategory(t.category, customCategories);
    return (
      <Card
        key={t.id}
        style={[
          styles.trackCard,
          category !== null && { borderLeftWidth: 4, borderLeftColor: category.color },
          selected && { borderWidth: 2, borderColor: theme.colors.primary },
        ]}
        mode="contained"
      >
        <View style={styles.trackRow}>
          <Pressable
            style={styles.trackMain}
            // Long-press enters trail selection (for merging); while selecting,
            // taps toggle membership instead of opening the 3D view.
            onPress={() =>
              selectionMode ? toggleTrackSelected(t.id) : router.navigate(`/trail3d/${t.id}`)
            }
            onLongPress={() => toggleTrackSelected(t.id)}
            accessibilityLabel={
              selectionMode
                ? `${t.name} — ${selected ? 'deselect' : 'select'} for merge`
                : `${t.name} — open 3D view, long-press to select`
            }
          >
            {selectionMode && (
              <Icon
                source={selected ? 'checkbox-marked-circle' : 'checkbox-blank-circle-outline'}
                size={22}
                color={selected ? theme.colors.primary : theme.colors.onSurfaceVariant}
              />
            )}
            {!selectionMode && category !== null && (
              <Icon source={category.icon} size={22} color={category.color} />
            )}
            <View
              style={[
                styles.trackTitleCol,
                (selectionMode || category !== null) && styles.trackTitleColSelecting,
              ]}
            >
              <Text variant="titleSmall" numberOfLines={1}>
                {t.name}
              </Text>
              <Text
                variant="bodySmall"
                numberOfLines={1}
                style={{ color: theme.colors.onSurfaceVariant }}
              >
                {formatTimestamp(t.startedAt)}
              </Text>
            </View>
            <View style={styles.trackStatsCol}>
              {/* NBSP inside each value+unit pair: when the shrinking stats
                  column wraps this line, the break lands between stats, never
                  orphaning a unit onto its own line. */}
              <Text variant="labelSmall">
                {formatDistance(s.distanceM).replace(' ', ' ')} ·{' '}
                {`↑${formatElevation(s.ascentM)}`.replace(' ', ' ')}{' '}
                {`↓${formatElevation(s.descentM)}`.replace(' ', ' ')}
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {formatDuration(s.durationS)} · {formatPace(s.avgSpeedMps)}
              </Text>
            </View>
          </Pressable>
          <IconButton
            icon={expandedTrack === t.id ? 'chevron-up' : 'chart-areaspline'}
            size={22}
            onPress={() => toggleElevation(t.id, t.fileUri)}
            accessibilityLabel="Elevation profile"
          />
          {trackMenu(t)}
        </View>
        {expandedTrack === t.id &&
          (trackPoints[t.id] ? (
            <ElevationProfile
              points={trackPoints[t.id]!}
              ascentM={t.stats.ascentM}
              descentM={t.stats.descentM}
            />
          ) : (
            <ActivityIndicator style={styles.loader} />
          ))}
      </Card>
    );
  };

  // ⋮ / long-press menu for a waypoint row: jump the map to the pin, or delete
  // (through the same confirm flow as every other Library delete).
  const waypointMenu = (w: Waypoint) => (
    <Menu
      visible={cardMenu?.kind === 'waypoint' && cardMenu.id === w.id}
      onDismiss={() => setCardMenu(null)}
      anchor={
        <IconButton
          icon="dots-vertical"
          size={22}
          onPress={() => setCardMenu({ kind: 'waypoint', id: w.id })}
          accessibilityLabel="More options"
        />
      }
    >
      <Menu.Item
        leadingIcon="map-marker-radius-outline"
        title="Show on map"
        onPress={() => {
          setCardMenu(null);
          showWaypointOnMap(w);
        }}
      />
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

  const renderWaypointCard = (w: Waypoint) => {
    const preview = notePreview(w.note);
    return (
      <Card key={w.id} style={styles.trackCard} mode="contained">
        <View style={styles.trackRow}>
          <Pressable
            style={styles.trackMain}
            onPress={() => openWaypointEditor(w)}
            onLongPress={() => setCardMenu({ kind: 'waypoint', id: w.id })}
            accessibilityLabel={`${w.label} — edit note and photo, long-press for more options`}
          >
            <Icon source="map-marker" size={22} color={theme.colors.onSurfaceVariant} />
            <View style={styles.mapTitleCol}>
              <Text variant="titleSmall" numberOfLines={1}>
                {w.label}
              </Text>
              {preview !== null && (
                <Text
                  variant="bodySmall"
                  numberOfLines={1}
                  style={{ color: theme.colors.onSurfaceVariant }}
                >
                  {preview}
                </Text>
              )}
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {formatTimestamp(w.createdAt)}
              </Text>
            </View>
            {w.photoUri !== undefined && (
              <Image source={{ uri: w.photoUri }} style={styles.waypointThumb} />
            )}
          </Pressable>
          {waypointMenu(w)}
        </View>
      </Card>
    );
  };

  // Folder groups (cross-type: each folder shows its maps then its trails).
  const renderFolderGroups = () =>
    grouped.groups.map((g) => {
      const key = `folder:${g.folder.id}`;
      const count = folderItemCount(g);
      return (
        <List.Section key={key}>
          {sectionHeader(
            key,
            `${g.folder.name}${count ? ` (${count})` : ''}`,
            <View style={styles.rowEnd}>
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
            </View>,
          )}
          {collapsed[key] ? null : count === 0 ? (
            <List.Item
              title="Empty folder"
              description="Use a map or trail's ⋮ menu to move it here"
            />
          ) : (
            [...g.maps.map(renderMapCard), ...g.tracks.map(renderTrackCard)]
          )}
        </List.Section>
      );
    });

  const hasFolders = folders.length > 0;
  const ungroupedCount = grouped.ungroupedMaps.length + grouped.ungroupedTracks.length;

  return (
    <View style={styles.fill}>
      {selectionMode ? (
        // Trail selection mode (entered by long-pressing a trail card).
        <Appbar.Header>
          <Appbar.Action
            icon="close"
            onPress={() => setSelectedTrackIds([])}
            accessibilityLabel="Exit selection"
          />
          <Appbar.Content title={`${selectedTrackIds.length} selected`} />
          <Appbar.Action
            icon="call-merge"
            onPress={() => void onMergeSelected()}
            disabled={selectedTrackIds.length < 2 || merging}
            accessibilityLabel="Merge selected trails"
          />
        </Appbar.Header>
      ) : (
        <Appbar.Header>
          <Appbar.Content title="Library" />
          {/* Trail filter: the badge counts active criteria (distance, date,
              category, …) so a filtered-down list is never mistaken for a
              small library. */}
          <View>
            <Appbar.Action
              icon="filter-variant"
              onPress={() => setFilterOpen(true)}
              accessibilityLabel="Filter trails"
            />
            {activeFilterCount > 0 && (
              <Badge size={16} style={styles.filterBadge}>
                {activeFilterCount}
              </Badge>
            )}
          </View>
          {/* Exporting the library lives in Settings → "Download your data"
              (maps included); a second entry point here only duplicated it. */}
          <Appbar.Action
            icon="folder-plus-outline"
            onPress={() => setNewFolderVisible(true)}
            accessibilityLabel="New folder"
          />
        </Appbar.Header>
      )}

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}>
        {maps.length === 0 && tracks.length === 0 && (
          <Banner visible icon="map-search-outline" style={styles.banner}>
            Import a georeferenced PDF map to get started, then record trails from the Map tab.
          </Banner>
        )}

        <List.Section>
          {sectionHeader(
            'bundles',
            `Bundles${bundles.length ? ` (${bundles.length})` : ''}`,
            <Button compact icon="plus" onPress={() => setNewBundleVisible(true)}>
              New
            </Button>,
          )}
          {collapsed.bundles ? null : bundles.length === 0 ? (
            <List.Item
              title="No bundles yet"
              description="Group maps & trails to activate a whole set in one tap"
            />
          ) : (
            bundles.map((b) => {
              const counts = bundleCounts(b, maps, tracks);
              const editing = editingBundle === b.id;
              return (
                <Card key={b.id} style={styles.trackCard} mode="contained">
                  <Card.Title
                    title={b.name}
                    subtitle={`${counts.maps} map(s) · ${counts.tracks} trail(s)`}
                    left={(p) => <List.Icon {...p} icon="folder-multiple" />}
                    right={() => (
                      <View style={styles.rowEnd}>
                        <IconButton
                          icon="layers"
                          onPress={() => onActivateBundle(b.id, b.name)}
                          disabled={counts.maps + counts.tracks === 0}
                          accessibilityLabel={`Activate bundle ${b.name}`}
                        />
                        <IconButton
                          icon={editing ? 'chevron-up' : 'pencil-outline'}
                          onPress={() => setEditingBundle(editing ? null : b.id)}
                          accessibilityLabel={
                            editing ? `Close bundle ${b.name}` : `Edit bundle ${b.name}`
                          }
                        />
                        <IconButton
                          icon="trash-can-outline"
                          onPress={() =>
                            setConfirmDelete({ kind: 'bundle', id: b.id, name: b.name })
                          }
                          accessibilityLabel={`Delete bundle ${b.name}`}
                        />
                      </View>
                    )}
                  />
                  {editing && (
                    <Card.Content>
                      <Text variant="labelMedium" style={styles.overlayLabel}>
                        Maps in this bundle
                      </Text>
                      {maps.length === 0 && <Text variant="bodySmall">No maps imported yet</Text>}
                      {maps.map((m) => (
                        <Checkbox.Item
                          key={m.id}
                          label={m.name}
                          position="leading"
                          status={b.mapIds.includes(m.id) ? 'checked' : 'unchecked'}
                          onPress={() => toggleBundleMap(b.id, m.id)}
                          style={styles.checkboxItem}
                        />
                      ))}
                      <Text variant="labelMedium" style={styles.overlayLabel}>
                        Trails in this bundle
                      </Text>
                      {tracks.length === 0 && <Text variant="bodySmall">No trails yet</Text>}
                      {tracks.map((t) => (
                        <Checkbox.Item
                          key={t.id}
                          label={t.name}
                          position="leading"
                          status={b.trackIds.includes(t.id) ? 'checked' : 'unchecked'}
                          onPress={() => toggleBundleTrack(b.id, t.id)}
                          style={styles.checkboxItem}
                        />
                      ))}
                    </Card.Content>
                  )}
                </Card>
              );
            })
          )}
        </List.Section>

        <Divider />

        {renderFolderGroups()}

        {hasFolders
          ? // With folders: one cross-type "Ungrouped" catch-all for leftovers.
            ungroupedCount > 0 && (
              <List.Section>
                {sectionHeader('ungrouped', `Ungrouped (${ungroupedCount})`)}
                {collapsed.ungrouped
                  ? null
                  : [
                      ...grouped.ungroupedMaps.map(renderMapCard),
                      ...grouped.ungroupedTracks.map(renderTrackCard),
                    ]}
              </List.Section>
            )
          : // No folders yet: keep the familiar Maps + Recorded-trails split.
            [
              <List.Section key="maps">
                {sectionHeader('maps', `Maps${maps.length ? ` (${maps.length})` : ''}`)}
                {collapsed.maps ? null : maps.length === 0 ? (
                  <List.Item title="No maps yet" description="Tap the PDF icon to import one" />
                ) : (
                  maps.map(renderMapCard)
                )}
              </List.Section>,
              <Divider key="maps-divider" />,
              <List.Section key="trails">
                {sectionHeader(
                  'trails',
                  `Recorded trails${
                    tracks.length
                      ? activeFilterCount > 0
                        ? ` (${visibleTracks.length}/${tracks.length})`
                        : ` (${tracks.length})`
                      : ''
                  }`,
                )}
                {collapsed.trails ? null : tracks.length === 0 ? (
                  <List.Item
                    title="No trails yet"
                    description="Record one from the Map tab, or import a GPX file via the Import button"
                  />
                ) : visibleTracks.length === 0 ? (
                  <List.Item
                    title="No trails match the filters"
                    description="Adjust or clear the filters from the appbar's filter icon"
                  />
                ) : (
                  visibleTracks.map(renderTrackCard)
                )}
              </List.Section>,
            ]}

        {/* Standalone waypoints (map "+" speed-dial). Deliberately flat — they
            stay out of folders for now — and hidden entirely while there are
            none, so non-users of the feature never see an empty section. */}
        {waypoints.length > 0 && (
          <>
            <Divider />
            <List.Section>
              {sectionHeader('waypoints', `Waypoints (${waypoints.length})`)}
              {collapsed.waypoints
                ? null
                : sortWaypointsNewestFirst(waypoints).map(renderWaypointCard)}
            </List.Section>
          </>
        )}
      </ScrollView>

      {/* The FAB sits in normal flow inside an absolutely-positioned wrapper.
          If the FAB itself is the absolutely-positioned child of paper's Menu
          anchor (a zero-sized measuring View), Android clips touches to that
          0x0 wrapper and the FAB renders but is untouchable. Anchoring the
          absolute position on the wrapper gives it real bounds, so taps land. */}
      <View style={[styles.fabWrap, { bottom: insets.bottom + 16 }]}>
        <Menu
          visible={importOpen}
          onDismiss={() => setImportOpen(false)}
          anchor={
            <FAB
              icon="plus"
              label="Import"
              loading={busy}
              onPress={() => setImportOpen(true)}
              style={styles.fab}
            />
          }
        >
          <Menu.Item
            leadingIcon="map"
            title="Georeferenced map (PDF)"
            onPress={() => {
              setImportOpen(false);
              void onImport();
            }}
          />
          <Menu.Item
            leadingIcon="map-marker-path"
            title="GPX trail"
            onPress={() => {
              setImportOpen(false);
              void onImportGpx();
            }}
          />
        </Menu>
      </View>

      <Portal>
        <NameDialog
          visible={newBundleVisible}
          title="New bundle"
          label="Bundle name"
          onDismiss={() => setNewBundleVisible(false)}
          onSubmit={createBundle}
        />

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

        {/* Single confirm flow for every destructive delete (map/trail/bundle/folder). */}
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
        draft={wpDraft}
        onChangeDraft={setWpDraft}
        onSave={saveWaypoint}
        onDelete={deleteWaypointFromEditor}
        onSetPhoto={setWaypointPhoto}
      />

      {/* Trail filter panel (appbar filter icon). Stays mounted so its draft
          inputs survive close/reopen and keep matching the active filter. */}
      <TrackFilterDialog
        visible={filterOpen}
        onDismiss={() => setFilterOpen(false)}
        onApply={setFilter}
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
  banner: { marginBottom: 4 },
  rowEnd: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 8,
  },
  sectionHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  sectionTitle: { fontWeight: '700', paddingVertical: 12 },
  overlayLabel: { marginBottom: 2, marginTop: 4 },
  checkboxItem: { paddingVertical: 0, paddingHorizontal: 0 },
  trackCard: { marginHorizontal: 12, marginVertical: 6 },
  loader: { paddingVertical: 24 },
  trackRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14, paddingRight: 2 },
  trackMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  // The title column flexes into whatever the stats column leaves, but keeps a
  // readable floor; the stats column shrinks (wrapping its lines) rather than
  // crushing the title. Without the floor, a dense imported GPX (long stats +
  // category icon) squeezed the title to ~1 character and the un-clamped date
  // wrapped per-character into a very tall card.
  trackTitleCol: { flex: 1, minWidth: 96, paddingVertical: 8, paddingRight: 8 },
  trackTitleColSelecting: { paddingLeft: 10 },
  mapTitleCol: { flex: 1, paddingVertical: 8, paddingLeft: 10, paddingRight: 8 },
  trackStatsCol: { flexShrink: 1, alignItems: 'flex-end', paddingRight: 2 },
  waypointThumb: { width: 44, height: 44, borderRadius: 8, marginRight: 4 },
  fabWrap: { position: 'absolute', right: 16 },
  fab: { borderRadius: 28 },
  filterBadge: { position: 'absolute', top: 4, right: 4 },
});

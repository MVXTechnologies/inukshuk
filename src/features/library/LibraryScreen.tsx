import { parseGpx } from '@core/geo/gpx';
import type { TrackPoint, TrackSummary } from '@core/models';
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
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Appbar,
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
  TextInput,
  TouchableRipple,
  useTheme,
} from 'react-native-paper';
import { bundleCounts } from '@core/library/bundles';
import { folderItemCount, groupByFolder } from '@core/library/folders';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ElevationProfile } from '../common/components/ElevationProfile';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { pickAndImportGpxFiles } from './importGpx';
import { pickAndImportMaps } from './importMap';
import { mergeLibraryTracks } from './mergeTracks';

// One confirm flow covers every destructive delete in the Library; the copy
// spells out exactly what is (and is not) lost for each kind.
type DeleteTarget = { kind: 'map' | 'track' | 'bundle' | 'folder'; id: string; name: string };

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
  const setFocusBounds = useMapStore((s) => s.setFocusBounds);
  const setInspectIntent = useMapStore((s) => s.setInspectIntent);
  const stravaConnected = useStravaStore((s) => s.connection !== null);

  const [busy, setBusy] = useState(false);
  const { message: snack, show: showSnack, dismiss: dismissSnack } = useTimedSnackbar(3500);
  const [expandedTrack, setExpandedTrack] = useState<string | null>(null);
  const [expandedMap, setExpandedMap] = useState<string | null>(null);
  const [trackPoints, setTrackPoints] = useState<Record<string, TrackPoint[]>>({});
  const [editingBundle, setEditingBundle] = useState<string | null>(null);
  const [newBundleVisible, setNewBundleVisible] = useState(false);
  const [newBundleName, setNewBundleName] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleSection = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));
  const [cardMenu, setCardMenu] = useState<{ kind: 'map' | 'track'; id: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [newFolderVisible, setNewFolderVisible] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingFolder, setRenamingFolder] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DeleteTarget | null>(null);
  // Trail multi-select (long-press a trail to enter): ids in selection order,
  // which is the merge order for untimed tracks.
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const selectionMode = selectedTrackIds.length > 0;

  const grouped = groupByFolder(folders, maps, tracks);

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

  const createBundle = () => {
    const name = newBundleName.trim();
    setNewBundleVisible(false);
    setNewBundleName('');
    const id = addBundle(name || 'New bundle');
    setEditingBundle(id); // open it so the user can pick members right away
  };

  const createFolder = () => {
    const name = newFolderName.trim();
    setNewFolderVisible(false);
    setNewFolderName('');
    addFolder(name || 'New folder');
  };

  const commitRenameFolder = () => {
    if (renamingFolder) renameFolder(renamingFolder.id, renamingFolder.name);
    setRenamingFolder(null);
  };

  const onConfirmDelete = () => {
    if (!confirmDelete) return;
    const { kind, id } = confirmDelete;
    setConfirmDelete(null);
    if (kind === 'map') removeMap(id);
    else if (kind === 'track') removeTrack(id);
    else if (kind === 'bundle') removeBundle(id);
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
    return (
      <Card
        key={t.id}
        style={[
          styles.trackCard,
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
            <View style={[styles.trackTitleCol, selectionMode && styles.trackTitleColSelecting]}>
              <Text variant="titleSmall" numberOfLines={1}>
                {t.name}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {formatTimestamp(t.startedAt)}
              </Text>
            </View>
            <View style={styles.trackStatsCol}>
              <Text variant="labelSmall">
                {formatDistance(s.distanceM)} · ↑{formatElevation(s.ascentM)} ↓
                {formatElevation(s.descentM)}
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
                  `Recorded trails${tracks.length ? ` (${tracks.length})` : ''}`,
                )}
                {collapsed.trails ? null : tracks.length === 0 ? (
                  <List.Item
                    title="No trails yet"
                    description="Record one from the Map tab, or import a GPX file via the Import button"
                  />
                ) : (
                  tracks.map(renderTrackCard)
                )}
              </List.Section>,
            ]}
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
        <Dialog visible={newBundleVisible} onDismiss={() => setNewBundleVisible(false)}>
          <Dialog.Title>New bundle</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Bundle name"
              value={newBundleName}
              onChangeText={setNewBundleName}
              autoFocus
              onSubmitEditing={createBundle}
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setNewBundleVisible(false)}>Cancel</Button>
            <Button onPress={createBundle}>Create</Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={newFolderVisible} onDismiss={() => setNewFolderVisible(false)}>
          <Dialog.Title>New folder</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Folder name"
              value={newFolderName}
              onChangeText={setNewFolderName}
              autoFocus
              onSubmitEditing={createFolder}
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setNewFolderVisible(false)}>Cancel</Button>
            <Button onPress={createFolder}>Create</Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={renamingFolder !== null} onDismiss={() => setRenamingFolder(null)}>
          <Dialog.Title>Rename folder</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Folder name"
              value={renamingFolder?.name ?? ''}
              onChangeText={(name) => setRenamingFolder((f) => (f ? { ...f, name } : f))}
              autoFocus
              onSubmitEditing={commitRenameFolder}
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setRenamingFolder(null)}>Cancel</Button>
            <Button onPress={commitRenameFolder}>Rename</Button>
          </Dialog.Actions>
        </Dialog>

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
  trackTitleCol: { flex: 1, paddingVertical: 8, paddingRight: 8 },
  trackTitleColSelecting: { paddingLeft: 10 },
  mapTitleCol: { flex: 1, paddingVertical: 8, paddingLeft: 10, paddingRight: 8 },
  trackStatsCol: { alignItems: 'flex-end', paddingRight: 2 },
  fabWrap: { position: 'absolute', right: 16 },
  fab: { borderRadius: 28 },
});

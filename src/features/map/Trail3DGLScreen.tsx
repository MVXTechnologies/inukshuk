import { parseGpx } from '@core/geo/gpx';
import {
  computeSegmentedTrackStats,
  haversineMeters,
  interpolateTrackAtDistance,
  withDemElevations,
  type TrackPointAt,
} from '@core/geo/track';
import { orderNotes } from '@core/library/notes';
import { padBbox } from '@core/geo/terrain';
import type { TrackPoint } from '@core/models';
import * as storage from '@data/storage';
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatPace,
  formatSpeed,
} from '@state/formatters';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore, type MapBasemap } from '@state/mapStore';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Keyboard, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Appbar,
  Button,
  Dialog,
  IconButton,
  Portal,
  Snackbar,
  Surface,
  Text,
  useTheme,
} from 'react-native-paper';
import { useIosKeyboardHeight } from '../common/useIosKeyboardHeight';
import { KeyboardDismissArea } from '@ui/components/KeyboardDismissArea';
import { KEYBOARD_DONE_BAR_ID, KeyboardDoneBar } from '@ui/components/KeyboardDoneBar';
import { EndCaretTextInput } from '@ui/components/EndCaretTextInput';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetchHeightmap } from './dem';
import { SharingUnavailableError, exportTrailPdf } from '../common/exportTrailPdf';
import { NameDialog } from '../library/NameDialog';
import { TrailViewerRail } from './TrailViewerRail';
import { ElevationProfile } from '../common/components/ElevationProfile';
import { TrimRangeSlider } from './components/TrimRangeSlider';
import { Trail2DView } from './Trail2DView';
import { overwriteWithTrim, saveTrimmedCopy, type TrimRange } from './trimTrack';
import { useTimedSnackbar } from '../common/useTimedSnackbar';
import { useTrailNoteEditor } from './hooks/useTrailNoteEditor';

interface Props {
  trackId: string;
}

/**
 * The focused trail view (route `/trail3d/[id]`, name kept for deep links and
 * Maestro): the MapLibre trail map on top — tilted with two fingers like the
 * main map (#480) — then the elevation profile and notes/photos + PDF export
 * below in one scroll. Scrubbing the profile drives a marker on the map.
 */
export function Trail3DGLScreen({ trackId }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const hintColor = { color: theme.colors.onSurfaceVariant };
  const router = useRouter();
  // Library's "Trim" menu item routes here with ?trim=1 to enter trim mode
  // as soon as this trail's points are loaded (see the effect below).
  const { trim: trimParam } = useLocalSearchParams<{ trim?: string }>();
  const track = useLibraryStore((s) => s.tracks.find((t) => t.id === trackId));
  const addTrack = useLibraryStore((s) => s.addTrack);
  const updateTrack = useLibraryStore((s) => s.updateTrack);
  const renameTrack = useLibraryStore((s) => s.renameTrack);
  const addTrackNote = useLibraryStore((s) => s.addTrackNote);
  const updateTrackNote = useLibraryStore((s) => s.updateTrackNote);
  const removeTrackNote = useLibraryStore((s) => s.removeTrackNote);

  const [points, setPoints] = useState<TrackPoint[] | null>(null);
  // Pause boundaries in `points` (one per extra <trkseg>): the trace is
  // drawn per segment and the summary stats never bridge a pause.
  const [segmentStarts, setSegmentStarts] = useState<readonly number[]>([]);
  // Same points but with each altitude replaced by the terrain (DEM) height, so
  // the elevation profile reads the same surface as the map's relief.
  const [demPoints, setDemPoints] = useState<TrackPoint[] | null>(null);
  // Viewer-local basemap, seeded from
  // the main map's choice so opening the viewer looks like the map you came
  // from; picking in the rail never repaints the main map.
  const [basemap, setBasemap] = useState<MapBasemap>(() => useMapStore.getState().basemap);
  // Measured summary-card height so the control rail sits just below it.
  const [summaryH, setSummaryH] = useState(64);
  const [scrub, setScrub] = useState<TrackPointAt | null>(null);
  const [viewingPhoto, setViewingPhoto] = useState<string | null>(null);
  // Note badge tapped on the trail: shows the
  // note text + photo in place, without hunting for its row in the list below.
  const [viewingNoteId, setViewingNoteId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // True while a finger is down on the map/terrain box. The whole screen lives
  // in a ScrollView, which intercepts vertical drags before they reach the
  // native MapLibre view — pans "sort of" worked, stuttering against the page
  // scroll. Disabling the scroll for the duration of a touch inside the
  // box gives the map the full gesture, matching how the main map feels.
  const [mapGesturing, setMapGesturing] = useState(false);
  const { message: snack, show: showSnack, dismiss: dismissSnack } = useTimedSnackbar(2500);
  // Note dialog state + single-flight save (#307): a failed save keeps the
  // draft and the dialog; a slow photo copy can't be submitted twice.
  const {
    editing,
    setEditing,
    draft,
    setDraft,
    draftPhoto,
    setDraftPhoto,
    saving: noteSaving,
    commit,
    close: closeNoteDialog,
  } = useTrailNoteEditor({
    trackId,
    existingPhotoOf: (noteId) => track?.notes?.find((n) => n.id === noteId)?.photoUri,
    addTrackNote,
    updateTrackNote,
    onError: () => showSnack('Could not save the note — your text is still here, try again'),
  });

  // Trim tool (ported from the map's inspect panel — #polish item 5): a kept
  // [start, end] point window over the docked profile, live-previewed by the
  // slider itself; the two save paths reuse trimTrack.ts's persistence.
  const [trimRange, setTrimRange] = useState<TrimRange | null>(null);
  const [trimSaving, setTrimSaving] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  // Rename-this-trail prompt, opened by tapping the summary card's title.
  const [renaming, setRenaming] = useState(false);
  // DEM heightmap cache for the profile's terrain-sampled elevations.
  const hmRef = useRef<Awaited<ReturnType<typeof fetchHeightmap>> | null>(null);
  const pendingTrimRef = useRef(trimParam === '1');

  const notes = track?.notes;
  const ordered = useMemo(() => orderNotes(notes ?? []), [notes]);
  const markers = useMemo(
    () => ordered.map((n, i) => ({ distanceM: n.distanceM, label: String(i + 1) })),
    [ordered],
  );

  const fileUri = track?.fileUri;
  const bbox = track?.stats.bbox;

  // Load the trail points for the map and the profile/notes section below.
  useEffect(() => {
    if (!fileUri) return;
    let cancelled = false;
    (async () => {
      try {
        const gpx = await storage.readFileText(fileUri);
        const doc = parseGpx(gpx);
        if (!cancelled) {
          setPoints(doc.points);
          setSegmentStarts(doc.segmentStarts);
        }
      } catch {
        /* an unreadable file simply shows no line */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileUri]);

  // Consume the one-shot ?trim=1 intent (Library's "Trim" menu item) once
  // this trail's points have loaded — mirrors the old inspect-panel's
  // pendingTrimId effect, just local to this screen instead of MapScreen.
  // This only ever fires once per screen instance, gated by the ref above
  // (consumed, not a subscription loop), so the direct setState here is the
  // same precedented exception MapScreen's old inspectIntent effect used.
  useEffect(() => {
    if (!pendingTrimRef.current || !points) return;
    pendingTrimRef.current = false;
    if (points.length >= 3) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTrimRange({ start: 0, end: points.length - 1 });
    } else showSnack('This trail is too short to trim');
  }, [points, showSnack]);

  // Re-read the (possibly just-overwritten) GPX file from disk — used after
  // an overwrite trim so the trace/profile reflect the new geometry
  // without a full screen remount.
  const reloadPoints = async (uri = fileUri) => {
    if (!uri) return;
    try {
      const gpx = await storage.readFileText(uri);
      const doc = parseGpx(gpx);
      setPoints(doc.points);
      setSegmentStarts(doc.segmentStarts);
    } catch {
      /* the trail stays on its pre-reload points; the trim itself already saved */
    }
  };

  const beginTrim = () => {
    if (points && points.length >= 3) setTrimRange({ start: 0, end: points.length - 1 });
  };
  // Offer trim only when there's something to cut, and hide it while the trim
  // panel is already open below (same predicate the rail FAB used).
  const canTrim = !trimRange && points !== null && points.length >= 3;
  const cancelTrim = () => setTrimRange(null);
  const changeTrim = (start: number, end: number) => setTrimRange({ start, end });

  const onSaveTrimCopy = async () => {
    if (!track || !points || !trimRange) return;
    setTrimSaving(true);
    try {
      const { track: copy, fileUri: copyUri } = await saveTrimmedCopy(
        track,
        points,
        trimRange.start,
        trimRange.end,
      );
      addTrack(copy, copyUri);
      showSnack(`Saved "${copy.name}" to the library`);
      setTrimRange(null);
    } catch (err) {
      showSnack(`Trim failed: ${err instanceof Error ? err.message : 'could not save'}`);
    }
    setTrimSaving(false);
  };

  const onOverwriteTrim = async () => {
    if (!track || !points || !trimRange) return;
    setTrimSaving(true);
    try {
      const { patch } = await overwriteWithTrim(
        track,
        points,
        trimRange.start,
        trimRange.end,
        (next) => updateTrack(track.id, next),
      );
      await reloadPoints(patch.fileUri);
      showSnack(`Trimmed "${track.name}"`);
      setTrimRange(null);
    } catch (err) {
      showSnack(`Trim failed: ${err instanceof Error ? err.message : 'could not save'}`);
    }
    setTrimSaving(false);
  };

  // Sample the terrain (DEM) under each point so the profile reads the same
  // surface the map's relief shows. The heightmap is fetched once and cached.
  useEffect(() => {
    if (!points || points.length === 0 || !bbox) return;
    let cancelled = false;
    (async () => {
      try {
        const hm = hmRef.current ?? (await fetchHeightmap(padBbox(bbox)));
        hmRef.current = hm;
        if (!cancelled) setDemPoints(withDemElevations(points, hm));
      } catch {
        /* keep the recorded <ele> if the DEM can't be loaded */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [points, bbox]);

  // Drive the profile + summary from the DEM-sampled points when available, so
  // the elevation chart and ↑/↓ totals match the displayed terrain.
  const profilePoints = demPoints ?? points ?? [];
  const profileStats = useMemo(
    () => (demPoints ? computeSegmentedTrackStats(demPoints, segmentStarts) : null),
    [demPoints, segmentStarts],
  );

  // Cumulative distance at each point for the trim tool's "keeping X of Y"
  // readout — O(n) once per point-set, then a subtraction per slider move.
  const cumM = useMemo(() => {
    const pts = points ?? [];
    const out = new Array<number>(pts.length);
    let d = 0;
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      if (i > 0 && prev && cur) d += haversineMeters(prev, cur);
      out[i] = d;
    }
    return out;
  }, [points]);
  const keptM = trimRange ? (cumM[trimRange.end] ?? 0) - (cumM[trimRange.start] ?? 0) : 0;
  const totalM = cumM.length > 0 ? (cumM[cumM.length - 1] ?? 0) : 0;

  const onScrub = (at: TrackPointAt | null) => {
    // Keep the last scrubbed point selected when the finger lifts (the profile
    // reports null on release). Otherwise the selection clears instantly and the
    // "Add note" button — gated on a selected point — can never be tapped.
    if (!at) return;
    setScrub(at);
  };

  const pickPhoto = async (fromCamera: boolean) => {
    try {
      if (fromCamera) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          showSnack('Camera permission denied');
          return;
        }
      }
      const result = fromCamera
        ? await ImagePicker.launchCameraAsync({ quality: 0.6 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
      if (!result.canceled && result.assets[0]) setDraftPhoto(result.assets[0].uri);
    } catch {
      showSnack('Could not attach photo');
    }
  };

  /**
   * #235 — leave the note editor with the keyboard already down. Unmounting
   * the field's input accessory view while iOS still holds a live keyboard
   * leaves a dangling accessory (it reproducibly crashed XCUITest's hierarchy
   * snapshot), and it looks better besides.
   */
  // #235 — Paper centres the dialog and its Modal defeats KeyboardAvoidingView,
  // so with the keyboard (plus the Done bar) up, Cancel/Save sat underneath it.
  // Shifting by the measured height is the same fix the waypoint editor and the
  // coordinate dialog already carry.
  const noteKeyboardHeight = useIosKeyboardHeight();

  const closeNoteEditor = () => {
    Keyboard.dismiss();
    closeNoteDialog();
  };

  const commitNote = () => {
    Keyboard.dismiss();
    void commit();
  };

  const onExportPdf = async () => {
    if (!track || !points) return;
    setExporting(true);
    try {
      await exportTrailPdf(track, points);
    } catch (e) {
      // Sharing-unavailable carries a user-appropriate message; anything else
      // stays generic.
      showSnack(e instanceof SharingUnavailableError ? e.message : 'Could not export PDF');
    }
    setExporting(false);
  };

  if (!track) {
    return (
      <View style={styles.fill}>
        <Appbar.Header>
          <Appbar.BackAction onPress={() => router.back()} />
          <Appbar.Content title="Trail" />
        </Appbar.Header>
        <Text style={styles.pad}>This trail is no longer available.</Text>
      </View>
    );
  }

  const s = profileStats ?? track.stats;

  return (
    <View style={styles.fill}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        scrollEnabled={!mapGesturing}
      >
        <View
          style={[styles.mapBox, { paddingTop: insets.top }]}
          onTouchStart={() => setMapGesturing(true)}
          onTouchEnd={(e) => {
            if (e.nativeEvent.touches.length === 0) setMapGesturing(false);
          }}
          onTouchCancel={(e) => {
            if (e.nativeEvent.touches.length === 0) setMapGesturing(false);
          }}
        >
          {points && points.length > 0 ? (
            // Mount the map only once points are loaded — a MapLibre GeoJSON
            // source created with empty data doesn't reliably pick up a later
            // update.
            <Trail2DView
              points={points}
              segmentStarts={segmentStarts}
              notes={notes}
              scrubAt={scrub}
              basemap={basemap}
              onNotePress={setViewingNoteId}
            />
          ) : (
            <View style={styles.center} pointerEvents="none">
              <ActivityIndicator size="large" />
            </View>
          )}
          {/* Floating over the map — needs its own dark disc to stay
              visible on light tiles (user call; the bare arrow disappeared). */}
          <Appbar.BackAction
            onPress={() => router.back()}
            color="#E6EAEF"
            style={[styles.back, { top: insets.top + 2 }]}
          />
          <Surface
            style={[styles.summary, { top: insets.top + 2 }]}
            elevation={3}
            onLayout={(e) => setSummaryH(e.nativeEvent.layout.height)}
          >
            {/* Title row: the name doubles as the rename affordance (the
                Library's ⋮ → Rename, reachable without going back to the
                list), and trim sits beside it because it EDITS the GPX —
                it isn't a map-viewing control like the rail's FABs.
                The two affordances don't fight: the Pressable takes the
                flexed remainder and the icon button its own fixed box.
                A flex ROW is safe inside this absolutely-positioned Surface
                (its left/right pin the width); the documented iOS Surface
                collapse hits flex COLUMNS, which need a height the inner
                shadow wrapper doesn't inherit. Same shape as
                WaypointViewerCard's header, which already ships this way. */}
            <View style={styles.summaryTitleRow}>
              <Pressable
                onPress={() => setRenaming(true)}
                accessibilityRole="button"
                accessibilityLabel={`Rename trail ${track.name}`}
                style={styles.summaryTitle}
              >
                <Text variant="titleSmall" numberOfLines={1}>
                  {track.name}
                </Text>
              </Pressable>
              {canTrim && (
                <IconButton
                  icon="content-cut"
                  size={18}
                  onPress={beginTrim}
                  style={styles.summaryTrim}
                  accessibilityLabel="Trim trail"
                />
              )}
            </View>
            <View style={styles.summaryRow}>
              <Text variant="labelMedium">{formatDistance(s.distanceM)}</Text>
              <Text variant="labelMedium">↑ {formatElevation(s.ascentM)}</Text>
              <Text variant="labelMedium">↓ {formatElevation(s.descentM)}</Text>
              <Text variant="labelMedium">{formatDuration(s.durationS)}</Text>
              <Text variant="labelMedium">{formatPace(s.avgSpeedMps)}</Text>
            </View>
          </Surface>

          <TrailViewerRail
            top={insets.top + 2 + summaryH + 10}
            basemap={basemap}
            onSelectBasemap={setBasemap}
          />
        </View>

        {points && (
          <>
            <View style={styles.scrubRow}>
              {trimRange ? (
                <Text variant="titleSmall">Trim trail</Text>
              ) : scrub ? (
                <Text variant="bodySmall">
                  {formatDistance(scrub.distanceM)}
                  {scrub.elevation !== undefined ? ` · ${formatElevation(scrub.elevation)}` : ''}
                  {scrub.speed !== undefined ? ` · ${formatSpeed(scrub.speed)}` : ''}
                </Text>
              ) : (
                <Text variant="bodySmall" style={hintColor}>
                  Drag the profile to move the marker on the map.
                </Text>
              )}
            </View>

            {trimRange ? (
              <View style={styles.trimBody}>
                <Text variant="bodySmall" style={hintColor}>
                  Drag the handles to shorten the trail from either end. The highlighted segment is
                  kept.
                </Text>
                <TrimRangeSlider
                  count={points.length}
                  start={trimRange.start}
                  end={trimRange.end}
                  onChange={changeTrim}
                />
                <Text variant="labelMedium">
                  Keeping {formatDistance(keptM)} of {formatDistance(totalM)} ·{' '}
                  {trimRange.end - trimRange.start + 1} of {points.length} points
                </Text>
                <View style={styles.trimActions}>
                  <Button onPress={cancelTrim} disabled={trimSaving}>
                    Cancel
                  </Button>
                  <View style={styles.trimSaveActions}>
                    <Button
                      mode="outlined"
                      icon="content-save-plus-outline"
                      onPress={() => void onSaveTrimCopy()}
                      disabled={trimSaving}
                      loading={trimSaving}
                    >
                      Save as copy
                    </Button>
                    <Button
                      mode="contained"
                      icon="content-save-outline"
                      onPress={() => setConfirmOverwrite(true)}
                      disabled={trimSaving}
                    >
                      Overwrite
                    </Button>
                  </View>
                </View>
              </View>
            ) : (
              <ElevationProfile
                points={profilePoints}
                ascentM={s.ascentM}
                descentM={s.descentM}
                markers={markers}
                selectedDistanceM={scrub?.distanceM ?? null}
                onScrub={onScrub}
              />
            )}

            <View style={styles.notesHeader}>
              <Text variant="titleSmall" style={styles.notesTitle}>
                Notes ({ordered.length})
              </Text>
              <Button
                compact
                icon="map-marker-plus"
                disabled={!scrub}
                onPress={() => {
                  if (!scrub) return;
                  setDraft('');
                  setDraftPhoto(null);
                  setEditing({ mode: 'add', distanceM: scrub.distanceM });
                }}
              >
                Add note
              </Button>
            </View>
            {ordered.length === 0 ? (
              <Text variant="bodySmall" style={[styles.pad, hintColor]}>
                Scrub the profile to a spot and tap “Add note”.
              </Text>
            ) : (
              ordered.map((n, i) => (
                <View key={n.id} style={styles.noteRow}>
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{i + 1}</Text>
                  </View>
                  <Pressable
                    style={styles.noteBody}
                    onPress={() => onScrub(interpolateTrackAtDistance(profilePoints, n.distanceM))}
                  >
                    <Text variant="bodyMedium">{n.text}</Text>
                    <Text variant="bodySmall" style={hintColor}>
                      {formatDistance(n.distanceM)}
                    </Text>
                    {n.photoUri && (
                      <Pressable onPress={() => setViewingPhoto(n.photoUri ?? null)}>
                        <Image source={{ uri: n.photoUri }} style={styles.noteThumb} />
                      </Pressable>
                    )}
                  </Pressable>
                  <IconButton
                    icon="pencil-outline"
                    onPress={() => {
                      setDraft(n.text);
                      setDraftPhoto(n.photoUri ?? null);
                      setEditing({ mode: 'edit', noteId: n.id });
                    }}
                  />
                  <IconButton
                    icon="trash-can-outline"
                    onPress={() => {
                      removeTrackNote(trackId, n.id);
                      showSnack('Note deleted');
                    }}
                  />
                </View>
              ))
            )}

            <Button
              mode="contained-tonal"
              icon="file-pdf-box"
              onPress={onExportPdf}
              loading={exporting}
              disabled={exporting}
              style={styles.pdfBtn}
            >
              Export PDF
            </Button>
          </>
        )}
      </ScrollView>

      <Portal>
        <NameDialog
          visible={renaming}
          title="Rename trail"
          label="Trail name"
          confirmLabel="Rename"
          initialValue={track.name}
          onDismiss={() => setRenaming(false)}
          onSubmit={(name) => {
            setRenaming(false);
            if (name) renameTrack(track.id, name);
          }}
        />

        <Dialog visible={confirmOverwrite} onDismiss={() => setConfirmOverwrite(false)}>
          <Dialog.Title>Overwrite trail</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {`Replace "${track.name}" with the trimmed segment? The cut portions (and any notes on them) are permanently removed.`}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmOverwrite(false)}>Cancel</Button>
            <Button
              textColor={theme.colors.error}
              onPress={() => {
                setConfirmOverwrite(false);
                void onOverwriteTrim();
              }}
            >
              Overwrite
            </Button>
          </Dialog.Actions>
        </Dialog>

        {/* #235 — every exit from this dialog puts the keyboard away first;
            unmounting the note field's accessory bar under a live keyboard
            leaves a dangling accessory (see WaypointEditorDialog's `close`). */}
        <Dialog
          visible={editing !== null}
          onDismiss={closeNoteEditor}
          style={noteKeyboardHeight > 0 ? { marginBottom: noteKeyboardHeight } : null}
        >
          <Dialog.Title>{editing?.mode === 'edit' ? 'Edit note' : 'New note'}</Dialog.Title>
          <Dialog.Content>
            <KeyboardDismissArea>
              <EndCaretTextInput
                label="Note"
                value={draft}
                onChangeText={setDraft}
                autoFocus
                multiline
                mode="outlined"
                // #235 — Return inserts a newline in a multiline field, so iOS
                // has no way out without the shared accessory bar's Done.
                inputAccessoryViewID={KEYBOARD_DONE_BAR_ID}
              />
              {draftPhoto ? (
                <View style={styles.photoPreviewWrap}>
                  <Image source={{ uri: draftPhoto }} style={styles.photoPreview} />
                  <Button compact icon="image-remove" onPress={() => setDraftPhoto(null)}>
                    Remove photo
                  </Button>
                </View>
              ) : (
                <View style={styles.photoButtons}>
                  <Button compact icon="image-outline" onPress={() => pickPhoto(false)}>
                    Photo
                  </Button>
                  <Button compact icon="camera-outline" onPress={() => pickPhoto(true)}>
                    Camera
                  </Button>
                </View>
              )}
            </KeyboardDismissArea>
            {/* Mounted with the dialog, not at the app root — see the note in
                WaypointEditorDialog: the native accessory binds to its field
                once, when it moves to the window. */}
            <KeyboardDoneBar />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeNoteEditor} disabled={noteSaving}>
              Cancel
            </Button>
            <Button
              onPress={commitNote}
              disabled={!draft.trim() || noteSaving}
              loading={noteSaving}
            >
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={viewingPhoto !== null} onDismiss={() => setViewingPhoto(null)}>
          <Dialog.Content>
            {viewingPhoto && (
              <Image source={{ uri: viewingPhoto }} style={styles.photoFull} resizeMode="contain" />
            )}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setViewingPhoto(null)}>Close</Button>
          </Dialog.Actions>
        </Dialog>

        {/* Viewer for a note pin tapped on the trail. */}
        {(() => {
          const idx = ordered.findIndex((n) => n.id === viewingNoteId);
          const note = idx >= 0 ? ordered[idx] : undefined;
          return (
            <Dialog visible={note !== undefined} onDismiss={() => setViewingNoteId(null)}>
              {note && (
                <>
                  <Dialog.Title>
                    Note {idx + 1} · {formatDistance(note.distanceM)}
                  </Dialog.Title>
                  <Dialog.Content>
                    <Text variant="bodyMedium">{note.text}</Text>
                    {note.photoUri && (
                      <Image
                        source={{ uri: note.photoUri }}
                        style={styles.notePhotoView}
                        resizeMode="contain"
                      />
                    )}
                  </Dialog.Content>
                  <Dialog.Actions>
                    <Button
                      icon="pencil-outline"
                      onPress={() => {
                        setViewingNoteId(null);
                        setDraft(note.text);
                        setDraftPhoto(note.photoUri ?? null);
                        setEditing({ mode: 'edit', noteId: note.id });
                      }}
                    >
                      Edit
                    </Button>
                    <Button onPress={() => setViewingNoteId(null)}>Close</Button>
                  </Dialog.Actions>
                </>
              )}
            </Dialog>
          );
        })()}
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
  pad: { paddingHorizontal: 16 },
  mapBox: { height: 420, backgroundColor: '#dfe9f2' },
  center: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  back: {
    position: 'absolute',
    left: 4,
    margin: 0,
    backgroundColor: 'rgba(38, 45, 53, 0.88)',
    borderRadius: 24,
  },
  summary: {
    position: 'absolute',
    left: 60,
    right: 12,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 4,
  },
  summaryTitleRow: { flexDirection: 'row', alignItems: 'center' },
  summaryTitle: { flex: 1 },
  // Kill Paper's default IconButton margin so the scissors don't inflate the
  // card, and pull it into the card's right padding to sit flush with the edge.
  summaryTrim: { margin: 0, marginRight: -8, marginVertical: -4 },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  scrubRow: { paddingHorizontal: 16, paddingTop: 10 },
  trimBody: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 6, gap: 6 },
  trimActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  trimSaveActions: { flexDirection: 'row', gap: 8 },
  notesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 16,
    paddingRight: 8,
    paddingTop: 8,
  },
  notesTitle: { fontWeight: '700' },
  noteRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4 },
  noteBody: { flex: 1, paddingVertical: 8 },
  badge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    backgroundColor: '#4F7A3A',
  },
  badgeText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  noteThumb: { width: 120, height: 90, borderRadius: 8, marginTop: 6 },
  pdfBtn: { marginHorizontal: 16, marginTop: 16 },
  photoButtons: { flexDirection: 'row', gap: 8, marginTop: 8 },
  photoPreviewWrap: { marginTop: 10, alignItems: 'flex-start' },
  photoPreview: { width: '100%', height: 160, borderRadius: 8 },
  photoFull: { width: '100%', height: 360 },
  notePhotoView: { width: '100%', height: 240, marginTop: 12, borderRadius: 8 },
});

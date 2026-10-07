import { parseGpx } from '@core/geo/gpx';
import { routeClimb } from '@core/draw/elevation';
import {
  averageHeartRate,
  buildChartSeries,
  buildOutingTimeline,
  buildTrackAxis,
  computeSegmentedTrackStats,
  gradeAtDistance,
  interpolateOnAxis,
  interpolateTrackAtDistance,
  trailTiming,
  withDemElevations,
  type TimelineEvent,
  type TrackPointAt,
} from '@core/geo/track';
import { formatLatLng } from '@core/geo/formatCoords';
import { findCategory } from '@core/library/categories';
import {
  effectiveTrailViewTab,
  TRAIL_VIEW_TABS,
  type TrailViewTab,
} from '@core/library/trailViewTabs';
import {
  cursorReadout,
  overviewTiles,
  splitRows,
  splitUnit,
  timelineEventText,
  trailSubtitle,
} from '@core/library/trailViewText';
import { numberNotesOnTrack, orderNotes } from '@core/library/notes';
import { padBbox } from '@core/geo/terrain';
import type { TrackPoint } from '@core/models';
import * as storage from '@data/storage';
import { formatDistance } from '@state/formatters';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore, type MapBasemap } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetchHeightmap } from './dem';
import { SharingUnavailableError, exportTrailPdf } from '../common/exportTrailPdf';
import { NameDialog } from '../library/NameDialog';
import { TrailViewerRail } from './TrailViewerRail';
import { TrimRangeSlider } from './components/TrimRangeSlider';
import { Trail2DView } from './Trail2DView';
import { overwriteWithTrim, photoTrimRange, saveTrimmedCopy, type TrimRange } from './trimTrack';
import { useTimedSnackbar } from '../common/useTimedSnackbar';
import { useTrailNoteEditor } from './hooks/useTrailNoteEditor';
import { useLazyMovingStats } from './hooks/useLazyMovingStats';
import { WaypointViewerCard } from './components/WaypointViewerCard';
import { useOutingAnalysis } from './trailView/useOutingAnalysis';
import { jumpMarks } from './trailView/JumpChips';
import { ChartsTab } from './trailView/ChartsTab';
import { TrailTabBar } from './trailView/TrailTabBar';
import { OverviewTab } from './trailView/OverviewTab';
import { TimelineTab, type TimelineItem } from './trailView/TimelineTab';
import { SplitsTab } from './trailView/SplitsTab';
import { TRAIL_ACTION_BAR_H, TrailActionBar, type TrailAction } from './trailView/TrailActionBar';
import { mapAlongPoints, photosOnAxis } from '@core/photos/axis';
import { isNotePhoto } from '@core/photos/model';
import { combineTrailPhotos, notePhotosOnTrail } from '@core/photos/notePhotos';
import { photoEditFailureMessage, photoListNotice } from '@core/photos/status';
import { visiblePhotos } from '@core/photos/stack';
import { photoCountLabel } from '@core/photos/summary';
import { indexTrack } from '@core/photos/trackIndex';
import { photosEditable, useTrailPhotos, useTrailPhotosStore } from '@state/trailPhotosStore';
import { usePhotoFocusStore } from '@state/photoFocusStore';
import { AddPhotosSheet } from '../photos/AddPhotosSheet';
import { photoViewerHref } from '../photos/photoUri';
import { ShareTrailSheet } from '../photos/ShareTrailSheet';

interface Props {
  trackId: string;
}

/** Height of the map at the top of the trail view, below the status bar (board C2). */
const MAP_H = 290;

/**
 * The focused trail view (route `/trail3d/[id]`, name kept for deep links and
 * Maestro): the MapLibre trail map on top — tilted with two fingers like the
 * main map (#480) — then the elevation profile and notes/photos + PDF export
 * below in one scroll. Scrubbing the profile drives a marker on the map.
 */
export function Trail3DGLScreen({ trackId }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const hintColor = { color: theme.colors.onSurfaceVariant };
  const router = useRouter();
  // Library's "Trim" menu item routes here with ?trim=1 to enter trim mode
  // as soon as this trail's points are loaded (see the effect below).
  const { trim: trimParam, addPhotos: addPhotosParam } = useLocalSearchParams<{
    trim?: string;
    addPhotos?: string;
  }>();
  const track = useLibraryStore((s) => s.tracks.find((t) => t.id === trackId));
  const addTrack = useLibraryStore((s) => s.addTrack);
  const updateTrack = useLibraryStore((s) => s.updateTrack);
  const renameTrack = useLibraryStore((s) => s.renameTrack);
  const addTrackNote = useLibraryStore((s) => s.addTrackNote);
  const updateTrackNote = useLibraryStore((s) => s.updateTrackNote);
  const removeTrackNote = useLibraryStore((s) => s.removeTrackNote);
  const customCategories = useLibraryStore((s) => s.customCategories);
  const setActiveTrackIds = useLibraryStore((s) => s.setActiveTrackIds);
  const setFocusBounds = useMapStore((s) => s.setFocusBounds);
  // Subscribed so a unit flip re-renders the tiles, splits and timeline at once.
  const units = useSettingsStore((s) => s.units);
  const savedTab = useSettingsStore((s) => s.trailViewTab);
  const setSetting = useSettingsStore((s) => s.set);

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
  // Where the map should re-centre after a jump chip / Timeline tap (#511).
  const [focusAt, setFocusAt] = useState<{ latitude: number; longitude: number } | null>(null);
  const [viewingPhoto, setViewingPhoto] = useState<string | null>(null);
  // Note badge tapped on the trail: shows the
  // note text + photo in place, without hunting for its row in the list below.
  const [viewingNoteId, setViewingNoteId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
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
  const pendingTrimRef = useRef(trimParam === '1');
  const pendingAddPhotosRef = useRef(addPhotosParam === '1');

  // DEM heightmap cache for the profile's terrain-sampled elevations.
  const hmRef = useRef<Awaited<ReturnType<typeof fetchHeightmap>> | null>(null);

  const notes = track?.notes;
  const ordered = useMemo(() => orderNotes(notes ?? []), [notes]);

  // Trail photos (#587): the trail's own (sidecar) plus its note photos, one
  // set in time order for the map, the strip, the lane and the viewer.
  const trailPhotos = useTrailPhotos(trackId);
  const canEditPhotos = photosEditable(trailPhotos.status);
  const photoNotice = photoListNotice(trailPhotos.status);
  const [addingPhotos, setAddingPhotos] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);

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

  // The one-shot ?addPhotos=1 intent (#587: "Add photos from this outing?"
  // after a recording is saved): open the Add-photos sheet once the points
  // and the photo list are in. Same consumed-once exception as ?trim=1.
  useEffect(() => {
    if (!pendingAddPhotosRef.current || !points || trailPhotos.status === 'loading') return;
    pendingAddPhotosRef.current = false;
    if (canEditPhotos) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAddingPhotos(true);
    } else if (photoNotice) showSnack(photoNotice);
  }, [points, trailPhotos.status, canEditPhotos, photoNotice, showSnack]);

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
        segmentStarts,
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
      const { patch, photosRemoved } = await overwriteWithTrim(
        track,
        points,
        trimRange.start,
        trimRange.end,
        (next) => updateTrack(track.id, next),
        segmentStarts,
      );
      await reloadPoints(patch.fileUri);
      void useTrailPhotosStore.getState().refresh(track.id);
      showSnack(
        photosRemoved > 0
          ? `Trimmed "${track.name}" and removed ${photoCountLabel(photosRemoved)}`
          : `Trimmed "${track.name}"`,
      );
      setTrimRange(null);
    } catch (err) {
      showSnack(
        photoEditFailureMessage(
          err,
          `Trim failed: ${err instanceof Error ? err.message : 'could not save'}`,
        ),
      );
    }
    setTrimSaving(false);
  };

  // Note→coordinate resolution (numbered as on the map's pins).
  const numberedNotes = useMemo(
    () => numberNotesOnTrack(points ?? [], notes ?? [], segmentStarts),
    [points, notes, segmentStarts],
  );

  // Sample the terrain (DEM) under each point so the profile reads the same
  // surface the map's relief shows. The heightmap is fetched once and cached.
  // A route drawn on the map (#502) already carries DEM elevations sampled
  // at the route's own zoom: re-sampling the coarser view heightmap would
  // give a second, different climb. Its GPX elevations are the truth.
  const planned = track?.plan !== undefined;
  useEffect(() => {
    if (!points || points.length === 0 || !bbox || planned) return;
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
  }, [points, bbox, planned]);

  // Drive the profile + summary from the DEM-sampled points when available, so
  // the elevation chart and ↑/↓ totals match the displayed terrain.
  const profilePoints = useMemo(() => demPoints ?? points ?? [], [demPoints, points]);
  const category = track?.category;
  const profileStats = useMemo(() => {
    // A drawn route: the drawing bar's own climb rule over its DEM samples,
    // so the trail view and the bar (and the Library) say the same number.
    if (planned && points) {
      return {
        ...computeSegmentedTrackStats(points, segmentStarts, { category }),
        ...routeClimb(points.map((p) => p.altitude)),
      };
    }
    // The saved-trail climb rule, so the terrain-sampled climb is measured
    // the way the Library's is.
    return demPoints
      ? computeSegmentedTrackStats(demPoints, segmentStarts, { category, robustClimb: true })
      : null;
  }, [planned, points, demPoints, segmentStarts, category]);
  // Trails saved before moving time existed (#504), or re-filed under another
  // activity, get their moving stats recomputed here — once, from the points
  // this screen loads anyway — instead of a library-wide pass at launch.
  useLazyMovingStats(track, points, segmentStarts);

  // Cumulative distance at each point for the trim tool's "keeping X of Y"
  // readout — O(n) once per point-set, then a subtraction per slider move.
  // Segment gaps add nothing (#325), so "Y" is the trail's distance stat.
  const cumM = useMemo(
    () => buildTrackAxis(points ?? [], segmentStarts).cumM,
    [points, segmentStarts],
  );
  const keptM = trimRange ? (cumM[trimRange.end] ?? 0) - (cumM[trimRange.start] ?? 0) : 0;
  // Trail photos on the cut ends, for the overwrite confirmation (#587).
  const photosCutByTrim = useMemo(() => {
    if (!confirmOverwrite || !trimRange || !points) return 0;
    const { keptStartM, keptEndM } = photoTrimRange(points, trimRange.start, trimRange.end);
    // The same half-metre tolerance as the data layer: a photo exactly on a cut stays.
    return trailPhotos.photos.filter(
      (p) => p.distanceM < keptStartM - 0.5 || p.distanceM > keptEndM + 0.5,
    ).length;
  }, [confirmOverwrite, trimRange, points, trailPhotos.photos]);
  const totalM = cumM.length > 0 ? (cumM[cumM.length - 1] ?? 0) : 0;

  // #511: everything the tabs show beyond the stats — splits, stops, the
  // steepest stretch, the high point — derived once per point set (deferred
  // past the opening animation, cached per trail), from the same points the
  // profile draws so the jump chips land exactly under its cursor.
  const { unitM: splitUnitM, label: splitUnitLabel } = splitUnit(units);
  const analysis = useOutingAnalysis({
    cacheKey: track && fileUri ? `${track.id}:${fileUri}:${demPoints ? 'dem' : 'gps'}` : null,
    points: points ? profilePoints : null,
    segmentStarts,
    category,
    splitUnitM,
  });
  const summaryStats = profileStats ?? track?.stats ?? null;
  const timing = summaryStats ? trailTiming(summaryStats, category) : null;
  // Before the analysis lands, trust the stored stats' time; after, the points.
  const timed = analysis ? analysis.timed : timing !== null;
  const tab = effectiveTrailViewTab(savedTab);
  const selectTab = (next: TrailViewTab) => setSetting('trailViewTab', next);

  const timelineItems = useMemo<TimelineItem[]>(() => {
    if (!analysis || !summaryStats) return [];
    const events = buildOutingTimeline({
      points: profilePoints,
      axis: analysis.axis,
      notes: ordered,
      stops: analysis.stops,
      steepest: analysis.steepest,
      extremes: analysis.extremes,
    });
    const totals = { distanceM: summaryStats.distanceM, timing };
    return events.map((event) => ({ event, text: timelineEventText(event, units, totals) }));
  }, [analysis, profilePoints, ordered, summaryStats, timing, units]);

  // The Charts tab's synced series and the Overview's compact chart (#511 C2).
  const chartSeries = useMemo(
    () =>
      analysis
        ? buildChartSeries(profilePoints, analysis.axis, { stops: analysis.stops, timed })
        : null,
    [analysis, profilePoints, timed],
  );
  const avgHeartRate = useMemo(() => averageHeartRate(points ?? []), [points]);
  const marks = useMemo(() => jumpMarks(analysis), [analysis]);

  // Photo anchors are metres along every GPX step; the view's axis skips
  // pauses (#325). Both index the same points, so photos map across.
  const photoIndex = useMemo(() => (points ? indexTrack(points) : null), [points]);
  const shownPhotos = useMemo(() => {
    if (!photoIndex) return [];
    const own = visiblePhotos(trailPhotos.photos);
    return combineTrailPhotos(own, notePhotosOnTrail(notes, trackId, photoIndex));
  }, [photoIndex, trailPhotos.photos, notes, trackId]);
  const photosAlong = useMemo(
    () =>
      photoIndex && analysis ? photosOnAxis(shownPhotos, photoIndex.cumM, analysis.axis.cumM) : [],
    [shownPhotos, photoIndex, analysis],
  );
  const ownPhotosAlong = useMemo(
    () => photosAlong.filter((p) => !isNotePhoto(p.photo)),
    [photosAlong],
  );
  const ownPhotoCount = useMemo(
    () => shownPhotos.filter((p) => !isNotePhoto(p)).length,
    [shownPhotos],
  );
  const openPhoto = useCallback(
    (photoId: string) => router.push(photoViewerHref(trackId, photoId) as never),
    [router, trackId],
  );
  const openAddPhotos = useCallback(() => {
    if (!canEditPhotos) {
      showSnack(photoNotice ?? 'Photos are still loading');
      return;
    }
    setAddingPhotos(true);
  }, [canEditPhotos, photoNotice, showSnack]);

  // Dragging a chart: every chart's cursor, the map marker and the readout follow.
  const scrubTo = useCallback(
    (distanceM: number) => {
      const at = analysis
        ? interpolateOnAxis(profilePoints, analysis.axis, distanceM)
        : interpolateTrackAtDistance(profilePoints, distanceM, segmentStarts);
      if (!at) return;
      setScrub(at);
    },
    [analysis, profilePoints, segmentStarts],
  );

  // Move the cursor (charts + map marker) to a distance and centre the map on it.
  const jumpTo = useCallback(
    (distanceM: number) => {
      const at = analysis
        ? interpolateOnAxis(profilePoints, analysis.axis, distanceM)
        : interpolateTrackAtDistance(profilePoints, distanceM, segmentStarts);
      if (!at) return;
      setScrub(at);
      setFocusAt({ latitude: at.latitude, longitude: at.longitude });
    },
    [analysis, profilePoints, segmentStarts],
  );
  // The viewer's "Show on map" (#587): ring the photo and centre the map on it.
  const applyPhotoFocus = useCallback(() => {
    const request = usePhotoFocusStore.getState().request;
    if (!request || request.trackId !== trackId) return;
    const hit = photosAlong.find((p) => p.photo.id === request.photoId);
    if (!hit) return;
    usePhotoFocusStore.getState().consume(trackId);
    setSelectedPhotoId(hit.photo.id);
    jumpTo(hit.distanceM);
  }, [trackId, photosAlong, jumpTo]);
  useEffect(() => {
    const timer = setTimeout(applyPhotoFocus, 0);
    const unsubscribe = usePhotoFocusStore.subscribe(applyPhotoFocus);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [applyPhotoFocus]);
  // The Overview strip also lists hidden photos (dimmed), so they can be shown again.
  const stripPhotosAlong = useMemo(() => {
    if (!photoIndex || !analysis) return [];
    const all = combineTrailPhotos(
      trailPhotos.photos,
      notePhotosOnTrail(notes, trackId, photoIndex),
    );
    return photosOnAxis(all, photoIndex.cumM, analysis.axis.cumM);
  }, [photoIndex, analysis, trailPhotos.photos, notes, trackId]);
  const onTimelineSelect = (e: TimelineEvent) => jumpTo(e.at.distanceM);
  // A note opened from its map pin or the photo strip: the cursor moves to it
  // and the waypoint card shows it.
  const openNote = (noteId: string) => {
    const n = notes?.find((x) => x.id === noteId);
    if (n) {
      const at = analysis
        ? interpolateOnAxis(profilePoints, analysis.axis, n.distanceM)
        : interpolateTrackAtDistance(profilePoints, n.distanceM, segmentStarts);
      if (at) {
        setScrub(at);
      }
    }
    setViewingNoteId(noteId);
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
      await exportTrailPdf(track, points, segmentStarts);
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
  const subtitle = [
    trailSubtitle(
      findCategory(track.category, customCategories)?.name ?? null,
      track.startedAt,
      track.endedAt,
      timed,
    ),
    ownPhotoCount > 0 ? photoCountLabel(ownPhotoCount) : '',
  ]
    .filter((part) => part !== '')
    .join(' · ');
  const viewedNote = numberedNotes.find((n) => n.note.id === viewingNoteId) ?? null;
  // The cursor badge on the map: "2.73 km · 800 m · +4 %" (or "· summit").
  const highM = analysis?.extremes ? analysis.axis.cumM[analysis.extremes.highIndex] : undefined;
  const readout =
    scrub === null
      ? null
      : cursorReadout(
          scrub,
          analysis ? gradeAtDistance(profilePoints, analysis.axis, scrub.distanceM) : null,
          highM !== undefined &&
            Math.abs(highM - scrub.distanceM) < 15 &&
            jumpMarks(analysis).some((m) => m.id === 'summit'),
          units,
        );

  const onShareGpx = async () => {
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(track.fileUri, {
        mimeType: 'application/gpx+xml',
        UTI: 'public.xml',
      });
    } else showSnack('Sharing is not available on this device');
  };
  const onShowOnMap = () => {
    setActiveTrackIds([track.id]);
    if (track.stats.bbox) setFocusBounds(track.stats.bbox);
    router.navigate('/');
  };
  // Only actions that exist today; "Follow again" waits for route following.
  const actions: TrailAction[] = [
    { key: 'map', label: 'On map', icon: 'map-outline', onPress: onShowOnMap },
    {
      key: 'share',
      label: 'Share',
      icon: 'share-variant',
      // With photos, the sheet offers "Trail + photos" (owner Q8: GPX alone by default).
      onPress: () => (ownPhotoCount > 0 ? setSharing(true) : void onShareGpx()),
    },
    {
      key: 'export',
      label: 'Export',
      icon: 'file-pdf-box',
      onPress: () => void onExportPdf(),
      loading: exporting,
      primary: true,
    },
  ];

  return (
    <View style={styles.fill}>
      {/* The map keeps a fixed height at the top (board C2): switching tabs
          or scrolling the content below never shrinks or hides it. */}
      <View style={[styles.mapBox, { height: MAP_H + insets.top, paddingTop: insets.top }]}>
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
            onNotePress={openNote}
            focus={focusAt}
            photos={shownPhotos}
            selectedPhotoId={selectedPhotoId}
            onPhotoPress={openPhoto}
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
              <Text variant="titleMedium" numberOfLines={1} style={styles.titleText}>
                {track.name}
              </Text>
            </Pressable>
            {/* A route drawn on the map reopens in the drawing tool (#502). */}
            {track.plan !== undefined && (
              <IconButton
                icon="vector-polyline-edit"
                size={18}
                onPress={() => {
                  useMapStore.getState().setDrawRequest({ kind: 'edit-route', trackId: track.id });
                  router.navigate('/');
                }}
                style={styles.summaryTrim}
                accessibilityLabel="Edit route"
              />
            )}
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
          {subtitle !== '' && (
            <Text variant="bodySmall" numberOfLines={1} style={hintColor} testID="trail-subtitle">
              {subtitle}
            </Text>
          )}
        </Surface>

        <TrailViewerRail
          top={insets.top + 2 + summaryH + 10}
          basemap={basemap}
          onSelectBasemap={setBasemap}
        />
        {readout !== null && (
          <View
            style={[styles.readout, { backgroundColor: tokens.surface }]}
            pointerEvents="none"
            testID="map-readout"
          >
            <Text style={[styles.readoutText, { color: tokens.ink }]}>{readout}</Text>
          </View>
        )}
      </View>

      {points && (
        <>
          {trimRange ? (
            <View style={styles.trimBody}>
              <Text variant="titleSmall">Trim trail</Text>
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
            <>
              <TrailTabBar tabs={TRAIL_VIEW_TABS} active={tab} onChange={selectTab} />
              <ScrollView
                style={styles.fill}
                contentContainerStyle={{ paddingBottom: insets.bottom + TRAIL_ACTION_BAR_H + 24 }}
                testID="trail-tab-content"
              >
                {tab === 'overview' && (
                  <OverviewTab
                    tiles={overviewTiles(
                      s,
                      timing,
                      analysis?.extremes ?? null,
                      units,
                      avgHeartRate,
                    )}
                    series={chartSeries}
                    cursorDistanceM={scrub?.distanceM ?? null}
                    onScrub={scrubTo}
                    marks={marks}
                    onJump={jumpTo}
                    notes={ordered}
                    onOpenNote={openNote}
                    photos={stripPhotosAlong}
                    onOpenPhoto={openPhoto}
                    {...(canEditPhotos ? { onAddPhotos: openAddPhotos } : {})}
                    photoNotice={photoNotice}
                  />
                )}
                {tab === 'charts' && (
                  <ChartsTab
                    series={chartSeries}
                    display={timing?.display ?? 'pace'}
                    cursorDistanceM={scrub?.distanceM ?? null}
                    onScrub={scrubTo}
                    photos={photosAlong}
                    onOpenPhoto={openPhoto}
                    onCursorPhoto={setSelectedPhotoId}
                  />
                )}
                {tab === 'timeline' && (
                  <TimelineTab
                    items={timelineItems}
                    selectedDistanceM={scrub?.distanceM ?? null}
                    onSelect={onTimelineSelect}
                    loading={analysis === null}
                    addAt={scrub ? formatDistance(scrub.distanceM) : null}
                    onAddNote={() => {
                      if (!scrub) return;
                      setDraft('');
                      setDraftPhoto(null);
                      setEditing({ mode: 'add', distanceM: scrub.distanceM });
                    }}
                    onEditNote={(id) => {
                      const n = notes?.find((x) => x.id === id);
                      if (!n) return;
                      setDraft(n.text);
                      setDraftPhoto(n.photoUri ?? null);
                      setEditing({ mode: 'edit', noteId: n.id });
                    }}
                    onDeleteNote={(id) => {
                      removeTrackNote(trackId, id);
                      showSnack('Note deleted');
                    }}
                    onViewPhoto={setViewingPhoto}
                    photos={ownPhotosAlong}
                    onOpenPhoto={openPhoto}
                    {...(canEditPhotos ? { onAddPhotos: openAddPhotos } : {})}
                  />
                )}
                {tab === 'splits' && (
                  <SplitsTab
                    rows={
                      analysis ? splitRows(analysis.splits, units, timing?.display ?? 'pace') : []
                    }
                    unitLabel={splitUnitLabel}
                    measure={timed ? (timing?.display ?? 'pace') : null}
                    loading={analysis === null}
                  />
                )}
              </ScrollView>
            </>
          )}
        </>
      )}

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
              {`Replace "${track.name}" with the trimmed segment? The cut portions (and any notes${
                photosCutByTrim > 0 ? ` and ${photoCountLabel(photosCutByTrim)}` : ''
              } on them) are permanently removed.`}
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
      </Portal>

      <TrailActionBar actions={actions} />

      {/* Trail photos (#587): themed View sheets, never a Paper Portal. */}
      {points && (
        <AddPhotosSheet
          visible={addingPhotos}
          track={track}
          points={points}
          fallbackDistanceM={
            scrub && photoIndex && analysis
              ? mapAlongPoints(analysis.axis.cumM, photoIndex.cumM, scrub.distanceM)
              : 0
          }
          onClose={() => setAddingPhotos(false)}
          onDone={(message) => {
            setAddingPhotos(false);
            void useTrailPhotosStore.getState().refresh(track.id);
            showSnack(message);
          }}
        />
      )}
      <ShareTrailSheet
        visible={sharing}
        track={track}
        photos={trailPhotos.photos}
        onClose={() => setSharing(false)}
        onMessage={showSnack}
      />

      {/* A note tapped on the map, the strip or a pin: the waypoint card
          (#505/#508), floating above the action bar — not a Portal dialog. */}
      {viewedNote && (
        <View
          style={[styles.noteCard, { bottom: insets.bottom + TRAIL_ACTION_BAR_H + 8 }]}
          pointerEvents="box-none"
        >
          <WaypointViewerCard
            floating
            waypoint={{
              label: `Note ${viewedNote.num} · ${formatDistance(viewedNote.note.distanceM)}`,
              latitude: viewedNote.latitude,
              longitude: viewedNote.longitude,
              note: viewedNote.note.text,
              ...(viewedNote.note.photoUri ? { photoUri: viewedNote.note.photoUri } : {}),
            }}
            onCopyCoords={() => {
              void Clipboard.setStringAsync(
                formatLatLng(viewedNote.latitude, viewedNote.longitude),
              );
              showSnack('Coordinates copied');
            }}
            onCopyNote={() => {
              void Clipboard.setStringAsync(viewedNote.note.text);
              showSnack('Note copied');
            }}
            onSharePhoto={() => {
              const uri = viewedNote.note.photoUri;
              if (!uri) return;
              void (async () => {
                if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
                else showSnack('Sharing is not available on this device');
              })();
            }}
            onEdit={() => {
              const n = viewedNote.note;
              setViewingNoteId(null);
              setDraft(n.text);
              setDraftPhoto(n.photoUri ?? null);
              setEditing({ mode: 'edit', noteId: n.id });
            }}
            onDelete={() => {
              removeTrackNote(trackId, viewedNote.note.id);
              setViewingNoteId(null);
              showSnack('Note deleted');
            }}
            onClose={() => setViewingNoteId(null)}
          />
        </View>
      )}

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
  mapBox: { backgroundColor: '#dfe9f2' },
  readout: {
    position: 'absolute',
    left: 12,
    bottom: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  readoutText: { fontSize: 12.5, fontWeight: '700' },
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
  titleText: { fontWeight: '800' },
  noteCard: { position: 'absolute', left: 8, right: 8 },
  // Kill Paper's default IconButton margin so the scissors don't inflate the
  // card, and pull it into the card's right padding to sit flush with the edge.
  summaryTrim: { margin: 0, marginRight: -8, marginVertical: -4 },
  trimBody: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 6, gap: 6 },
  trimActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  trimSaveActions: { flexDirection: 'row', gap: 8 },
  photoButtons: { flexDirection: 'row', gap: 8, marginTop: 8 },
  photoPreviewWrap: { marginTop: 10, alignItems: 'flex-start' },
  photoPreview: { width: '100%', height: 160, borderRadius: 8 },
  photoFull: { width: '100%', height: 360 },
});

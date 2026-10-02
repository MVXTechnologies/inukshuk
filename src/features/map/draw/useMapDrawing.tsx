import { canSave, canUndo, drawHint } from '@core/draw/editor';
import {
  boundsOfVertices,
  isSelfIntersecting,
  midpointHandles,
  polygonAreaM2,
  polygonPerimeterM,
} from '@core/draw/geometry';
import { hitHandle, type ScreenPoint } from '@core/draw/hitTest';
import {
  failedLegs,
  fitModes,
  isRoutedMode,
  legMidpointHandles,
  legViews,
  mergeLegs,
  outAndBack,
  outboundOf,
  canLoop,
  nearStart,
  routeLengthM,
  routingEngines,
  seedResultsFromLine,
  type LegMode,
  type LegView,
} from '@core/draw/legs';
import { buildDrawProfile } from '@core/draw/profile';
import { failureNotice } from '@core/draw/routing';
import { estimateDurationS, formatEstimate } from '@core/draw/timeEstimate';
import { formatElevation, type Units } from '@core/format';
import {
  areaAt,
  areaSummaryLine,
  DEFAULT_AREA_COLOR,
  formatAreaSize,
  nextAreaName,
} from '@core/library/areas';
import { compactDistance } from '@core/library/libraryRows';
import type { Area, LngLat, RouteFinish } from '@core/models';
import { loadTrackGeometry } from '@data/trackGeometry';
import { reportError } from '@lib/errorReporting';
import type { MapRef } from '@maplibre/maplibre-react-native';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore, type DrawRequest } from '@state/mapStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import * as Sharing from 'expo-sharing';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { BackHandler, Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from 'react-native-paper';

import { AreaCard } from './AreaCard';
import { AreaEditorSheet, type AreaDraft } from './AreaEditorSheet';
import { AreaLayers } from './AreaLayers';
import { DragHandle } from './DragHandle';
import { DrawChooser } from './DrawChooser';
import { DrawLayers } from './DrawLayers';
import {
  DrawHint,
  DrawNotice,
  DrawPanel,
  DrawStatus,
  finishLabel,
  ReturnChip,
  ReturnMenu,
  RouteModeChips,
  RoutingCredit,
  SelectedPointRow,
  type DrawStat,
} from './DrawPanels';
import { discardPhotos, pickAreaPhoto } from './areaPhotos';
import { overwriteDrawnRoute, writeAreaGeoJson, writeNewDrawnRoute } from './saveDrawn';
import { SaveRouteSheet } from './SaveRouteSheet';
import { isLoopTipRetired, useDrawSession, type DrawTarget } from './useDrawSession';
import { useLegRouting } from './useLegRouting';
import { ProfileStrip } from '../../common/components/ProfileStrip';
import { computeRouteElevation, shownElevation, useRouteElevation } from './useRouteElevation';

/**
 * The map's drawing tools, wired (#502 routes, #503 areas): the session, the
 * live stats, the save sheets, the saved areas on the map and their card.
 * MapScreen hands it taps and long-presses FIRST — while a tool is open every
 * map tap belongs to it — and renders the two node sets it returns: map
 * children (inside `<Map>`) and chrome (over it).
 */

const NO_VERTICES: readonly LngLat[] = [];
const NO_MODES: readonly LegMode[] = [];
const NO_LEGS: readonly LegView[] = [];
/** A long-press within this many px of a vertex deletes it. */
const LONG_PRESS_HIT_PX = 32;
/** A second ✕ within this window discards an unsaved drawing. */
const DISCARD_CONFIRM_MS = 3500;

export interface MapDrawingOptions {
  mapRef: RefObject<MapRef | null>;
  showSnack: (message: string) => void;
  units: Units;
  /** Top inset of the screen (status bar), for the chips/hint lane. */
  topInset: number;
  /** Close whatever else owns the screen (inspect panel, cards, chip). */
  onBeforeStart: () => void;
}

export interface MapDrawing {
  /** A drawing tool is open: map taps go to it, the "+" sheet steps aside. */
  active: boolean;
  /** The drawing panel's height (0 without one), to lift the bottom chrome. */
  panelHeight: number;
  /** A drawing sheet or the area card holds the bottom edge. */
  ownsBottom: boolean;
  viewAreaId: string | null;
  closeAreaCard: () => void;
  startRoute: () => void;
  startArea: () => void;
  /** "Draw" in the "+" menu: the Route / Area chooser. */
  openChooser: () => void;
  /** A map tap while a tool is open; true = consumed. */
  onMapTap: (lngLat: LngLat | null, point?: [number, number] | null) => boolean;
  /** The camera settled: the selected point's grip must follow it. */
  onCameraSettled: () => void;
  /** A long-press while a tool is open (deletes the vertex under it); true = consumed. */
  onMapLongPress: (point: [number, number] | null) => Promise<boolean>;
  /** A bare tap (nothing else claimed it) inside an area opens its card; true = consumed. */
  onAreaTap: (lngLat: LngLat) => boolean;
  mapLayers: ReactNode;
  chrome: ReactNode;
}

export function useMapDrawing({
  mapRef,
  showSnack,
  units,
  topInset,
  onBeforeStart,
}: MapDrawingOptions): MapDrawing {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const draw = useDrawSession();
  const tracks = useLibraryStore((s) => s.tracks);
  const areas = useLibraryStore((s) => s.areas);
  const addTrack = useLibraryStore((s) => s.addTrack);
  const updateTrack = useLibraryStore((s) => s.updateTrack);
  const addArea = useLibraryStore((s) => s.addArea);
  const updateArea = useLibraryStore((s) => s.updateArea);
  const removeArea = useLibraryStore((s) => s.removeArea);
  const drawRequest = useMapStore((s) => s.drawRequest);
  const setDrawRequest = useMapStore((s) => s.setDrawRequest);
  const setFocusBounds = useMapStore((s) => s.setFocusBounds);

  const [panelHeight, setPanelHeight] = useState(0);
  const [routeSaveOpen, setRouteSaveOpen] = useState(false);
  const [savingRoute, setSavingRoute] = useState(false);
  /** The area editor: a new ring to save, or a saved area being edited. */
  const [areaEditor, setAreaEditor] = useState<{
    areaId: string | null;
    ring: LngLat[];
    initial: AreaDraft;
  } | null>(null);
  const [viewAreaId, setViewAreaId] = useState<string | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [returnMenuOpen, setReturnMenuOpen] = useState(false);
  const discardArmedAt = useRef(0);

  const state = draw.state;
  const active = state !== null;
  const kind = state?.kind ?? null;
  const vertices = state?.vertices ?? NO_VERTICES;
  const routeVertices = kind === 'route' ? vertices : NO_VERTICES;
  const routeModes = kind === 'route' ? (state?.modes ?? NO_MODES) : NO_MODES;

  // --- Route legs (#515): Trails/Roads legs snapped by the routing proxy -------
  // How the route ends (#515): one way, back & forth, or a loop whose closing
  // leg (last point → first, in the last leg's mode) is a leg like the others.
  const finish = kind === 'route' ? (state?.finish ?? 'oneway') : 'oneway';
  const loop = finish === 'loop';
  const routing = useLegRouting(routeVertices, routeModes, kind === 'route', { loop });
  const seedLegs = routing.seed;
  const committedLegs = useMemo(
    () =>
      kind === 'route' ? legViews(routeVertices, routeModes, routing.results, { loop }) : NO_LEGS,
    [kind, routeVertices, routeModes, routing.results, loop],
  );
  /** The whole line as drawn (routed legs included): stats, climb and the saved GPX. */
  const routeLine = useMemo(
    () => (committedLegs.length > 0 ? mergeLegs(committedLegs) : routeVertices),
    [committedLegs, routeVertices],
  );
  // While a point is dragged, its two legs show straight until the drop.
  const shownLegs = useMemo(
    () =>
      kind !== 'route'
        ? NO_LEGS
        : draw.shown === routeVertices
          ? committedLegs
          : legViews(draw.shown, routeModes, routing.results, { loop }),
    [kind, draw.shown, routeVertices, committedLegs, routeModes, routing.results, loop],
  );
  const legMids = useMemo(() => legMidpointHandles(shownLegs), [shownLegs]);
  const legsLoading = committedLegs.some((l) => l.status === 'loading');
  const failed = failedLegs(committedLegs);
  const engines = routingEngines(committedLegs);

  // Back & forth: the return is the outbound line reversed — derived live, so
  // every outbound edit carries over, and never routed again.
  const backAndForth = finish === 'backforth';
  const fullLine = useMemo(
    () => (backAndForth ? outAndBack(routeLine) : routeLine),
    [backAndForth, routeLine],
  );
  const elevationState = useRouteElevation(fullLine, kind === 'route');
  const elevation = shownElevation(elevationState);
  // The profile strip: the same samples as the climb stat and the saved GPX.
  const profile = useMemo(
    () =>
      elevation !== null
        ? buildDrawProfile(elevation.plan.samples, elevation.elevation.elevations)
        : null,
    [elevation],
  );
  /** The point scrubbed on the profile (its marker on the map), or null. */
  const [scrubAt, setScrubAt] = useState<LngLat | null>(null);
  const onProfileScrub = useCallback(
    (p: { at: LngLat } | null) => setScrubAt(p === null ? null : p.at),
    [],
  );

  const editedTrackId = draw.target?.kind === 'route' ? (draw.target.trackId ?? null) : null;
  const editedTrack = editedTrackId ? (tracks.find((t) => t.id === editedTrackId) ?? null) : null;
  const editedAreaId = draw.target?.kind === 'area' ? (draw.target.areaId ?? null) : null;
  const viewArea = viewAreaId ? (areas.find((a) => a.id === viewAreaId) ?? null) : null;
  // The area whose shape is being edited is drawn by the tool, not twice.
  const shownAreas = useMemo(
    () => (editedAreaId ? areas.filter((a) => a.id !== editedAreaId) : areas),
    [areas, editedAreaId],
  );

  const begin = useCallback(
    (
      target: DrawTarget,
      initial: readonly LngLat[] = [],
      modes?: readonly LegMode[],
      mode?: LegMode,
      finish: RouteFinish = 'oneway',
    ) => {
      onBeforeStart();
      setViewAreaId(null);
      setChooserOpen(false);
      setRouteSaveOpen(false);
      setAreaEditor(null);
      discardArmedAt.current = 0;
      draw.start(target, initial, modes, mode, finish);
    },
    [draw, onBeforeStart],
  );

  const startRoute = useCallback(() => begin({ kind: 'route' }), [begin]);
  const startArea = useCallback(() => begin({ kind: 'area' }), [begin]);
  const openChooser = useCallback(() => {
    onBeforeStart();
    setViewAreaId(null);
    setChooserOpen(true);
  }, [onBeforeStart]);

  // One-shot requests from the trail view / Library ("Edit route", "Edit
  // shape", an area row's "Show on map").
  const handleRequest = useCallback(
    (request: DrawRequest) => {
      if (request.kind === 'edit-route') {
        const t = tracks.find((x) => x.id === request.trackId);
        if (!t?.plan) {
          showSnack('This trail was not drawn on the map, so it has no route to edit');
          return;
        }
        const plan = t.plan;
        const modes = fitModes(plan.legModes, plan.vertices.length);
        // Snapped legs come back from the saved line (no request, works
        // offline); the routing proxy is asked only for what can't be cut out.
        if (modes.some(isRoutedMode)) {
          void loadTrackGeometry(t)
            .then((g) => {
              if (!g) return;
              const saved = g.parts.flat();
              const first = plan.vertices[0];
              const last = plan.vertices[plan.vertices.length - 1];
              if (first === undefined || last === undefined) return;
              if (plan.finish === 'loop') {
                // A loop's line ends back at the start: its last stretch is
                // the closing leg, in the last leg's mode.
                const closing = modes[modes.length - 1] ?? 'freehand';
                seedLegs(
                  seedResultsFromLine(saved, [...plan.vertices, first], [...modes, closing]),
                );
                return;
              }
              // An out-and-back's saved line comes back: cut at the turnaround.
              const outbound = plan.finish === 'backforth' ? outboundOf(saved, last) : saved;
              seedLegs(seedResultsFromLine(outbound, plan.vertices, modes));
            })
            .catch(() => undefined);
        }
        begin(
          { kind: 'route', trackId: t.id },
          plan.vertices,
          modes,
          plan.mode,
          plan.finish ?? 'oneway',
        );
        const box = boundsOfVertices(plan.vertices);
        if (box) setFocusBounds(box, { top: 140, right: 60, bottom: 300, left: 60 });
        return;
      }
      const area = areas.find((a) => a.id === request.areaId);
      if (!area) return;
      const box = boundsOfVertices(area.ring);
      if (request.kind === 'edit-area-shape') {
        begin({ kind: 'area', areaId: area.id }, area.ring);
        if (box) setFocusBounds(box, { top: 140, right: 60, bottom: 300, left: 60 });
      } else {
        onBeforeStart();
        setViewAreaId(area.id);
        if (box) setFocusBounds(box, { top: 120, right: 60, bottom: 360, left: 60 });
      }
    },
    [tracks, areas, begin, setFocusBounds, showSnack, onBeforeStart, seedLegs],
  );
  useEffect(() => {
    if (drawRequest === null) return;
    // Deferred a tick: the request arrives with a navigation, and starting a
    // session is several state updates this effect must not make inline.
    const t = setTimeout(() => {
      setDrawRequest(null);
      handleRequest(drawRequest);
    }, 0);
    return () => clearTimeout(t);
  }, [drawRequest, setDrawRequest, handleRequest]);

  const exit = useCallback(() => {
    draw.exit();
    setReturnMenuOpen(false);
    setRouteSaveOpen(false);
    setPanelHeight(0);
  }, [draw]);

  const requestExit = () => {
    // An unsaved drawing is one stray tap from gone: the first ✕ warns.
    const dirty = state !== null && state.past.length > 0;
    const now = Date.now();
    if (dirty && now - discardArmedAt.current > DISCARD_CONFIRM_MS) {
      discardArmedAt.current = now;
      showSnack('Tap ✕ again to discard this drawing');
      return;
    }
    exit();
  };

  // Android Back: deselect, then the ✕ (with its discard warning); with no
  // tool open, Back closes a tapped area's card. The sheets register their
  // own handler (mounted later, so asked first).
  const backRef = useRef<() => boolean>(() => false);
  useEffect(() => {
    backRef.current = () => {
      if (state !== null) {
        if (state.selected !== null) draw.dispatch({ type: 'select', index: null });
        else requestExit();
        return true;
      }
      if (chooserOpen) {
        setChooserOpen(false);
        return true;
      }
      if (viewAreaId !== null) {
        setViewAreaId(null);
        return true;
      }
      return false;
    };
  });
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => backRef.current());
    return () => sub.remove();
  }, []);

  /** Screen positions of the handles, for the tap hit-test (null = not projectable). */
  const projectAll = useCallback(
    async (points: readonly LngLat[]): Promise<(ScreenPoint | null)[]> => {
      const map = mapRef.current;
      if (!map) return points.map(() => null);
      const res = await Promise.allSettled(points.map((p) => map.project(p)));
      return res.map((r) =>
        r.status === 'fulfilled' && r.value != null ? [r.value[0], r.value[1]] : null,
      );
    },
    [mapRef],
  );

  const onMapTap = useCallback(
    (lngLat: LngLat | null, point: [number, number] | null = null): boolean => {
      // A tap on the map beside the Draw chooser closes it (and does nothing else).
      if (chooserOpen) {
        setChooserOpen(false);
        return true;
      }
      if (state === null) return false;
      // A tap on the map beside the Return menu closes it, nothing else.
      if (returnMenuOpen) {
        setReturnMenuOpen(false);
        return true;
      }
      if (routeSaveOpen || areaEditor !== null || lngLat === null) return true;
      if (point === null) {
        draw.tap(lngLat, null);
        return true;
      }
      // A route's insert handles sit on its legs as drawn (on the trail).
      const handles =
        state.kind === 'route' ? legMids : midpointHandles(state.vertices, state.kind === 'area');
      const mids = handles.map((m) => m.at);
      void Promise.all([projectAll(state.vertices), projectAll(mids)]).then(([v, m]) =>
        draw.tap(
          lngLat,
          // The start closes the loop: a bigger target, ahead of a new point.
          hitHandle(v, m, point, {
            startFirst:
              state.kind === 'route' && state.vertices.length >= 3 && state.finish !== 'loop',
          }),
          state.kind === 'route' ? handles : undefined,
        ),
      );
      return true;
    },
    [state, draw, routeSaveOpen, areaEditor, projectAll, legMids, chooserOpen, returnMenuOpen],
  );

  // The selected vertex's grip sits over it on screen: re-projected whenever
  // the selection, the shape or the camera (`cameraVersion`) changes.
  const [cameraVersion, setCameraVersion] = useState(0);
  const [gripAt, setGripAt] = useState<ScreenPoint | null>(null);
  const selectedVertex =
    state !== null && state.selected !== null ? (state.vertices[state.selected] ?? null) : null;
  useEffect(() => {
    let alive = true;
    if (selectedVertex === null) {
      const t = setTimeout(() => setGripAt(null), 0);
      return () => clearTimeout(t);
    }
    void projectAll([selectedVertex]).then(([p]) => {
      if (alive) setGripAt(p ?? null);
    });
    return () => {
      alive = false;
    };
  }, [selectedVertex, cameraVersion, projectAll]);

  const unproject = useCallback(
    async (x: number, y: number): Promise<LngLat | null> => {
      try {
        const ll = await mapRef.current?.unproject([x, y]);
        return ll ? [ll[0], ll[1]] : null;
      } catch {
        return null;
      }
    },
    [mapRef],
  );
  const lastMoveAt = useRef(0);
  const onGripMove = (x: number, y: number) => {
    const index = state?.selected;
    if (index === null || index === undefined) return;
    // Throttled: each preview is a bridge round-trip and a source update.
    const now = Date.now();
    if (now - lastMoveAt.current < 50) return;
    lastMoveAt.current = now;
    void unproject(x, y).then((at) => {
      if (at) draw.dragTo(index, at);
    });
  };
  const onGripEnd = (x: number, y: number) => {
    const index = state?.selected;
    if (index === null || index === undefined) return;
    void unproject(x, y).then((at) => draw.dragEnd(index, at));
  };

  const onMapLongPress = useCallback(
    async (point: [number, number] | null): Promise<boolean> => {
      if (state === null) return false;
      const map = mapRef.current;
      if (!map || point === null || state.vertices.length === 0) return true;
      let best = -1;
      let bestD = LONG_PRESS_HIT_PX;
      const projected = await Promise.allSettled(state.vertices.map((v) => map.project(v)));
      projected.forEach((r, i) => {
        if (r.status !== 'fulfilled' || r.value == null) return;
        const d = Math.hypot(r.value[0] - point[0], r.value[1] - point[1]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0) draw.dispatch({ type: 'remove', index: best });
      return true;
    },
    [state, draw, mapRef],
  );

  const onAreaTap = useCallback(
    (lngLat: LngLat): boolean => {
      const hit = areaAt(shownAreas, lngLat);
      if (hit === null) {
        setViewAreaId(null);
        return false;
      }
      if (hit.id === viewAreaId) {
        // A second tap on the open area closes its card and lets the tap be
        // an ordinary map tap (the coordinates chip).
        setViewAreaId(null);
        return false;
      }
      setViewAreaId(hit.id);
      return true;
    },
    [shownAreas, viewAreaId],
  );

  // --- Route stats ------------------------------------------------------------
  const distanceM = kind === 'route' ? routeLengthM(shownLegs) * (backAndForth ? 2 : 1) : 0;
  const climb =
    elevation !== null
      ? `↑ ${formatElevation(elevation.elevation.ascentM, units)}`
      : elevationState.status === 'computing'
        ? '↑ …'
        : '↑ —';
  const ascentForEstimate = elevation?.elevation.ascentM ?? 0;
  const estimateFor = (category: string | null) =>
    `≈ ${formatEstimate(estimateDurationS(distanceM, ascentForEstimate, category))}`;

  const saveRoute = async (name: string, category: string | null) => {
    if (state === null || !canSave(state) || legsLoading) return;
    setSavingRoute(true);
    try {
      const current = state.vertices;
      const line = fullLine;
      // The debounced numbers may trail the last edit: compute for exactly
      // what is being saved (cached tiles make this quick).
      const fresh =
        elevation !== null && elevation.vertices === line
          ? elevation
          : await computeRouteElevation(line).catch(() => null);
      const input = {
        vertices: current,
        line,
        legModes: state.modes,
        mode: state.mode,
        finish: state.finish,
        name: name || editedTrack?.name || `Route ${tracks.filter((t) => t.plan).length + 1}`,
        category,
        elevation: fresh,
      };
      if (editedTrack) {
        await overwriteDrawnRoute(editedTrack, input, (patch) =>
          updateTrack(editedTrack.id, patch),
        );
        showSnack(`Route "${input.name}" updated`);
      } else {
        const { track, fileUri } = writeNewDrawnRoute(input);
        addTrack(track, fileUri);
        // Show what was just saved: the new route joins the trails on the map.
        const lib = useLibraryStore.getState();
        if (!lib.activeTrackIds.includes(track.id)) {
          lib.setActiveTrackIds([...lib.activeTrackIds, track.id]);
        }
        showSnack(`Route "${track.name}" saved to Library`);
      }
      setRouteSaveOpen(false);
      exit();
    } catch (err) {
      reportError(err, 'draw-route-save');
      showSnack('Could not save the route. Please try again.');
    } finally {
      setSavingRoute(false);
    }
  };

  // --- Area flow ----------------------------------------------------------------
  const finishArea = () => {
    if (state === null || !canSave(state)) return;
    const ring = [...state.vertices];
    if (editedAreaId) {
      // "Edit shape" of a saved area: the new ring is the whole edit.
      updateArea(editedAreaId, { ring });
      exit();
      setViewAreaId(editedAreaId);
      showSnack('Area updated');
      return;
    }
    setAreaEditor({
      areaId: null,
      ring,
      initial: {
        name: nextAreaName(areas.map((a) => a.name)),
        note: '',
        color: DEFAULT_AREA_COLOR,
        photoUris: [],
        tags: [],
      },
    });
  };

  const openAreaEditor = (area: Area) => {
    setAreaEditor({
      areaId: area.id,
      ring: area.ring,
      initial: {
        name: area.name,
        note: area.note ?? '',
        color: area.color,
        photoUris: area.photoUris ?? [],
        tags: area.tags ?? [],
      },
    });
  };

  const saveAreaDraft = (draft: AreaDraft) => {
    if (areaEditor === null) return;
    try {
      if (areaEditor.areaId) {
        updateArea(areaEditor.areaId, draft);
        setViewAreaId(areaEditor.areaId);
        showSnack('Area saved');
      } else {
        const id = addArea({ ...draft, ring: areaEditor.ring });
        exit();
        setViewAreaId(id);
        showSnack(`Area "${draft.name || 'Area'}" saved to Library`);
      }
      setAreaEditor(null);
    } catch (err) {
      reportError(err, 'draw-area-save');
      showSnack('Could not save the area. Please try again.');
    }
  };

  const addPhotoToViewed = async () => {
    if (!viewArea) return;
    try {
      const uri = await pickAreaPhoto(false);
      if (uri === null) return;
      try {
        updateArea(viewArea.id, { photoUris: [...(viewArea.photoUris ?? []), uri] });
      } catch (err) {
        discardPhotos([uri]);
        throw err;
      }
    } catch (err) {
      reportError(err, 'area-photo');
      showSnack('Could not add the photo');
    }
  };

  const shareViewed = async () => {
    if (!viewArea) return;
    try {
      if (!(await Sharing.isAvailableAsync())) {
        showSnack('Sharing is not available on this device');
        return;
      }
      const uri = writeAreaGeoJson(viewArea);
      await Sharing.shareAsync(uri, { mimeType: 'application/geo+json', UTI: 'public.json' });
    } catch (err) {
      reportError(err, 'area-share');
      showSnack('Could not share the area');
    }
  };

  // --- Render pieces ----------------------------------------------------------------
  const lineColor = tokens.explore.trail;
  const mapLayers = (
    <>
      <AreaLayers areas={shownAreas} selectedId={viewAreaId} />
      {state !== null && (
        <DrawLayers
          kind={state.kind}
          shown={draw.shown}
          selected={state.selected}
          legs={state.kind === 'route' ? shownLegs : undefined}
          mids={state.kind === 'route' ? legMids : undefined}
          warnColor={tokens.status.pausedInk}
          scrubAt={state.kind === 'route' && profile !== null ? scrubAt : null}
          color={
            state.kind === 'route' ? lineColor : (areaEditor?.initial.color ?? DEFAULT_AREA_COLOR)
          }
          halo={tokens.explore.trailHalo}
          ink={tokens.inkVariant}
          selectedColor={theme.colors.error}
        />
      )}
    </>
  );

  let panel: ReactNode = null;
  if (state !== null && !routeSaveOpen && areaEditor === null) {
    const selectedRow =
      state.selected !== null ? (
        <SelectedPointRow
          label={`${state.kind === 'route' ? 'Point' : 'Corner'} ${state.selected + 1} selected`}
          onDelete={() => {
            if (state.selected !== null) draw.dispatch({ type: 'remove', index: state.selected });
          }}
          onDeselect={() => draw.dispatch({ type: 'select', index: null })}
        />
      ) : null;
    if (state.kind === 'route') {
      const stats: DrawStat[] = [
        { value: compactDistance(distanceM, units), label: 'distance' },
        {
          value: climb,
          label: 'climb',
          accessibilityLabel:
            elevation !== null
              ? `climb ${formatElevation(elevation.elevation.ascentM, units)}`
              : elevationState.status === 'computing'
                ? 'climb, computing'
                : 'climb unavailable',
        },
        {
          value: formatEstimate(estimateDurationS(distanceM, ascentForEstimate)),
          label: 'estimated',
        },
      ];
      panel = (
        <DrawPanel
          title={editedTrack ? `Edit route · ${editedTrack.name}` : 'Draw a route'}
          stats={stats}
          notice={
            selectedRow ??
            (failed.length > 0 ? (
              <DrawNotice
                text={failureNotice(failed.map((l) => l.reason ?? 'error')) ?? ''}
                action={{ label: 'Retry', onPress: routing.retry }}
              />
            ) : legsLoading ? (
              <DrawStatus
                text={
                  committedLegs.some((l) => l.status === 'loading' && l.mode === 'roads')
                    ? 'Finding the road…'
                    : 'Finding the trail…'
                }
              />
            ) : elevationState.status === 'unavailable' && vertices.length >= 2 ? (
              <DrawNotice text="Climb unavailable here (offline, or the route is too long)" />
            ) : null)
          }
          chart={
            profile !== null && vertices.length >= 2 ? (
              <ProfileStrip
                profile={profile}
                units={units}
                // Newer numbers on the way (a leg added, snapped, dragged or
                // undone): the last profile stays, dimmed, never blank.
                dimmed={
                  elevationState.status === 'computing' ||
                  legsLoading ||
                  elevation?.vertices !== fullLine
                }
                onScrub={onProfileScrub}
                turnaroundRatio={backAndForth ? 0.5 : undefined}
              />
            ) : undefined
          }
          toggle={{
            label: finishLabel(state.finish),
            render: (showLabel) => (
              <ReturnChip
                finish={state.finish}
                disabled={state.vertices.length < 2}
                open={returnMenuOpen}
                showLabel={showLabel}
                onPress={() => setReturnMenuOpen((o) => !o)}
              />
            ),
          }}
          overlay={
            returnMenuOpen
              ? (bottom) => (
                  <>
                    {/* A tap anywhere else on the panel closes the menu. */}
                    <Pressable
                      style={StyleSheet.absoluteFill}
                      onPress={() => setReturnMenuOpen(false)}
                      accessibilityLabel="Close return options"
                      testID="return-menu-backdrop"
                    />
                    <ReturnMenu
                      finish={state.finish}
                      bottom={bottom}
                      loopHint={canLoop(state.vertices) ? null : 'Add a third point first'}
                      onPick={(f) => {
                        setReturnMenuOpen(false);
                        draw.dispatch({ type: 'finish', finish: f });
                      }}
                    />
                  </>
                )
              : undefined
          }
          footer={engines !== null ? <RoutingCredit engines={engines} /> : undefined}
          canUndo={canUndo(state)}
          canClear={state.vertices.length > 0}
          canSave={canSave(state) && !legsLoading}
          saveLabel={editedTrack ? 'Save changes' : 'Save route'}
          onUndo={() => draw.dispatch({ type: 'undo' })}
          onClear={() => draw.dispatch({ type: 'clear' })}
          onSave={() => setRouteSaveOpen(true)}
          onExit={requestExit}
          onLayout={(e) => setPanelHeight(e.nativeEvent.layout.height)}
        />
      );
    } else {
      const crossing = isSelfIntersecting(draw.shown);
      const stats: DrawStat[] = [
        { value: formatAreaSize(polygonAreaM2(draw.shown), units), label: 'area' },
        { value: compactDistance(polygonPerimeterM(draw.shown), units), label: 'perimeter' },
        { value: String(state.vertices.length), label: 'corners' },
      ];
      panel = (
        <DrawPanel
          title={editedAreaId ? 'Edit area shape' : 'Draw an area'}
          stats={stats}
          notice={
            selectedRow ??
            (crossing ? (
              <DrawNotice text="Edges cross — move a corner to untangle the area" />
            ) : null)
          }
          canUndo={canUndo(state)}
          canClear={state.vertices.length > 0}
          canSave={canSave(state)}
          saveLabel="Done"
          onUndo={() => draw.dispatch({ type: 'undo' })}
          onClear={() => draw.dispatch({ type: 'clear' })}
          onSave={finishArea}
          onExit={requestExit}
          onLayout={(e) => setPanelHeight(e.nativeEvent.layout.height)}
        />
      );
    }
  }

  // Under the compass (8 + 48 + 8): the rail keeps the right edge.
  const laneTop = topInset + 64;
  const chrome = (
    <>
      {/* The mode picker takes the search pill's slot, right of the compass. */}
      {state !== null && state.kind === 'route' && (
        <RouteModeChips
          mode={state.mode}
          top={topInset + 8}
          onChange={(mode) => draw.dispatch({ type: 'mode', mode })}
        />
      )}
      {state !== null && !routeSaveOpen && areaEditor === null && (
        <DrawHint
          text={drawHint(state)}
          top={laneTop}
          tip={
            state.kind === 'route' &&
            state.finish !== 'loop' &&
            nearStart(state.vertices) &&
            !isLoopTipRetired()
              ? 'Tap the start to close the loop'
              : undefined
          }
        />
      )}
      {chooserOpen && state === null && (
        <View style={styles.dock} pointerEvents="box-none">
          <DrawChooser
            onPick={(kind) => (kind === 'route' ? startRoute() : startArea())}
            onClose={() => setChooserOpen(false)}
          />
        </View>
      )}
      {state !== null && gripAt !== null && !routeSaveOpen && areaEditor === null && (
        <DragHandle
          at={gripAt}
          color={theme.colors.error}
          fill={tokens.surface}
          onMove={onGripMove}
          onEnd={onGripEnd}
          onCancel={() => draw.dragEnd(state.selected ?? 0, null)}
        />
      )}
      {panel !== null && (
        <View style={styles.dock} pointerEvents="box-none">
          {panel}
        </View>
      )}
      {state !== null && state.kind === 'route' && routeSaveOpen && (
        <SaveRouteSheet
          initialName={editedTrack?.name ?? `Route ${tracks.filter((t) => t.plan).length + 1}`}
          initialCategory={
            editedTrack?.category && editedTrack.category !== 'navigation'
              ? editedTrack.category
              : null
          }
          summary={`${compactDistance(distanceM, units)} · ${climb}`}
          estimateFor={estimateFor}
          saving={savingRoute}
          editing={editedTrack !== null}
          onSave={(name, category) => void saveRoute(name, category)}
          onCancel={() => setRouteSaveOpen(false)}
        />
      )}
      {areaEditor !== null && (
        <AreaEditorSheet
          initial={areaEditor.initial}
          summary={areaSummaryLine(areaEditor.ring, units)}
          editing={areaEditor.areaId !== null}
          onSave={saveAreaDraft}
          onCancel={() => setAreaEditor(null)}
          onEditShape={
            areaEditor.areaId !== null
              ? () => {
                  const area = areas.find((a) => a.id === areaEditor.areaId);
                  setAreaEditor(null);
                  if (area) begin({ kind: 'area', areaId: area.id }, area.ring);
                }
              : undefined
          }
          onError={showSnack}
        />
      )}
      {viewArea !== null && state === null && areaEditor === null && (
        <View style={styles.cardDock} pointerEvents="box-none" testID="area-card-dock">
          <AreaCard
            area={viewArea}
            units={units}
            onEdit={() => openAreaEditor(viewArea)}
            onDelete={() => {
              try {
                removeArea(viewArea.id);
                setViewAreaId(null);
                showSnack('Area deleted');
              } catch {
                showSnack('Could not delete the area. Please try again.');
              }
            }}
            onClose={() => setViewAreaId(null)}
            onAddPhoto={() => void addPhotoToViewed()}
            onShare={() => void shareViewed()}
          />
        </View>
      )}
    </>
  );

  return {
    active,
    panelHeight: panel !== null ? panelHeight : 0,
    ownsBottom: active || chooserOpen || areaEditor !== null || viewArea !== null,
    viewAreaId,
    closeAreaCard: () => setViewAreaId(null),
    startRoute,
    startArea,
    openChooser,
    onMapTap,
    onCameraSettled: () => setCameraVersion((v) => v + 1),
    onMapLongPress,
    onAreaTap,
    mapLayers,
    chrome,
  };
}

const styles = StyleSheet.create({
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 9 },
  cardDock: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 7 },
});

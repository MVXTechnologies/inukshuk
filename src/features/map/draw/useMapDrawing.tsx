import { canSave, canUndo, drawHint } from '@core/draw/editor';
import {
  boundsOfVertices,
  isSelfIntersecting,
  polygonAreaM2,
  polygonPerimeterM,
  polylineLengthM,
} from '@core/draw/geometry';
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
import type { Area, LngLat } from '@core/models';
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
import { StyleSheet, View } from 'react-native';
import { useTheme } from 'react-native-paper';

import { AreaCard } from './AreaCard';
import { AreaEditorSheet, type AreaDraft } from './AreaEditorSheet';
import { AreaLayers } from './AreaLayers';
import { DrawLayers } from './DrawLayers';
import {
  DrawHint,
  DrawNotice,
  DrawPanel,
  RouteModeChips,
  SelectedPointRow,
  type DrawStat,
} from './DrawPanels';
import { discardPhotos, pickAreaPhoto } from './areaPhotos';
import { overwriteDrawnRoute, writeAreaGeoJson, writeNewDrawnRoute } from './saveDrawn';
import { SaveRouteSheet } from './SaveRouteSheet';
import { useDrawSession, type DrawTarget } from './useDrawSession';
import { computeRouteElevation, shownElevation, useRouteElevation } from './useRouteElevation';

/**
 * The map's drawing tools, wired (#502 routes, #503 areas): the session, the
 * live stats, the save sheets, the saved areas on the map and their card.
 * MapScreen hands it taps and long-presses FIRST — while a tool is open every
 * map tap belongs to it — and renders the two node sets it returns: map
 * children (inside `<Map>`) and chrome (over it).
 */

const NO_VERTICES: readonly LngLat[] = [];
/** A long-press within this many px of a vertex deletes it. */
const VERTEX_HIT_PX = 32;
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
  /** A map tap while a tool is open; true = consumed. */
  onMapTap: (lngLat: LngLat | null) => boolean;
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
  const discardArmedAt = useRef(0);

  const state = draw.state;
  const active = state !== null;
  const kind = state?.kind ?? null;
  const vertices = state?.vertices ?? NO_VERTICES;
  const routeVertices = kind === 'route' ? vertices : NO_VERTICES;
  const elevationState = useRouteElevation(routeVertices, kind === 'route');
  const elevation = shownElevation(elevationState);

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
    (target: DrawTarget, initial: readonly LngLat[] = []) => {
      onBeforeStart();
      setViewAreaId(null);
      setRouteSaveOpen(false);
      setAreaEditor(null);
      discardArmedAt.current = 0;
      draw.start(target, initial);
    },
    [draw, onBeforeStart],
  );

  const startRoute = useCallback(() => begin({ kind: 'route' }), [begin]);
  const startArea = useCallback(() => begin({ kind: 'area' }), [begin]);

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
        begin({ kind: 'route', trackId: t.id }, t.plan.vertices);
        const box = boundsOfVertices(t.plan.vertices);
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
    [tracks, areas, begin, setFocusBounds, showSnack, onBeforeStart],
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

  const onMapTap = useCallback(
    (lngLat: LngLat | null): boolean => {
      if (state === null) return false;
      if (routeSaveOpen || areaEditor !== null) return true;
      if (state.selected !== null) draw.dispatch({ type: 'select', index: null });
      else if (lngLat) draw.dispatch({ type: 'add', at: lngLat });
      return true;
    },
    [state, draw, routeSaveOpen, areaEditor],
  );

  const onMapLongPress = useCallback(
    async (point: [number, number] | null): Promise<boolean> => {
      if (state === null) return false;
      const map = mapRef.current;
      if (!map || point === null || state.vertices.length === 0) return true;
      let best = -1;
      let bestD = VERTEX_HIT_PX;
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
  const distanceM = kind === 'route' ? polylineLengthM(draw.shown) : 0;
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
    if (state === null || !canSave(state)) return;
    setSavingRoute(true);
    try {
      const current = state.vertices;
      // The debounced numbers may trail the last edit: compute for exactly
      // what is being saved (cached tiles make this quick).
      const fresh =
        elevation !== null && elevation.vertices === current
          ? elevation
          : await computeRouteElevation(current).catch(() => null);
      const input = {
        vertices: current,
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
          vertices={state.vertices}
          selected={state.selected}
          revision={draw.revision}
          color={
            state.kind === 'route' ? lineColor : (areaEditor?.initial.color ?? DEFAULT_AREA_COLOR)
          }
          halo={tokens.explore.trailHalo}
          ink={tokens.inkVariant}
          selectedColor={theme.colors.error}
          {...draw.handles}
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
            (elevationState.status === 'unavailable' && vertices.length >= 2 ? (
              <DrawNotice text="Climb unavailable here (offline, or the route is too long)" />
            ) : null)
          }
          canUndo={canUndo(state)}
          canClear={state.vertices.length > 0}
          canSave={canSave(state)}
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

  const laneTop = topInset + 8;
  const chrome = (
    <>
      {state !== null && state.kind === 'route' && <RouteModeChips mode="freehand" top={laneTop} />}
      {state !== null && !routeSaveOpen && areaEditor === null && (
        <DrawHint
          text={drawHint(state)}
          top={state.kind === 'route' ? laneTop + 56 + 8 : laneTop}
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
    ownsBottom: active || areaEditor !== null || viewArea !== null,
    viewAreaId,
    closeAreaCard: () => setViewAreaId(null),
    startRoute,
    startArea,
    onMapTap,
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

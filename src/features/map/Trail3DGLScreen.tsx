import { parseGpx } from '@core/geo/gpx';
import {
  computeTrackStats,
  interpolateTrackAtDistance,
  withDemElevations,
  type TrackPointAt,
} from '@core/geo/track';
import { numberNotesOnTrack, orderNotes, type NumberedTrailNote } from '@core/library/notes';
import { padBbox } from '@core/geo/terrain';
import type { TrackPoint } from '@core/models';
import * as storage from '@data/storage';
import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatPace,
  formatSpeed,
} from '@lib/format';
import { reportError } from '@lib/errorReporting';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore, type MapBasemap } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
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
  TextInput,
  useTheme,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as THREE from 'three';
import { fetchHeightmap, type Heightmap } from './dem';
import { SharingUnavailableError, exportTrailPdf } from '../common/exportTrailPdf';
import { rayGroundHit, zoomTowardPoint } from '@core/geo/terrainRay';
import { createCameraDynamics } from './terrain3d/cameraDynamics';
import { disposeGroup, runRenderLoop, useGlGeneration } from './terrain3d/glLifecycle';
import {
  ORBIT_PHI_PER_PX,
  ORBIT_THETA_PER_PX,
  clamp,
  createTerrainPanResponder,
  groundPanDelta,
  positionCameraFromOrbit,
  screenPointRay,
} from './terrain3d/orbitGestures';
import { TapQueryChip, queryMarkerOpacity, useTapQuery } from './terrain3d/queryChip';
import {
  addSkyAndFog,
  addTerrainLights,
  buildMarkerPin,
  buildQueryMarker,
  createTerrainCamera,
  createTerrainRenderer,
  fetchDrapeTexture,
} from './terrain3d/sceneSetup';
import { currentOverlaySettings, useTerrainOverlaySync } from './terrain3d/overlayControls';
import { TrailViewerRail } from './TrailViewerRail';
import {
  applyTerrainOverlaySettings,
  overlayRenderFailed,
  supportsStandardDerivatives,
  type TerrainOverlayHandle,
} from './terrain3d/terrainMaterial';
import {
  buildTerrain,
  markerScaleForDistance,
  type HeightSampler,
  type TerrainBuild,
} from './terrainScene';
import { ElevationProfile } from '../common/components/ElevationProfile';
import { NoteNumberBadge } from './components/NoteNumberBadge';
import { Trail2DView } from './Trail2DView';
import { useTimedSnackbar } from '../common/useTimedSnackbar';

interface Props {
  trackId: string;
}

type Editing = { mode: 'add'; distanceM: number } | { mode: 'edit'; noteId: string };

/** Build a terrain group for a basemap choice, draping its tiles (or relief). */
async function buildGroupFor(
  hm: Heightmap,
  pts: readonly TrackPoint[],
  bm: MapBasemap,
  maxAnisotropy = 1,
  injectOverlays = true,
): Promise<TerrainBuild> {
  return buildTerrain(hm, pts, await fetchDrapeTexture(hm.range, bm), maxAnisotropy, {
    injectOverlays,
  });
}

/**
 * The unified trail view: real 3D terrain (expo-gl + Three.js) on top, then the
 * elevation profile and notes/photos + PDF export below in one scroll. Scrubbing
 * the profile drives a marker on the 3D terrain. One finger orbits; two fingers
 * pinch to zoom and drag to tilt/rotate.
 */
export function Trail3DGLScreen({ trackId }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const hintColor = { color: theme.colors.onSurfaceVariant };
  const router = useRouter();
  const track = useLibraryStore((s) => s.tracks.find((t) => t.id === trackId));
  const addTrackNote = useLibraryStore((s) => s.addTrackNote);
  const updateTrackNote = useLibraryStore((s) => s.updateTrackNote);
  const removeTrackNote = useLibraryStore((s) => s.removeTrackNote);

  const trailViewMode = useSettingsStore((s) => s.trailViewMode);

  const [points, setPoints] = useState<TrackPoint[] | null>(null);
  // Same points but with each altitude replaced by the terrain (DEM) height the
  // 3D view drapes the trail on, so the elevation profile always matches the 3D.
  const [demPoints, setDemPoints] = useState<TrackPoint[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  // Viewer-local basemap (drives both the 2D map and the 3D drape), seeded from
  // the main map's choice so opening the viewer looks like the map you came
  // from; picking in the rail never repaints the main map.
  const [basemap, setBasemap] = useState<MapBasemap>(() => useMapStore.getState().basemap);
  const [switching, setSwitching] = useState(false);
  // Measured summary-card height so the control rail sits just below it.
  const [summaryH, setSummaryH] = useState(64);
  const [scrub, setScrub] = useState<TrackPointAt | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState('');
  const [draftPhoto, setDraftPhoto] = useState<string | null>(null);
  const [viewingPhoto, setViewingPhoto] = useState<string | null>(null);
  // Note badge tapped on the trail (2D pin or 3D projected circle): shows the
  // note text + photo in place, without hunting for its row in the list below.
  const [viewingNoteId, setViewingNoteId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // True while a finger is down on the map/terrain box. The whole screen lives
  // in a ScrollView, which intercepts vertical drags before they reach the
  // native MapLibre view — pans "sort of" worked, stuttering against the page
  // scroll (the 3D GLView was immune only because its PanResponder claims the
  // JS responder). Disabling the scroll for the duration of a touch inside the
  // box gives the map the full gesture, matching how the main map feels.
  const [mapGesturing, setMapGesturing] = useState(false);
  // False once the overlay shader is unavailable (no derivatives / compile
  // failure) so the Slope/Contours/Tint toggles hide instead of doing nothing.
  const [overlaysAvailable, setOverlaysAvailable] = useState(true);
  const { message: snack, show: showSnack, dismiss: dismissSnack } = useTimedSnackbar(2500);

  const orbit = useRef({
    theta: 0.6,
    phi: 0.85,
    radius: 4,
    center: new THREE.Vector3(),
    // Trail centre the camera was framed on, and how far the look-at point may be
    // panned from it (two-finger drag) so you can move around a bit, not fly off.
    home: new THREE.Vector3(),
    maxPan: 1,
  });
  const projectRef = useRef<((lng: number, lat: number) => THREE.Vector3) | null>(null);
  const maxAnisoRef = useRef(1);
  const scrubRef = useRef<TrackPointAt | null>(null);
  // Numbered note badges floated over the GL surface (parity with the 2D
  // view's Marker pins): screen positions are projected in the render loop at
  // ~8 Hz and only committed to state when they actually moved, so an idle
  // camera causes zero re-renders.
  const [noteBadges, setNoteBadges] = useState<{ id: string; num: number; x: number; y: number }[]>(
    [],
  );
  const noteBadgesRef = useRef<{ id: string; num: number; x: number; y: number }[]>([]);
  const numberedNotesRef = useRef<NumberedTrailNote[]>([]);
  const noteAccumRef = useRef(0);
  // P2 interaction polish: inertia + fly-to springs, view size for tap/pinch
  // picking, terrain samplers for zoom-anchoring, collision and tap-to-query.
  const dyn = useMemo(() => createCameraDynamics(), []);
  const viewSizeRef = useRef({ w: 0, h: 0 });
  const heightAtRef = useRef<HeightSampler | null>(null);
  const queryAtRef = useRef<TerrainBuild['queryAt'] | null>(null);
  const queryMarkerRef = useRef<ReturnType<typeof buildQueryMarker> | null>(null);
  const queryElapsedMsRef = useRef<number | null>(null);
  const { info: tapInfo, show: showTapInfo } = useTapQuery();
  const sceneRef = useRef<THREE.Scene | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  // Analytical-overlay shader state: whether injection is usable on this device
  // (derivatives support, no compile failure) and the live uniforms handle.
  const injectOkRef = useRef(true);
  const overlayRef = useRef<TerrainOverlayHandle | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  useTerrainOverlaySync(overlayRef);
  const hmRef = useRef<Awaited<ReturnType<typeof fetchHeightmap>> | null>(null);
  const ptsRef = useRef<readonly TrackPoint[]>([]);
  const basemapRef = useRef<MapBasemap>(basemap);
  // GL generation: every 2D↔3D toggle remounts the GLView; the render loop must
  // not outlive its context (see useGlGeneration).
  const glGenRef = useGlGeneration();

  const pan = useMemo(() => {
    // The ground point under a view-local screen position (tap / pinch
    // centroid), ray-marched against the terrain heightfield.
    const groundHitAt = (x: number, y: number) => {
      const camera = cameraRef.current;
      const heightAt = heightAtRef.current;
      if (!camera || !heightAt) return null;
      const { w, h } = viewSizeRef.current;
      const ray = screenPointRay(camera, x, y, w, h);
      return ray && rayGroundHit(ray.origin, ray.dir, heightAt);
    };
    const clampPan = (v: number, home: number, maxPan: number) =>
      clamp(v, home - maxPan, home + maxPan);
    // Refs are read on touch events only, never during render.
    // eslint-disable-next-line react-hooks/refs
    return createTerrainPanResponder({
      orbit,
      // Two-finger drag (beyond the shared pinch-zoom) pans the look-at point
      // across the ground (move around the trail a bit), bounded to maxPan
      // from the trail centre.
      onTwoFinger: (curr, prev) => {
        const o = orbit.current;
        const { dx, dz } = groundPanDelta(o.theta, o.radius, curr.cx - prev.cx, curr.cy - prev.cy);
        o.center.x = clampPan(o.center.x + dx, o.home.x, o.maxPan);
        o.center.z = clampPan(o.center.z + dz, o.home.z, o.maxPan);
      },
      // One finger orbits: drag sideways to rotate, up/down to tilt.
      onSingle: (dxPx, dyPx) => {
        const o = orbit.current;
        o.theta -= dxPx * ORBIT_THETA_PER_PX;
        o.phi = clamp(o.phi - dyPx * ORBIT_PHI_PER_PX, 0.12, 1.45);
      },
      // A new touch always wins over coasting/flying camera motion.
      onGestureStart: () => dyn.interrupt(),
      // Release inertia: keep orbiting with the drag's velocity, decayed in
      // onFrame (dyn.stepMomentum).
      onRelease: (vel) => dyn.launchMomentum(vel),
      // Anchor the pinch-zoom on the ground under the fingers: scale the
      // centre's offset from the hit by the same factor as the radius.
      onPinch: (scale, cx, cy) => {
        const hit = groundHitAt(cx, cy);
        if (!hit) return;
        const o = orbit.current;
        const c = zoomTowardPoint({ x: o.center.x, z: o.center.z }, hit, scale);
        o.center.x = clampPan(c.x, o.home.x, o.maxPan);
        o.center.z = clampPan(c.z, o.home.z, o.maxPan);
      },
      // Tap-to-query: elevation + slope chip and a fading crosshair.
      onTap: (x, y) => {
        const hit = groundHitAt(x, y);
        const query = queryAtRef.current;
        if (!hit || !query) return;
        showTapInfo(query(hit.x, hit.z));
        const m = queryMarkerRef.current;
        if (m) {
          m.group.position.set(hit.x, hit.y + 0.004, hit.z);
          m.setOpacity(1);
          queryElapsedMsRef.current = 0;
        }
      },
      // Double-tap: fly toward the tapped ground point (same anchored-zoom
      // maths as the pinch, eased by the spring instead of applied raw).
      onDoubleTap: (x, y) => {
        const hit = groundHitAt(x, y);
        if (!hit) return;
        const o = orbit.current;
        const s = 0.55;
        const c = zoomTowardPoint({ x: o.center.x, z: o.center.z }, hit, s);
        dyn.flyTo(o, {
          radius: clamp(o.radius * s, 0.8, 9),
          centerX: clampPan(c.x, o.home.x, o.maxPan),
          centerZ: clampPan(c.z, o.home.z, o.maxPan),
        });
      },
    });
  }, [dyn, showTapInfo]);

  const notes = track?.notes;
  const ordered = useMemo(() => orderNotes(notes ?? []), [notes]);
  const markers = useMemo(
    () => ordered.map((n, i) => ({ distanceM: n.distanceM, label: String(i + 1) })),
    [ordered],
  );
  const noteById = (id: string) => ordered.find((n) => n.id === id);

  const fileUri = track?.fileUri;
  const bbox = track?.stats.bbox;

  // Load the trail points up front so the 2D view (and the profile/notes section
  // below) work even when the GL context — which also loads them — is not mounted.
  useEffect(() => {
    if (!fileUri) return;
    let cancelled = false;
    (async () => {
      try {
        const gpx = await storage.readFileText(fileUri);
        const pts = parseGpx(gpx).points;
        if (!cancelled) setPoints(pts);
      } catch {
        /* the 3D path surfaces load errors via status; 2D simply shows no line */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileUri]);

  // Note→coordinate resolution for the 3D badges, kept in a ref because the
  // render loop (a long-lived closure) is what projects them each tick.
  useEffect(() => {
    numberedNotesRef.current = numberNotesOnTrack(points ?? [], notes ?? []);
  }, [points, notes]);
  // Stale positions from a torn-down scene are hidden by the render gate below
  // (badges draw only while 3D is up and ready); the loop overwrites them
  // within one throttle tick when 3D resumes.

  // Sample the terrain (DEM) under each point so the profile reads the same
  // surface the 3D view drapes the trail on. Reuses the heightmap the GL context
  // loads when available; in 2D mode it fetches it here.
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
  // the elevation chart and ↑/↓ totals match the 3D drape and the displayed view.
  const profilePoints = demPoints ?? points ?? [];
  const profileStats = useMemo(
    () => (demPoints ? computeTrackStats(demPoints) : null),
    [demPoints],
  );

  const onContextCreate = async (gl: ExpoWebGLRenderingContext) => {
    const gen = ++glGenRef.current;
    try {
      const gpx = fileUri ? await storage.readFileText(fileUri) : '';
      const pts = gpx ? parseGpx(gpx).points : [];
      if (gen !== glGenRef.current) return; // superseded while loading
      setPoints(pts);
      if (!bbox) {
        setStatus('error');
        return;
      }
      // Pad the trail's box so the terrain extends past the trace and fills the
      // viewport, instead of rendering as a tight floating slab.
      const hm = await fetchHeightmap(padBbox(bbox));
      if (gen !== glGenRef.current) return;
      hmRef.current = hm;
      ptsRef.current = pts;

      // Renderer first, so the drape texture can use the GL context's max
      // anisotropy and stay sharp at grazing angles.
      const { renderer, maxAnisotropy } = createTerrainRenderer(gl);
      maxAnisoRef.current = maxAnisotropy;
      rendererRef.current = renderer;
      // fwidth() needs derivatives (contour anti-aliasing); skip the overlay
      // shader entirely on the rare device without them.
      injectOkRef.current = supportsStandardDerivatives(gl, renderer.capabilities.isWebGL2);
      if (!injectOkRef.current) setOverlaysAvailable(false);

      let build = await buildGroupFor(
        hm,
        pts,
        basemapRef.current,
        maxAnisoRef.current,
        injectOkRef.current,
      );
      if (gen !== glGenRef.current) {
        disposeGroup(build.group);
        return;
      }

      const scene = new THREE.Scene();
      sceneRef.current = scene;
      // Warm key light + soft hemisphere fill (matches the live 3D map), plus
      // the gradient sky dome and horizon fog so the slab edge never shows.
      addTerrainLights(scene);
      addSkyAndFog(scene, build.radius, 1.2, 3.8);
      scene.add(build.group);

      const camera = createTerrainCamera(gl);
      cameraRef.current = camera;
      orbit.current.center = build.center.clone();
      orbit.current.home = build.center.clone();
      orbit.current.maxPan = Math.max(build.trailRadius * 1.8, 0.5);
      // Frame the trail (not the whole padded slab) so the surrounding terrain
      // fills the screen with the trace prominent in the middle.
      orbit.current.radius = clamp(build.trailRadius * 2.6, 0.8, 9);
      positionCameraFromOrbit(camera, orbit.current);

      // Device-only blind spot: shader compile failures don't throw in three —
      // render one guarded frame and fall back to the un-injected material if
      // the overlay shader can't run on this GPU.
      if (build.overlay && overlayRenderFailed(renderer, scene, camera)) {
        reportError(new Error('terrain overlay shader failed — using fallback'), 'trail3d-overlay');
        injectOkRef.current = false;
        setOverlaysAvailable(false);
        scene.remove(build.group);
        disposeGroup(build.group);
        build = await buildGroupFor(hm, pts, basemapRef.current, maxAnisoRef.current, false);
        if (gen !== glGenRef.current) {
          disposeGroup(build.group);
          return;
        }
        scene.add(build.group);
      }
      groupRef.current = build.group;
      projectRef.current = build.project;
      heightAtRef.current = build.heightAt;
      queryAtRef.current = build.queryAt;
      overlayRef.current = build.overlay;
      if (build.overlay) applyTerrainOverlaySettings(build.overlay, currentOverlaySettings());

      // A small pin above the surface so the highlighted point is visible
      // without dwarfing the draped trail line.
      const marker = buildMarkerPin({
        headRadius: 0.013,
        headColor: 0xffd166,
        headEmissive: 0x7a5200,
        height: 0.055,
      });
      marker.visible = false;
      scene.add(marker);
      // Tap-to-query crosshair (hidden until a tap, faded out in onFrame).
      const queryMarker = buildQueryMarker();
      queryMarkerRef.current = queryMarker;
      scene.add(queryMarker.group);
      setStatus('ready');

      runRenderLoop({
        isCurrent: () => gen === glGenRef.current,
        gl,
        scene,
        camera,
        renderer,
        onFrame: () => {
          const o = orbit.current;
          const dt = dyn.frameDt(performance.now());
          // Release inertia: keep orbiting after the finger lifts, decaying.
          const m = dyn.stepMomentum(dt);
          if (m) {
            o.theta -= m.dx * ORBIT_THETA_PER_PX;
            o.phi = clamp(o.phi - m.dy * ORBIT_PHI_PER_PX, 0.12, 1.45);
          }
          // Double-tap fly-to easing.
          dyn.stepFly(o, dt);
          // heightAt clamps the eye above the surface (camera-terrain collision).
          positionCameraFromOrbit(camera, o, heightAtRef.current ?? undefined);
          // Fade the tap-to-query crosshair in step with the chip (aged by
          // accumulated frame time — no wall clock in render-scoped code).
          if (queryElapsedMsRef.current !== null) {
            queryElapsedMsRef.current += dt * 1000;
            const op = queryMarkerOpacity(queryElapsedMsRef.current);
            queryMarker.setOpacity(op);
            if (op <= 0) queryElapsedMsRef.current = null;
          }
          const sc = scrubRef.current;
          if (sc && projectRef.current) {
            marker.position.copy(projectRef.current(sc.longitude, sc.latitude));
            // Shrink the marker as the camera closes in so it never balloons.
            marker.scale.setScalar(
              markerScaleForDistance(camera.position.distanceTo(marker.position)),
            );
            marker.visible = true;
          } else {
            marker.visible = false;
          }
          // Numbered note badges: project trail-note anchors to screen space at
          // ~8 Hz and commit only real movement (idle camera → no re-renders).
          noteAccumRef.current += dt;
          if (noteAccumRef.current >= 0.12) {
            noteAccumRef.current = 0;
            const pr = projectRef.current;
            const { w, h } = viewSizeRef.current;
            const list = numberedNotesRef.current;
            const next: { id: string; num: number; x: number; y: number }[] = [];
            if (pr && w > 0 && list.length > 0) {
              camera.updateMatrixWorld();
              for (const n of list) {
                const v = pr(n.longitude, n.latitude);
                v.project(camera);
                // Drop points behind the camera or well outside the frustum.
                if (v.z < 1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05) {
                  next.push({
                    id: n.note.id,
                    num: n.num,
                    x: ((v.x + 1) / 2) * w,
                    y: ((1 - v.y) / 2) * h,
                  });
                }
              }
            }
            const prev = noteBadgesRef.current;
            let changed = next.length !== prev.length;
            for (let i = 0; !changed && i < next.length; i++) {
              const a = next[i]!;
              const b = prev[i]!;
              changed = a.id !== b.id || Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5;
            }
            if (changed) {
              noteBadgesRef.current = next;
              setNoteBadges(next);
            }
          }
        },
        onDisposed: () => {
          if (sceneRef.current === scene) {
            sceneRef.current = null;
            groupRef.current = null;
            overlayRef.current = null;
            rendererRef.current = null;
            cameraRef.current = null;
            queryMarkerRef.current = null;
          }
        },
      });
    } catch (e) {
      if (gen !== glGenRef.current) return; // superseded — don't set state after unmount
      reportError(e, 'trail3d-terrain');
      setErrMsg(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  };

  const onScrub = (at: TrackPointAt | null) => {
    // Keep the last scrubbed point selected when the finger lifts (the profile
    // reports null on release). Otherwise the selection clears instantly and the
    // "Add note" button — gated on a selected point — can never be tapped.
    if (!at) return;
    scrubRef.current = at;
    setScrub(at);
  };

  const applyBasemap = async (bm: MapBasemap) => {
    if (bm === basemap || switching) return;
    setBasemap(bm);
    basemapRef.current = bm;
    const scene = sceneRef.current;
    const hm = hmRef.current;
    // No live 3D scene (2D mode, or 3D not built yet): the 2D map restyles from
    // state and the next 3D build reads basemapRef — nothing to rebuild now.
    if (!scene || !hm) return;
    setSwitching(true);
    try {
      let built = await buildGroupFor(
        hm,
        ptsRef.current,
        bm,
        maxAnisoRef.current,
        injectOkRef.current,
      );
      if (groupRef.current) {
        scene.remove(groupRef.current);
        disposeGroup(groupRef.current);
      }
      scene.add(built.group);
      // The map- and relief-variants compile different overlay programs, so a
      // basemap switch can hit a fresh device-only shader failure: validate the
      // new variant too and fall back to the plain material if it can't run.
      const renderer = rendererRef.current;
      const camera = cameraRef.current;
      if (built.overlay && renderer && camera && overlayRenderFailed(renderer, scene, camera)) {
        reportError(new Error('terrain overlay shader failed — using fallback'), 'trail3d-overlay');
        injectOkRef.current = false;
        setOverlaysAvailable(false);
        scene.remove(built.group);
        disposeGroup(built.group);
        built = await buildGroupFor(hm, ptsRef.current, bm, maxAnisoRef.current, false);
        scene.add(built.group);
      }
      groupRef.current = built.group;
      projectRef.current = built.project;
      heightAtRef.current = built.heightAt;
      queryAtRef.current = built.queryAt;
      overlayRef.current = built.overlay;
      if (built.overlay) applyTerrainOverlaySettings(built.overlay, currentOverlaySettings());
    } catch {
      showSnack('Could not load that basemap');
    }
    setSwitching(false);
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

  const commit = async () => {
    const text = draft.trim();
    if (!editing || !text) {
      setEditing(null);
      return;
    }
    try {
      if (editing.mode === 'add') {
        const photo = draftPhoto
          ? await storage.importPhoto(draftPhoto, storage.newId())
          : undefined;
        addTrackNote(trackId, editing.distanceM, text, photo);
      } else {
        const existing = noteById(editing.noteId)?.photoUri;
        let photo: string | null | undefined;
        if (draftPhoto === existing) photo = undefined;
        else if (!draftPhoto) photo = null;
        else photo = await storage.importPhoto(draftPhoto, storage.newId());
        updateTrackNote(trackId, editing.noteId, text, photo);
      }
    } catch {
      showSnack('Could not save the photo');
    }
    setEditing(null);
    setDraft('');
    setDraftPhoto(null);
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
          style={[styles.glBox, { paddingTop: insets.top }]}
          onTouchStart={() => setMapGesturing(true)}
          onTouchEnd={(e) => {
            if (e.nativeEvent.touches.length === 0) setMapGesturing(false);
          }}
          onTouchCancel={(e) => {
            if (e.nativeEvent.touches.length === 0) setMapGesturing(false);
          }}
        >
          {trailViewMode === '3d' ? (
            <GLView
              style={styles.fill}
              onContextCreate={onContextCreate}
              onLayout={(e) => {
                const { width, height } = e.nativeEvent.layout;
                viewSizeRef.current = { w: width, h: height };
              }}
              {...pan.panHandlers}
            />
          ) : points && points.length > 0 ? (
            // Mount the 2D map only once points are loaded — a MapLibre GeoJSON
            // source created with empty data doesn't reliably pick up a later
            // update, which is why the trace previously appeared only after a
            // 2D/3D toggle forced a remount.
            <Trail2DView
              points={points}
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
          {/* Numbered note circles over the 3D terrain — the same badges the 2D
              map pins on the trace, projected to screen space each render tick.
              Tapping one opens the note viewer; the badges sit above the GL
              pan-responder surface, so their touches win over camera gestures.
              Offset by half the 24dp badge so the circle centres on the
              anchor. */}
          {trailViewMode === '3d' &&
            status === 'ready' &&
            noteBadges.map((b) => (
              <Pressable
                key={b.id}
                onPress={() => setViewingNoteId(b.id)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Note ${b.num}`}
                style={[styles.noteBadge3d, { left: b.x - 12, top: b.y - 12 }]}
              >
                <NoteNumberBadge num={b.num} />
              </Pressable>
            ))}
          {trailViewMode === '3d' && status === 'loading' && (
            <View style={styles.center} pointerEvents="none">
              <ActivityIndicator size="large" />
              <Text style={styles.loadingText}>Building 3D terrain…</Text>
            </View>
          )}
          {trailViewMode === '3d' && status === 'error' && (
            <View style={styles.center} pointerEvents="none">
              <Text>Couldn&apos;t load 3D terrain.</Text>
              {errMsg ? (
                <Text variant="bodySmall" style={[styles.errDetail, hintColor]}>
                  {errMsg}
                </Text>
              ) : null}
            </View>
          )}
          <Appbar.BackAction
            onPress={() => router.back()}
            style={[styles.back, { top: insets.top + 2 }]}
          />
          <Surface
            style={[styles.summary, { top: insets.top + 2 }]}
            elevation={3}
            onLayout={(e) => setSummaryH(e.nativeEvent.layout.height)}
          >
            <Text variant="titleSmall" numberOfLines={1}>
              {track.name}
            </Text>
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
            onSelectBasemap={applyBasemap}
            basemapDisabled={switching || (trailViewMode === '3d' && status === 'loading')}
            overlaysAvailable={overlaysAvailable}
            overlaysDisabled={switching}
          />
          {switching && <ActivityIndicator size={18} style={styles.switchSpin} />}
          {trailViewMode === '3d' && <TapQueryChip info={tapInfo} style={styles.queryChip} />}
        </View>

        {points && (
          <>
            <View style={styles.scrubRow}>
              {scrub ? (
                <Text variant="bodySmall">
                  {formatDistance(scrub.distanceM)}
                  {scrub.elevation !== undefined ? ` · ${formatElevation(scrub.elevation)}` : ''}
                  {scrub.speed !== undefined ? ` · ${formatSpeed(scrub.speed)}` : ''}
                </Text>
              ) : (
                <Text variant="bodySmall" style={hintColor}>
                  Drag the profile to move the marker on the{' '}
                  {trailViewMode === '3d' ? 'terrain' : 'map'}.
                </Text>
              )}
            </View>
            <ElevationProfile
              points={profilePoints}
              ascentM={s.ascentM}
              descentM={s.descentM}
              markers={markers}
              selectedDistanceM={scrub?.distanceM ?? null}
              onScrub={onScrub}
            />

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
        <Dialog visible={editing !== null} onDismiss={() => setEditing(null)}>
          <Dialog.Title>{editing?.mode === 'edit' ? 'Edit note' : 'New note'}</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Note"
              value={draft}
              onChangeText={setDraft}
              autoFocus
              multiline
              mode="outlined"
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
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setEditing(null)}>Cancel</Button>
            <Button onPress={commit} disabled={!draft.trim()}>
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

        {/* Viewer for a note badge tapped on the trail (2D pin / 3D circle). */}
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
  // Matches SKY_COLOR (the sky dome's horizon stop) so the box never flashes a
  // mismatched blue while the GL context loads.
  glBox: { height: 420, backgroundColor: '#dfe9f2' },
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
  loadingText: { opacity: 0.8 },
  errDetail: { paddingHorizontal: 24, textAlign: 'center' },
  back: { position: 'absolute', left: 4, margin: 0 },
  summary: {
    position: 'absolute',
    left: 60,
    right: 12,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 4,
  },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  // Small basemap-rebuild spinner, bottom-centred where the old pills sat.
  switchSpin: { position: 'absolute', bottom: 14, alignSelf: 'center', pointerEvents: 'none' },
  // Centred near the bottom of the viewport — clear of the rail on the right.
  queryChip: { position: 'absolute', left: 0, right: 0, bottom: 40 },
  noteBadge3d: { position: 'absolute' },
  scrubRow: { paddingHorizontal: 16, paddingTop: 10 },
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

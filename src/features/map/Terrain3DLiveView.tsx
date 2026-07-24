import { padBbox } from '@core/geo/terrain';
import type { BoundingBox, LatLng, LngLat, TrackPoint } from '@core/models';
import { reportError } from '@lib/errorReporting';
import type { MapBasemap } from '@state/mapStore';
import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, IconButton, Text, useTheme } from 'react-native-paper';
import * as THREE from 'three';
import { fetchHeightmap } from './dem';
import { rayGroundHit, zoomTowardPoint } from '@core/geo/terrainRay';
import { createCameraDynamics, type FlyTargets } from './terrain3d/cameraDynamics';
import { disposeGroup, runRenderLoop, useGlGeneration } from './terrain3d/glLifecycle';
import {
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
import {
  applyTerrainOverlaySettings,
  overlayRenderFailed,
  supportsStandardDerivatives,
  type TerrainOverlayHandle,
} from './terrain3d/terrainMaterial';
import {
  buildTerrain,
  markerScaleForDistance,
  type GroundPoint,
  type HeightSampler,
  type TerrainBuild,
} from './terrainScene';

interface Props {
  /** Live device location; the surface is built around it and a marker tracks it. */
  center: LatLng | null;
  /** Active base layer (drapes OSM/satellite tiles, or hypsometric relief). */
  basemap: MapBasemap;
  /** Whether foreground location permission was granted. */
  permission: 'undetermined' | 'granted' | 'denied';
  /** Active saved-trail polylines to drape on the terrain (lng/lat). */
  trails: readonly (readonly LngLat[])[];
  /** Live recording trace points (empty when not recording). */
  recordPoints: readonly TrackPoint[];
  /** Live dropped waypoints to pin on the terrain. */
  waypoints: readonly { latitude: number; longitude: number }[];
}

// Full span (metres) of the terrain box built around the anchor (passed as the
// min-span to padBbox) — ~4 km of context, i.e. ~2 km in each direction.
const BOX_M = 4000;
// Re-anchor (rebuild around the new position) once the user drifts this far from
// the current box centre, so terrain always extends well ahead of them.
const REANCHOR_M = 700;

const pointBox = (c: LatLng): BoundingBox => ({
  minLat: c.latitude,
  maxLat: c.latitude,
  minLng: c.longitude,
  maxLng: c.longitude,
});

/** Rough planar metres between two coords — fine for the re-anchor threshold. */
function metresBetween(a: LatLng, b: LatLng): number {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((((a.latitude + b.latitude) / 2) * Math.PI) / 180);
  return Math.hypot(
    (a.latitude - b.latitude) * mPerDegLat,
    (a.longitude - b.longitude) * mPerDegLng,
  );
}

interface Built extends TerrainBuild {
  bbox: BoundingBox;
}

/** Fetch the DEM + basemap for a box around `anchor` and build a terrain group. */
async function fetchAndBuild(
  anchor: LatLng,
  basemap: MapBasemap,
  maxAnisotropy: number,
  injectOverlays: boolean,
): Promise<Built> {
  const hm = await fetchHeightmap(padBbox(pointBox(anchor), 0, BOX_M));
  const texture = await fetchDrapeTexture(hm.range, basemap);
  return { ...buildTerrain(hm, [], texture, maxAnisotropy, { injectOverlays }), bbox: hm.bbox };
}

type Project = (lng: number, lat: number) => THREE.Vector3;
type DrapeLine = TerrainBuild['drapeLine'];
const inBox = (b: BoundingBox, lng: number, lat: number) =>
  lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;

/**
 * Add a polyline (a trail or recording trace) as a flat line draped on the
 * terrain surface — it reads like a 2D route painted on the map, not a 3D tube
 * floating above it. Split at the box edges so points outside the loaded
 * terrain don't snap to the border.
 */
function addPolyline(
  group: THREE.Group,
  coords: readonly LngLat[],
  project: Project,
  drapeLine: DrapeLine,
  bbox: BoundingBox,
  color: number,
  halfWidth: number,
): void {
  let run: GroundPoint[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const line = drapeLine(run, { color, halfWidth });
      if (line) group.add(line);
    }
    run = [];
  };
  for (const [lng, lat] of coords) {
    if (inBox(bbox, lng, lat)) {
      const v = project(lng, lat);
      run.push({ x: v.x, z: v.z });
    } else flush();
  }
  flush();
}

/**
 * A clean map-pin marker: a charcoal teardrop (round head + tapered point that
 * touches the surface) with a white dot on the face — reads clearly as a pin from
 * any orbit angle, instead of a sphere floating on a stick.
 */
function waypointPin(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({
    color: 0x2d3740,
    emissive: 0x0a0f14,
    roughness: 0.5,
  });
  // Tapered point (cone tip down) from the surface up to the head.
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.1, 18), body);
  cone.rotation.x = Math.PI; // tip points down
  cone.position.y = 0.065; // tip ~0.015 above surface, base ~0.115
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.034, 18, 18), body);
  head.position.y = 0.13;
  // White face dot for the classic pin look.
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.013, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  dot.position.set(0, 0.13, 0.027);
  g.add(cone, head, dot);
  return g;
}

const TRAIL_COLOR = 0xe0312b; // saved trails — fine red drape line
const REC_COLOR = 0xd76b27; // live recording trace — warm orange

/**
 * Real 3D on the main map. Builds an extruded terrain mesh (expo-gl + Three.js)
 * for a box around the device's location, draped with the active basemap (or
 * hypsometric relief), with a live "you are here" marker and orbit/pinch
 * gestures. In follow mode the camera tracks the user (M2) and the terrain box
 * re-anchors around them as they move (M3) — fetching only new tiles, since the
 * tile cache serves the overlap. Tap the locate button to toggle follow.
 */
export function Terrain3DLiveView({
  center,
  basemap,
  permission,
  trails,
  recordPoints,
  waypoints,
}: Props) {
  const theme = useTheme();
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [follow, setFollow] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [recenter, setRecenter] = useState(0);
  // False once the overlay shader is unavailable (no derivatives / compile
  // failure) so the Slope/Contours/Tint toggles hide instead of doing nothing.
  // Shader-overlay availability still tracked (drives nothing visible since
  // the 3D button bar moved into the shared Overlays menu, but the menu's
  // toggles silently no-op when injection failed — worth keeping the signal).
  const [, setOverlaysAvailable] = useState(true);

  // Latest props read by the render loop / async re-anchor, never during render.
  const locRef = useRef<LatLng | null>(center);
  const followRef = useRef(follow);
  const basemapRef = useRef(basemap);
  useEffect(() => {
    locRef.current = center;
  }, [center]);
  useEffect(() => {
    followRef.current = follow;
  }, [follow]);
  useEffect(() => {
    basemapRef.current = basemap;
  }, [basemap]);

  const orbit = useRef({ theta: 0.6, phi: 1.05, radius: 4, center: new THREE.Vector3() });
  // P2 interaction polish: inertia + fly-to springs, view size for tap/pinch
  // picking, terrain samplers for zoom-anchoring, collision and tap-to-query.
  const dyn = useMemo(() => createCameraDynamics(), []);
  const viewSizeRef = useRef({ w: 0, h: 0 });
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const heightAtRef = useRef<HeightSampler | null>(null);
  const queryAtRef = useRef<TerrainBuild['queryAt'] | null>(null);
  const queryMarkerRef = useRef<ReturnType<typeof buildQueryMarker> | null>(null);
  const queryElapsedMsRef = useRef<number | null>(null);
  const { info: tapInfo, show: showTapInfo } = useTapQuery();
  const projectRef = useRef<((lng: number, lat: number) => THREE.Vector3) | null>(null);
  const drapeLineRef = useRef<DrapeLine | null>(null);
  const unprojectRef = useRef<((x: number, z: number) => { lng: number; lat: number }) | null>(
    null,
  );
  const bboxRef = useRef<BoundingBox | null>(null);
  const anchorRef = useRef<LatLng | null>(null);
  // Max anisotropy the GL context supports, read once the renderer exists; passed
  // into every terrain build so the drape texture stays sharp at grazing angles.
  const maxAnisoRef = useRef(1);
  // Analytical-overlay shader state (see terrain3d/terrainMaterial.ts).
  const injectOkRef = useRef(true);
  const overlayRef = useRef<TerrainOverlayHandle | null>(null);
  useTerrainOverlaySync(overlayRef);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const reanchoringRef = useRef(false);
  // GL generation: the GLView remounts on every basemap change / recenter (see
  // its `key`); the render loop must not outlive its context (see useGlGeneration).
  const glGenRef = useGlGeneration();
  const overlaysRef = useRef<THREE.Group | null>(null);
  const trailsRef = useRef(trails);
  const recordPointsRef = useRef(recordPoints);
  const waypointsRef = useRef(waypoints);

  // Rebuild the draped overlays (saved trails, live trace, waypoint pins) against
  // the current projection. Called on first build, on re-anchor (the projection
  // changes), and whenever the overlay data changes. Reads refs, so it stays
  // current without being recreated.
  const rebuildOverlays = () => {
    const scene = sceneRef.current;
    const project = projectRef.current;
    const drapeLine = drapeLineRef.current;
    const bbox = bboxRef.current;
    if (!scene || !project || !drapeLine || !bbox) return;
    const old = overlaysRef.current;
    if (old) {
      scene.remove(old);
      disposeGroup(old);
    }
    const g = new THREE.Group();
    for (const coords of trailsRef.current)
      addPolyline(g, coords, project, drapeLine, bbox, TRAIL_COLOR, 0.0042);
    const rec = recordPointsRef.current;
    if (rec.length >= 2) {
      addPolyline(
        g,
        rec.map((p) => [p.longitude, p.latitude] as LngLat),
        project,
        drapeLine,
        bbox,
        REC_COLOR,
        0.01,
      );
    }
    for (const w of waypointsRef.current) {
      if (!inBox(bbox, w.longitude, w.latitude)) continue;
      const pin = waypointPin();
      pin.position.copy(project(w.longitude, w.latitude));
      g.add(pin);
    }
    scene.add(g);
    overlaysRef.current = g;
  };

  // Rebuild the terrain around a new anchor (lat/lng) and swap it in without a GL
  // remount — used both by follow-mode GPS drift (M3) and by free-look panning
  // toward the box edge. Only the newly-needed tiles are fetched (the cache serves
  // the overlap). Re-maps the look-at point into the fresh, re-normalised frame so
  // the view stays continuous. Reads refs, so it stays current without recreation.
  const rebuildAround = (target: LatLng) => {
    const scene = sceneRef.current;
    if (!scene || reanchoringRef.current) return;
    reanchoringRef.current = true;
    setStreaming(true);
    // Capture the projection in effect now: the fetch is async and the user may
    // keep panning during it, so afterwards we re-map wherever the camera is
    // CURRENTLY looking into the new frame — not the stale `target` from when the
    // threshold was crossed (that would snap the camera back, undoing the pan).
    const prevUnproject = unprojectRef.current;
    (async () => {
      try {
        const built = await fetchAndBuild(
          target,
          basemapRef.current,
          maxAnisoRef.current,
          injectOkRef.current,
        );
        const old = groupRef.current;
        scene.add(built.group);
        if (old) {
          scene.remove(old);
          disposeGroup(old);
        }
        groupRef.current = built.group;
        projectRef.current = built.project;
        drapeLineRef.current = built.drapeLine;
        unprojectRef.current = built.unproject;
        heightAtRef.current = built.heightAt;
        queryAtRef.current = built.queryAt;
        bboxRef.current = built.bbox;
        anchorRef.current = target;
        // Same basemap variant → same (already validated) overlay program; just
        // re-point the uniforms handle at the fresh material.
        overlayRef.current = built.overlay;
        if (built.overlay) applyTerrainOverlaySettings(built.overlay, currentOverlaySettings());
        // Keep the camera on the ground point it's looking at right now, mapped
        // into the freshly re-normalised frame — so a pan in flight isn't undone.
        const look = prevUnproject
          ? prevUnproject(orbit.current.center.x, orbit.current.center.z)
          : { lng: target.longitude, lat: target.latitude };
        orbit.current.center.copy(built.project(look.lng, look.lat));
        rebuildOverlays(); // re-drape against the new projection
      } catch {
        /* keep the existing terrain on failure */
      } finally {
        reanchoringRef.current = false;
        setStreaming(false);
      }
    })();
  };

  // Keep the data refs fresh and re-drape whenever overlays change.
  useEffect(() => {
    trailsRef.current = trails;
    recordPointsRef.current = recordPoints;
    waypointsRef.current = waypoints;
    rebuildOverlays(); // reads refs; a no-op until the scene exists
  }, [trails, recordPoints, waypoints]);

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
    // Refs are read on touch events only, never during render.
    // eslint-disable-next-line react-hooks/refs
    return createTerrainPanResponder({
      orbit,
      // Two fingers, the map-app standard: pinch to zoom (shared), *twist* to
      // rotate the bearing, drag up/down to tilt. (Twist = the angle between
      // the two fingers — far more intuitive than the old horizontal-centroid
      // rotate.)
      onTwoFinger: (curr, prev) => {
        const o = orbit.current;
        let dAng = curr.ang - prev.ang;
        if (dAng > Math.PI) dAng -= 2 * Math.PI;
        else if (dAng < -Math.PI) dAng += 2 * Math.PI;
        o.theta -= dAng;
        o.phi = clamp(o.phi - (curr.cy - prev.cy) * 0.005, 0.12, 1.25);
      },
      // One finger: drag to pan the look-at point across the ground, like
      // dragging the 2D map. Translating into world space depends on the
      // current azimuth so "up" is always away from the camera. Panning means
      // free-look, so it drops follow mode (the camera stops chasing the user).
      onSingle: (dxPx, dyPx) => {
        if (followRef.current) {
          followRef.current = false;
          setFollow(false);
        }
        const o = orbit.current;
        const { dx, dz } = groundPanDelta(o.theta, o.radius, dxPx, dyPx);
        o.center.x += dx;
        o.center.z += dz;
      },
      // A new touch always wins over coasting/flying camera motion.
      onGestureStart: () => dyn.interrupt(),
      // Release inertia: pan/twist keep gliding, decayed in onFrame.
      onRelease: (vel) => dyn.launchMomentum(vel),
      // Anchor the pinch-zoom on the ground under the fingers (free-look only —
      // in follow mode the centre stays glued to the user).
      onPinch: (scale, cx, cy) => {
        if (followRef.current) return;
        const hit = groundHitAt(cx, cy);
        if (!hit) return;
        const o = orbit.current;
        const c = zoomTowardPoint({ x: o.center.x, z: o.center.z }, hit, scale);
        o.center.x = c.x;
        o.center.z = c.z;
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
      // Double-tap: fly toward the tapped ground point (spring-eased zoom).
      onDoubleTap: (x, y) => {
        const o = orbit.current;
        const s = 0.55;
        if (followRef.current) {
          // Stay centred on the user; just close in.
          dyn.flyTo(o, { radius: clamp(o.radius * s, 0.7, 9) });
          return;
        }
        const hit = groundHitAt(x, y);
        if (!hit) return;
        const c = zoomTowardPoint({ x: o.center.x, z: o.center.z }, hit, s);
        dyn.flyTo(o, { radius: clamp(o.radius * s, 0.7, 9), centerX: c.x, centerZ: c.z });
      },
    });
  }, [dyn, showTapInfo]);

  const onContextCreate = async (gl: ExpoWebGLRenderingContext) => {
    const gen = ++glGenRef.current;
    const anchor = locRef.current;
    if (!anchor) {
      setStatus('error');
      return;
    }
    setStatus('loading');
    try {
      // Create the renderer first so we can read the GL context's max anisotropy
      // and build the drape texture sharp from the very first frame.
      const { renderer, maxAnisotropy } = createTerrainRenderer(gl);
      maxAnisoRef.current = maxAnisotropy;
      // fwidth() needs derivatives (contour anti-aliasing); skip the overlay
      // shader entirely on the rare device without them.
      injectOkRef.current = supportsStandardDerivatives(gl, renderer.capabilities.isWebGL2);
      if (!injectOkRef.current) setOverlaysAvailable(false);

      let built = await fetchAndBuild(
        anchor,
        basemapRef.current,
        maxAnisoRef.current,
        injectOkRef.current,
      );
      if (gen !== glGenRef.current) {
        disposeGroup(built.group);
        return; // superseded while loading (remount/unmount)
      }
      const radius = built.radius;

      const scene = new THREE.Scene();
      sceneRef.current = scene;
      // Gradient sky dome + horizon-tuned fog: terrain fades into the sky at
      // distance so its edges never read as a floating slab.
      addSkyAndFog(scene, radius, 0.7, 2.0);
      addTerrainLights(scene);
      scene.add(built.group);

      const camera = createTerrainCamera(gl);
      cameraRef.current = camera;

      // Device-only blind spot: shader compile failures don't throw in three —
      // render one guarded frame and fall back to the un-injected material if
      // the overlay shader can't run on this GPU.
      if (built.overlay && overlayRenderFailed(renderer, scene, camera)) {
        reportError(
          new Error('terrain overlay shader failed — using fallback'),
          'terrain3d-live-overlay',
        );
        injectOkRef.current = false;
        setOverlaysAvailable(false);
        scene.remove(built.group);
        disposeGroup(built.group);
        built = await fetchAndBuild(anchor, basemapRef.current, maxAnisoRef.current, false);
        if (gen !== glGenRef.current) {
          disposeGroup(built.group);
          return;
        }
        scene.add(built.group);
      }
      projectRef.current = built.project;
      drapeLineRef.current = built.drapeLine;
      unprojectRef.current = built.unproject;
      heightAtRef.current = built.heightAt;
      queryAtRef.current = built.queryAt;
      bboxRef.current = built.bbox;
      anchorRef.current = anchor;
      groupRef.current = built.group;
      overlayRef.current = built.overlay;
      if (built.overlay) applyTerrainOverlaySettings(built.overlay, currentOverlaySettings());
      const gc = built.center;

      // Live "you are here" marker: a small coloured head on a short pole, set
      // on the surface — sized like the 2D location puck, not a monument.
      const marker = buildMarkerPin({
        headRadius: 0.013,
        headColor: 0x566b33,
        headEmissive: 0x1a240a,
        height: 0.05,
      });
      scene.add(marker);
      // Tap-to-query crosshair (hidden until a tap, faded out in onFrame).
      const queryMarker = buildQueryMarker();
      queryMarkerRef.current = queryMarker;
      scene.add(queryMarker.group);
      rebuildOverlays(); // drape trails / recording / waypoints on the surface

      // Immersed, low oblique camera so terrain fills the frame foreground-to-
      // horizon (OutMap/Gaia look). `radius` here is the slab's full-span metric
      // (~2.3); the terrain only extends ~1 unit from centre, so we must sit well
      // inside that — a small radius — or the mesh reads as a distant floating slab.
      orbit.current.center = gc;
      orbit.current.radius = clamp(radius * 0.6, 0.7, 9);
      orbit.current.phi = 1.05;
      setStatus('ready');

      const target = new THREE.Vector3();
      runRenderLoop({
        isCurrent: () => gen === glGenRef.current,
        gl,
        scene,
        camera,
        renderer,
        onFrame: () => {
          const o = orbit.current;
          const dt = dyn.frameDt(performance.now());
          // Release inertia: the pan/twist keeps gliding after the finger
          // lifts, decaying exponentially (dyn.stepMomentum).
          const mo = dyn.stepMomentum(dt);
          if (mo) {
            const { dx, dz } = groundPanDelta(o.theta, o.radius, mo.dx, mo.dy);
            o.center.x += dx;
            o.center.z += dz;
            o.theta -= mo.dTwist;
          }
          // Recenter / double-tap fly-to easing.
          dyn.stepFly(o, dt);
          // Project the live position onto the (possibly re-anchored) surface.
          const loc = locRef.current;
          const b = bboxRef.current;
          const inside =
            !!loc &&
            !!b &&
            loc.latitude >= b.minLat &&
            loc.latitude <= b.maxLat &&
            loc.longitude >= b.minLng &&
            loc.longitude <= b.maxLng;
          if (inside && projectRef.current && loc) {
            target.copy(projectRef.current(loc.longitude, loc.latitude));
            marker.position.copy(target);
            // Shrink the marker as the camera closes in so it never balloons.
            marker.scale.setScalar(markerScaleForDistance(camera.position.distanceTo(target)));
            marker.visible = true;
            // Follow mode: keep the camera centred on the moving user. While a
            // recenter fly-to is easing in, steer its centre targets at the
            // (possibly moving) user instead of snapping.
            if (followRef.current) {
              if (dyn.isFlying()) {
                dyn.retargetCenter(target.x, target.z);
                o.center.y += (target.y - o.center.y) * Math.min(1, dt * 8);
              } else {
                o.center.copy(target);
              }
            }
          } else {
            marker.visible = false;
          }
          // Fade the tap-to-query crosshair in step with the chip (aged by
          // accumulated frame time — no wall clock in render-scoped code).
          if (queryElapsedMsRef.current !== null) {
            queryElapsedMsRef.current += dt * 1000;
            const op = queryMarkerOpacity(queryElapsedMsRef.current);
            queryMarker.setOpacity(op);
            if (op <= 0) queryElapsedMsRef.current = null;
          }
          // Free-look: when not following, stream fresh terrain around wherever the
          // camera is looking, so panning never slides off the loaded slab into fog.
          if (
            !followRef.current &&
            unprojectRef.current &&
            anchorRef.current &&
            !reanchoringRef.current
          ) {
            const look = unprojectRef.current(o.center.x, o.center.z);
            const at = { latitude: look.lat, longitude: look.lng };
            if (metresBetween(anchorRef.current, at) > REANCHOR_M) rebuildAround(at);
          }
          // heightAt clamps the eye above the surface (camera-terrain collision).
          positionCameraFromOrbit(camera, o, heightAtRef.current ?? undefined);
        },
        onDisposed: () => {
          if (sceneRef.current === scene) {
            sceneRef.current = null;
            groupRef.current = null;
            overlaysRef.current = null;
            overlayRef.current = null;
            cameraRef.current = null;
            queryMarkerRef.current = null;
          }
        },
      });
    } catch (e) {
      if (gen !== glGenRef.current) return; // superseded — don't set state after unmount
      reportError(e, 'terrain3d-live');
      setStatus('error');
    }
  };

  // M3: when following and the user has drifted far from the current box centre,
  // rebuild the terrain around their new position (free-look panning re-anchors
  // the same way from the render loop, around the camera's look-at point).
  useEffect(() => {
    if (!follow || !center) return;
    const anchor = anchorRef.current;
    if (!anchor || reanchoringRef.current) return;
    if (metresBetween(anchor, center) < REANCHOR_M) return;
    rebuildAround(center);
    // rebuildAround reads refs and guards re-entry; deps cover the drift trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center, follow]);

  if (permission === 'denied') {
    return (
      <View style={[styles.fill, styles.centerBox]}>
        <Text style={{ color: theme.colors.onSurfaceVariant }}>
          Location permission is needed to show 3D terrain around you.
        </Text>
      </View>
    );
  }
  if (!center) {
    return (
      <View style={[styles.fill, styles.centerBox]}>
        <ActivityIndicator />
        <Text style={[styles.waitText, { color: theme.colors.onSurfaceVariant }]}>
          Waiting for your location…
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <GLView
        // Remounting fully rebuilds the scene: on basemap change or manual recenter.
        key={`${basemap}:${recenter}`}
        style={styles.fill}
        onContextCreate={onContextCreate}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          viewSizeRef.current = { w: width, h: height };
        }}
        {...pan.panHandlers}
      />
      <TapQueryChip info={tapInfo} style={styles.queryChip} />
      {(status === 'loading' || streaming) && (
        <View style={styles.centerOverlay} pointerEvents="none">
          <ActivityIndicator />
        </View>
      )}
      {status === 'error' && (
        <View style={styles.centerOverlay} pointerEvents="none">
          <Text style={{ color: theme.colors.onSurfaceVariant }}>Couldn’t load 3D terrain.</Text>
        </View>
      )}
      <IconButton
        icon="crosshairs-gps"
        mode="contained"
        size={22}
        iconColor={follow ? theme.colors.onPrimary : theme.colors.onSurface}
        containerColor={follow ? theme.colors.primary : theme.colors.surface}
        onPress={() => {
          // Retry a failed load; otherwise recenter on the user with a clean
          // default orientation and resume follow — always a visible action (pan
          // with one finger to break out of follow and explore freely again).
          // Eased by a critically-damped spring (~600 ms) instead of snapping.
          if (status === 'error') {
            setRecenter((n) => n + 1);
            return;
          }
          const o = orbit.current;
          const targets: FlyTargets = {
            theta: 0.6,
            phi: 1.05,
            radius: clamp(o.radius, 0.6, 1.6),
          };
          const loc = locRef.current;
          const proj = projectRef.current;
          const b = bboxRef.current;
          if (loc && proj && b && inBox(b, loc.longitude, loc.latitude)) {
            const p = proj(loc.longitude, loc.latitude);
            targets.centerX = p.x;
            targets.centerZ = p.z;
          }
          dyn.interrupt();
          dyn.flyTo(o, targets);
          followRef.current = true;
          setFollow(true);
        }}
        style={styles.recenter}
        accessibilityLabel="Recenter on my location"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centerBox: { alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  waitText: { marginTop: 4 },
  centerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recenter: { position: 'absolute', left: 12, bottom: 96 },
  // Above the recenter button / record controls, clear of the top-right rail.
  overlayBar: { position: 'absolute', left: 12, right: 12, bottom: 148, alignItems: 'center' },
  // Above the overlay toggles so the tap-to-query readout never hides them.
  queryChip: { position: 'absolute', left: 12, right: 12, bottom: 200 },
});

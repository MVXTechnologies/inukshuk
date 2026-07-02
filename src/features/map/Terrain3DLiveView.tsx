import { padBbox } from '@core/geo/terrain';
import type { BoundingBox, LatLng, LngLat, TrackPoint } from '@core/models';
import type { MapBasemap } from '@state/mapStore';
import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { Renderer } from 'expo-three';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { ActivityIndicator, IconButton, Text, useTheme } from 'react-native-paper';
import * as THREE from 'three';
import { fetchBasemapTexture, fetchHeightmap } from './dem';
import { buildTerrain, type TerrainBuild } from './terrainScene';

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

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
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
): Promise<Built> {
  const hm = await fetchHeightmap(padBbox(pointBox(anchor), 0, BOX_M));
  let texture;
  if (basemap !== 'relief') {
    try {
      texture = await fetchBasemapTexture(hm.range, basemap);
    } catch {
      texture = undefined; // fall back to hypsometric relief
    }
  }
  return { ...buildTerrain(hm, [], texture, maxAnisotropy), bbox: hm.bbox };
}

function disposeGroup(g: THREE.Group): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.MeshStandardMaterial | undefined;
    if (mat) {
      mat.map?.dispose();
      mat.dispose();
    }
  });
}

type Project = (lng: number, lat: number) => THREE.Vector3;
const inBox = (b: BoundingBox, lng: number, lat: number) =>
  lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;

/**
 * Add a draped polyline (a trail or recording trace) as tube segments, split at
 * the box edges so points outside the loaded terrain don't snap to the border.
 */
function addPolyline(
  group: THREE.Group,
  coords: readonly LngLat[],
  project: Project,
  bbox: BoundingBox,
  color: number,
  radius: number,
): void {
  let run: THREE.Vector3[] = [];
  const flush = () => {
    if (run.length >= 2) {
      // A single coloured route line hugging the surface — shaded with a matching
      // emissive so it stays clearly its colour (red trail / orange recording).
      const curve = new THREE.CatmullRomCurve3(run.map((v) => v.clone().setY(v.y + 0.0035)));
      const tube = new THREE.TubeGeometry(curve, Math.min(900, run.length * 6), radius, 6, false);
      group.add(
        new THREE.Mesh(
          tube,
          new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: 0.5,
            roughness: 0.5,
          }),
        ),
      );
    }
    run = [];
  };
  for (const [lng, lat] of coords) {
    if (inBox(bbox, lng, lat)) run.push(project(lng, lat));
    else flush();
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
  const gest = useRef({ x: 0, y: 0, cy: 0, dist: 0, ang: 0, single: true });
  const projectRef = useRef<((lng: number, lat: number) => THREE.Vector3) | null>(null);
  const unprojectRef = useRef<((x: number, z: number) => { lng: number; lat: number }) | null>(
    null,
  );
  const bboxRef = useRef<BoundingBox | null>(null);
  const anchorRef = useRef<LatLng | null>(null);
  // Max anisotropy the GL context supports, read once the renderer exists; passed
  // into every terrain build so the drape texture stays sharp at grazing angles.
  const maxAnisoRef = useRef(1);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const reanchoringRef = useRef(false);
  // GL "generation": bumped on every new context and on unmount. The render
  // loop re-queues itself only while its generation is current — the GLView
  // remounts on every basemap change / recenter (see its `key`), and without
  // this each remount stacked another permanent 60fps loop and retained scene.
  const glGenRef = useRef(0);
  useEffect(
    () => () => {
      glGenRef.current++;
    },
    [],
  );
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
    const bbox = bboxRef.current;
    if (!scene || !project || !bbox) return;
    const old = overlaysRef.current;
    if (old) {
      scene.remove(old);
      disposeGroup(old);
    }
    const g = new THREE.Group();
    for (const coords of trailsRef.current)
      addPolyline(g, coords, project, bbox, TRAIL_COLOR, 0.0042);
    const rec = recordPointsRef.current;
    if (rec.length >= 2) {
      addPolyline(
        g,
        rec.map((p) => [p.longitude, p.latitude] as LngLat),
        project,
        bbox,
        REC_COLOR,
        0.011,
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
        const built = await fetchAndBuild(target, basemapRef.current, maxAnisoRef.current);
        const old = groupRef.current;
        scene.add(built.group);
        if (old) {
          scene.remove(old);
          disposeGroup(old);
        }
        groupRef.current = built.group;
        projectRef.current = built.project;
        unprojectRef.current = built.unproject;
        bboxRef.current = built.bbox;
        anchorRef.current = target;
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

  const pan = useMemo(
    () =>
      // Refs are read on touch events only, never during render.
      // eslint-disable-next-line react-hooks/refs
      PanResponder.create({
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderGrant: (_e, g) => {
          gest.current = { x: g.x0, y: g.y0, cy: 0, dist: 0, ang: 0, single: true };
        },
        onPanResponderMove: (e, g) => {
          const t = e.nativeEvent.touches;
          const o = orbit.current;
          const gp = gest.current;
          if (t.length >= 2 && t[0] && t[1]) {
            // Two fingers, the map-app standard: pinch to zoom, *twist* to rotate
            // the bearing, drag up/down to tilt. (Twist = the angle between the two
            // fingers — far more intuitive than the old horizontal-centroid rotate.)
            const fx = t[1].pageX - t[0].pageX;
            const fy = t[1].pageY - t[0].pageY;
            const dist = Math.hypot(fx, fy);
            const ang = Math.atan2(fy, fx);
            const cy = (t[0].pageY + t[1].pageY) / 2;
            if (gp.dist > 0) {
              o.radius = clamp(o.radius * (gp.dist / dist), 0.8, 9);
              let dAng = ang - gp.ang;
              if (dAng > Math.PI) dAng -= 2 * Math.PI;
              else if (dAng < -Math.PI) dAng += 2 * Math.PI;
              o.theta -= dAng;
              o.phi = clamp(o.phi - (cy - gp.cy) * 0.005, 0.12, 1.25);
            }
            gp.dist = dist;
            gp.ang = ang;
            gp.cy = cy;
            gp.single = false;
          } else {
            // One finger: drag to pan the look-at point across the ground, like
            // dragging the 2D map. Translating into world space depends on the
            // current azimuth so "up" is always away from the camera. Panning means
            // free-look, so it drops follow mode (the camera stops chasing the user).
            if (gp.single) {
              if (followRef.current) {
                followRef.current = false;
                setFollow(false);
              }
              const s = o.radius * 0.0016;
              const dx = (g.moveX - gp.x) * s;
              const dy = (g.moveY - gp.y) * s;
              o.center.x += -dx * Math.cos(o.theta) + dy * Math.sin(o.theta);
              o.center.z += dx * Math.sin(o.theta) + dy * Math.cos(o.theta);
            }
            gp.x = g.moveX;
            gp.y = g.moveY;
            gp.single = true;
            gp.dist = 0;
          }
        },
      }),
    [],
  );

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
      const renderer = new Renderer({ gl });
      renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);
      maxAnisoRef.current = renderer.capabilities.getMaxAnisotropy();
      const SKY = 0xcfe0ec;
      renderer.setClearColor(SKY, 1);

      const {
        group,
        center: gc,
        radius,
        project,
        unproject,
        bbox,
      } = await fetchAndBuild(anchor, basemapRef.current, maxAnisoRef.current);
      if (gen !== glGenRef.current) {
        disposeGroup(group);
        return; // superseded while loading (remount/unmount)
      }
      projectRef.current = project;
      unprojectRef.current = unproject;
      bboxRef.current = bbox;
      anchorRef.current = anchor;

      const scene = new THREE.Scene();
      sceneRef.current = scene;
      // Fade the terrain into the sky at distance so its edges never read as a
      // floating slab — the mesh appears to extend to a hazy horizon, filling view.
      scene.fog = new THREE.Fog(SKY, radius * 0.7, radius * 2.0);
      // Warm key light from a low azimuth for stronger relief, plus a soft sky/
      // ground hemisphere fill so shadowed slopes keep some colour.
      scene.add(new THREE.HemisphereLight(0xfff4e6, 0x55603f, 0.85));
      const sun = new THREE.DirectionalLight(0xfff2e0, 1.35);
      sun.position.set(2.2, 1.8, 1.0);
      scene.add(sun);
      scene.add(group);
      groupRef.current = group;

      // Live "you are here" marker: a coloured head on a pole, set on the surface.
      const marker = new THREE.Group();
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.03, 16, 16),
        new THREE.MeshStandardMaterial({ color: 0x566b33, emissive: 0x1a240a }),
      );
      head.position.y = 0.13;
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.006, 0.006, 0.13, 8),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x444444 }),
      );
      pole.position.y = 0.065;
      marker.add(head, pole);
      scene.add(marker);
      rebuildOverlays(); // drape trails / recording / waypoints on the surface

      const camera = new THREE.PerspectiveCamera(
        55,
        gl.drawingBufferWidth / gl.drawingBufferHeight,
        0.01,
        100,
      );
      // Immersed, low oblique camera so terrain fills the frame foreground-to-
      // horizon (OutMap/Gaia look). `radius` here is the slab's full-span metric
      // (~2.3); the terrain only extends ~1 unit from centre, so we must sit well
      // inside that — a small radius — or the mesh reads as a distant floating slab.
      orbit.current.center = gc;
      orbit.current.radius = clamp(radius * 0.6, 0.7, 9);
      orbit.current.phi = 1.05;
      setStatus('ready');

      const target = new THREE.Vector3();
      const render = () => {
        if (gen !== glGenRef.current) {
          // Superseded (unmount or GLView remount): stop the loop and free the
          // scene's GPU resources exactly once.
          disposeGroup(scene as unknown as THREE.Group);
          renderer.dispose();
          if (sceneRef.current === scene) {
            sceneRef.current = null;
            groupRef.current = null;
            overlaysRef.current = null;
          }
          return;
        }
        requestAnimationFrame(render);
        const o = orbit.current;
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
          marker.visible = true;
          // Follow mode: keep the camera centred on the moving user.
          if (followRef.current) o.center.copy(target);
        } else {
          marker.visible = false;
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
        const c = o.center;
        camera.position.set(
          c.x + o.radius * Math.sin(o.phi) * Math.sin(o.theta),
          c.y + o.radius * Math.cos(o.phi),
          c.z + o.radius * Math.sin(o.phi) * Math.cos(o.theta),
        );
        camera.lookAt(c);
        renderer.render(scene, camera);
        gl.endFrameEXP();
      };
      render();
    } catch {
      if (gen !== glGenRef.current) return; // superseded — don't set state after unmount
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
        {...pan.panHandlers}
      />
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
          if (status === 'error') {
            setRecenter((n) => n + 1);
            return;
          }
          orbit.current.theta = 0.6;
          orbit.current.phi = 1.05;
          orbit.current.radius = clamp(orbit.current.radius, 0.6, 1.6);
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
});

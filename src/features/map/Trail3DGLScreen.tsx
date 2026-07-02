import { parseGpx } from '@core/geo/gpx';
import {
  computeTrackStats,
  interpolateTrackAtDistance,
  withDemElevations,
  type TrackPointAt,
} from '@core/geo/track';
import { orderNotes } from '@core/library/notes';
import { padBbox } from '@core/geo/terrain';
import type { TrackPoint } from '@core/models';
import * as storage from '@data/storage';
import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { Renderer } from 'expo-three';
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatPace,
  formatSpeed,
} from '@lib/format';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, PanResponder, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Appbar,
  Button,
  Dialog,
  IconButton,
  Portal,
  SegmentedButtons,
  Snackbar,
  Surface,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as THREE from 'three';
import { fetchBasemapTexture, fetchHeightmap, type Basemap, type Heightmap } from './dem';
import { exportTrailPdf } from '../library/exportTrailPdf';
import { buildTerrain, type TerrainBuild } from './terrainScene';
import { ElevationProfile } from '../library/components/ElevationProfile';
import { Trail2DView } from './Trail2DView';
import { useTimedSnackbar } from '../common/useTimedSnackbar';

interface Props {
  trackId: string;
}

type BasemapChoice = Basemap | 'relief';
type Editing = { mode: 'add'; distanceM: number } | { mode: 'edit'; noteId: string };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Build a terrain group for a basemap choice, draping its tiles (or relief). */
async function buildGroupFor(
  hm: Heightmap,
  pts: readonly TrackPoint[],
  bm: BasemapChoice,
  maxAnisotropy = 1,
): Promise<TerrainBuild> {
  let texture;
  if (bm !== 'relief') {
    try {
      texture = await fetchBasemapTexture(hm.range, bm);
    } catch {
      texture = undefined; // fall back to hypsometric relief
    }
  }
  return buildTerrain(hm, pts, texture, maxAnisotropy);
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
  const setSetting = useSettingsStore((s) => s.set);

  const [points, setPoints] = useState<TrackPoint[] | null>(null);
  // Same points but with each altitude replaced by the terrain (DEM) height the
  // 3D view drapes the trail on, so the elevation profile always matches the 3D.
  const [demPoints, setDemPoints] = useState<TrackPoint[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [basemap, setBasemap] = useState<'map' | 'satellite' | 'relief'>('map');
  const [switching, setSwitching] = useState(false);
  const [scrub, setScrub] = useState<TrackPointAt | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState('');
  const [draftPhoto, setDraftPhoto] = useState<string | null>(null);
  const [viewingPhoto, setViewingPhoto] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
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
  const gest = useRef({ x: 0, y: 0, cx: 0, cy: 0, dist: 0, single: true });
  const projectRef = useRef<((lng: number, lat: number) => THREE.Vector3) | null>(null);
  const maxAnisoRef = useRef(1);
  const scrubRef = useRef<TrackPointAt | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const hmRef = useRef<Awaited<ReturnType<typeof fetchHeightmap>> | null>(null);
  const ptsRef = useRef<readonly TrackPoint[]>([]);
  const basemapRef = useRef<'map' | 'satellite' | 'relief'>('map');
  // GL "generation": bumped on every new context and on unmount. The render
  // loop re-queues itself only while its generation is current — without this,
  // every 2D↔3D toggle (which remounts the GLView) stacked another permanent
  // 60fps loop rendering a retained multi-MB scene against a dead GL context.
  const glGenRef = useRef(0);
  useEffect(
    () => () => {
      glGenRef.current++;
    },
    [],
  );

  const pan = useMemo(
    () =>
      // Refs are read on touch events only, never during render.
      // eslint-disable-next-line react-hooks/refs
      PanResponder.create({
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderGrant: (_e, g) => {
          gest.current = { x: g.x0, y: g.y0, cx: 0, cy: 0, dist: 0, single: true };
        },
        onPanResponderMove: (e, g) => {
          const t = e.nativeEvent.touches;
          const o = orbit.current;
          const gp = gest.current;
          if (t.length >= 2 && t[0] && t[1]) {
            const dist = Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
            const cx = (t[0].pageX + t[1].pageX) / 2;
            const cy = (t[0].pageY + t[1].pageY) / 2;
            if (gp.dist > 0) {
              o.radius = clamp(o.radius * (gp.dist / dist), 0.8, 9);
              // Two-finger drag pans the look-at point across the ground (move
              // around the trail a bit), bounded to maxPan from the trail centre.
              const s = o.radius * 0.0016;
              const dx = (cx - gp.cx) * s;
              const dy = (cy - gp.cy) * s;
              const nx = o.center.x - dx * Math.cos(o.theta) + dy * Math.sin(o.theta);
              const nz = o.center.z + dx * Math.sin(o.theta) + dy * Math.cos(o.theta);
              o.center.x = clamp(nx, o.home.x - o.maxPan, o.home.x + o.maxPan);
              o.center.z = clamp(nz, o.home.z - o.maxPan, o.home.z + o.maxPan);
            }
            gp.dist = dist;
            gp.cx = cx;
            gp.cy = cy;
            gp.single = false;
          } else {
            if (gp.single) {
              o.theta -= (g.moveX - gp.x) * 0.008;
              o.phi = clamp(o.phi - (g.moveY - gp.y) * 0.006, 0.12, 1.45);
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
      const renderer = new Renderer({ gl });
      renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);
      renderer.setClearColor(0xcfe0ec, 1);
      maxAnisoRef.current = renderer.capabilities.getMaxAnisotropy();

      const { group, center, trailRadius, project } = await buildGroupFor(
        hm,
        pts,
        basemapRef.current,
        maxAnisoRef.current,
      );
      if (gen !== glGenRef.current) {
        disposeGroup(group);
        return;
      }
      projectRef.current = project;

      const scene = new THREE.Scene();
      sceneRef.current = scene;
      // Warm key light from a low azimuth for stronger relief, plus a soft sky/
      // ground hemisphere fill (matches the live 3D map).
      scene.add(new THREE.HemisphereLight(0xfff4e6, 0x55603f, 0.85));
      const sun = new THREE.DirectionalLight(0xfff2e0, 1.35);
      sun.position.set(2.2, 1.8, 1.0);
      scene.add(sun);
      scene.add(group);
      groupRef.current = group;

      // A pin that stands above the surface so the highlighted point is obvious.
      const marker = new THREE.Group();
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.032, 16, 16),
        new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0x7a5200 }),
      );
      head.position.y = 0.14;
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.006, 0.006, 0.14, 8),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x444444 }),
      );
      pole.position.y = 0.07;
      marker.add(head, pole);
      marker.visible = false;
      scene.add(marker);

      const camera = new THREE.PerspectiveCamera(
        55,
        gl.drawingBufferWidth / gl.drawingBufferHeight,
        0.01,
        100,
      );
      orbit.current.center = center.clone();
      orbit.current.home = center.clone();
      orbit.current.maxPan = Math.max(trailRadius * 1.8, 0.5);
      // Frame the trail (not the whole padded slab) so the surrounding terrain
      // fills the screen with the trace prominent in the middle.
      orbit.current.radius = clamp(trailRadius * 2.6, 0.8, 9);
      setStatus('ready');

      const render = () => {
        if (gen !== glGenRef.current) {
          // Superseded (unmount or GLView remount): stop the loop and free the
          // scene's GPU resources exactly once.
          disposeGroup(scene as unknown as THREE.Group);
          renderer.dispose();
          if (sceneRef.current === scene) {
            sceneRef.current = null;
            groupRef.current = null;
          }
          return;
        }
        requestAnimationFrame(render);
        const { theta, phi, radius: r, center: c } = orbit.current;
        camera.position.set(
          c.x + r * Math.sin(phi) * Math.sin(theta),
          c.y + r * Math.cos(phi),
          c.z + r * Math.sin(phi) * Math.cos(theta),
        );
        camera.lookAt(c);
        const sc = scrubRef.current;
        if (sc && projectRef.current) {
          marker.position.copy(projectRef.current(sc.longitude, sc.latitude));
          marker.visible = true;
        } else {
          marker.visible = false;
        }
        renderer.render(scene, camera);
        gl.endFrameEXP();
      };
      render();
    } catch (e) {
      if (gen !== glGenRef.current) return; // superseded — don't set state after unmount
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

  const applyBasemap = async (bm: BasemapChoice) => {
    const scene = sceneRef.current;
    const hm = hmRef.current;
    if (bm === basemap || !scene || !hm || switching) return;
    setBasemap(bm);
    basemapRef.current = bm;
    setSwitching(true);
    try {
      const built = await buildGroupFor(hm, ptsRef.current, bm, maxAnisoRef.current);
      if (groupRef.current) {
        scene.remove(groupRef.current);
        disposeGroup(groupRef.current);
      }
      scene.add(built.group);
      groupRef.current = built.group;
      projectRef.current = built.project;
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
    } catch {
      showSnack('Could not export PDF');
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
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <View style={[styles.glBox, { paddingTop: insets.top }]}>
          {trailViewMode === '3d' ? (
            <GLView style={styles.fill} onContextCreate={onContextCreate} {...pan.panHandlers} />
          ) : points && points.length > 0 ? (
            // Mount the 2D map only once points are loaded — a MapLibre GeoJSON
            // source created with empty data doesn't reliably pick up a later
            // update, which is why the trace previously appeared only after a
            // 2D/3D toggle forced a remount.
            <Trail2DView points={points} notes={notes} />
          ) : (
            <View style={styles.center} pointerEvents="none">
              <ActivityIndicator size="large" />
            </View>
          )}
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
          <Surface style={[styles.summary, { top: insets.top + 2 }]} elevation={3}>
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

          {trailViewMode === '3d' && status === 'ready' && (
            <View style={styles.basemapBar} pointerEvents="box-none">
              {(['relief', 'map', 'satellite'] as const).map((bm) => (
                <Button
                  key={bm}
                  compact
                  mode={basemap === bm ? 'contained' : 'contained-tonal'}
                  onPress={() => applyBasemap(bm)}
                  disabled={switching}
                  style={styles.basemapBtn}
                  labelStyle={styles.basemapLabel}
                >
                  {bm === 'relief' ? 'Relief' : bm === 'map' ? 'Map' : 'Satellite'}
                </Button>
              ))}
              {switching && <ActivityIndicator size={18} style={styles.basemapSpin} />}
            </View>
          )}
        </View>

        <View style={styles.viewModeBar}>
          <SegmentedButtons
            value={trailViewMode}
            onValueChange={(v) => setSetting('trailViewMode', v as '2d' | '3d')}
            buttons={[
              { value: '2d', label: '2D', icon: 'map-outline' },
              { value: '3d', label: '3D', icon: 'video-3d' },
            ]}
          />
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
                  Drag the profile to move the marker on the terrain.
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
  glBox: { height: 420, backgroundColor: '#cfe0ec' },
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
  basemapBar: {
    position: 'absolute',
    bottom: 10,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
  },
  basemapBtn: { borderRadius: 20 },
  basemapLabel: { marginVertical: 4, marginHorizontal: 10 },
  basemapSpin: { marginLeft: 4 },
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
  viewModeBar: { paddingHorizontal: 16, paddingVertical: 10 },
});

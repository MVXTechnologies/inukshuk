/**
 * The live layers keep ONE order after any style reload (2.5.1 final QA:
 * after a theme switch the followed trail drew over the location dot).
 *
 * MapLibre RN re-inserts every child layer when the style reloads, in an
 * order of its own. This replays that: the real style (`buildOsmStyle`, light
 * and dark), the real components' `beforeId`s, inserted in several orders —
 * the resulting stack is always `LIVE_LAYER_ORDER`.
 */
import {
  LIVE_LAYER_ORDER,
  liveAnchorLayers,
  liveLayerAnchor,
  replayInsertions,
  type LiveLayerId,
} from '@core/map/liveLayerOrder';
import type { TrackPhoto } from '@core/photos/model';
import { useWaypointMoveStore } from '@state/waypointMoveStore';
import { useMapStore } from '@state/mapStore';
import { act, render } from '@testing-library/react-native';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';

import { TrailPhotoLayers } from '../photos/TrailPhotoLayers';
import { PuckLayers } from './components/PuckLayers';
import { HeadingCone } from './components/HeadingCone';
import { buildOsmStyle } from './mapStyle';
import { FollowGuideLine } from './nav/FollowGuideLine';
import { FollowedTrailLine } from './nav/FollowedTrailLine';
import { MoveWaypointLayers } from './waypoints/MoveWaypointLayers';
import { WaypointPinLayers } from './waypoints/WaypointPinLayers';

type Props = Record<string, unknown> & { children?: ReactNode };
const mockLayers: Props[] = [];

jest.mock('@maplibre/maplibre-react-native', () => ({
  GeoJSONSource: (props: Props) => props.children ?? null,
  Images: () => null,
  Layer: (props: Props) => {
    mockLayers.push(props);
    return null;
  },
  useCurrentPosition: () => ({ coords: { accuracy: 12 } }),
}));
type Listener = (h: { headingDeg: number; accuracy: number | null }) => void;
let mockHeading: Listener | null = null;
jest.mock('../photos/photoUri', () => ({ photoFileUri: (p: string) => `file:///doc/${p}` }));
jest.mock('./useCompass', () => ({
  subscribeHeading: (l: Listener) => {
    mockHeading = l;
    return () => undefined;
  },
}));

const HERE = { latitude: 46.81, longitude: -71.21 };
const TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
/** The style before and after a reload: other base, other relief. */
const STYLES = () => [buildOsmStyle(TILE, 'map', true), buildOsmStyle(TILE, 'satellite', false)];

/** Every live layer the renderable components mount, as MapLibre gets them. */
async function mountedLiveLayers(): Promise<{ id: string; beforeId?: string; afterId?: string }[]> {
  mockLayers.length = 0;
  useWaypointMoveStore.setState({
    moving: { id: 'w', label: 'W', from: { latitude: 46.8, longitude: -71.2 } },
  });
  useMapStore.setState({ mapCenter: { latitude: 46.801, longitude: -71.201 } });
  await render(
    <PaperProvider>
      <FollowedTrailLine
        path={[
          [
            [-71.2, 46.8],
            [-71.21, 46.81],
          ],
        ]}
      />
      <FollowGuideLine from={HERE} to={{ latitude: 46.8, longitude: -71.2 }} />
      <PuckLayers weakAccuracyM={30} />
      <HeadingCone location={HERE} />
      <MoveWaypointLayers />
      <WaypointPinLayers
        pins={[{ key: 'saved-a', latitude: 46.8, longitude: -71.2, label: 'A', hasPhoto: true }]}
        selectedKey={null}
        hiddenKey={null}
        glyphs="https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf"
      />
    </PaperProvider>,
  );
  await act(async () => mockHeading?.({ headingDeg: 90, accuracy: 3 }));
  // The last render of each layer id wins (re-renders push again).
  const byId = new Map<string, Props>();
  for (const l of mockLayers) byId.set(l.id as string, l);
  return [...byId.values()].map((l) => ({
    id: l.id as string,
    ...(l.beforeId !== undefined ? { beforeId: l.beforeId as string } : {}),
    ...(l.afterId !== undefined ? { afterId: l.afterId as string } : {}),
  }));
}

/** A deterministic shuffle (re-insert order is MapLibre's own). */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe('LIVE_LAYER_ORDER', () => {
  it('lists each layer once, the puck dot on top and the followed trail at the bottom', () => {
    expect(new Set(LIVE_LAYER_ORDER).size).toBe(LIVE_LAYER_ORDER.length);
    expect(LIVE_LAYER_ORDER[0]).toBe('followed-trail-casing');
    expect(LIVE_LAYER_ORDER[LIVE_LAYER_ORDER.length - 1]).toBe('inukshuk-puck-dot');
  });

  it('draws the pins above the halo, the cone and the pointing line, under the puck dot', () => {
    const at = (id: LiveLayerId) => LIVE_LAYER_ORDER.indexOf(id);
    for (const under of [
      'inukshuk-puck-halo',
      'heading-cone-fill',
      'pointing-line',
      'pointing-line-labels',
      'followed-trail-line',
    ] as const) {
      expect(at(under)).toBeLessThan(at('waypoint-pin'));
    }
    expect(at('waypoint-pin-label')).toBeLessThan(at('inukshuk-puck-ring'));
    expect(at('inukshuk-puck-ring')).toBeLessThan(at('inukshuk-puck-dot'));
  });

  it('puts one anchor per live layer at the very top of every style', () => {
    for (const style of STYLES()) {
      const ids = style.layers.map((l) => l.id);
      const anchors = liveAnchorLayers().map((a) => a.id);
      expect(ids.slice(-anchors.length)).toEqual(anchors);
    }
  });
});

describe('after a style reload (theme switch)', () => {
  it('every mounted live layer names its own anchor, and nothing chains or floats', async () => {
    const layers = await mountedLiveLayers();
    expect(layers.length).toBeGreaterThanOrEqual(12);
    for (const l of layers) {
      expect(LIVE_LAYER_ORDER).toContain(l.id);
      expect(l.beforeId).toBe(liveLayerAnchor(l.id as LiveLayerId));
      expect(l.afterId).toBeUndefined();
    }
  });

  it.each([0, 1, 7, 42, 2025])(
    'comes back in LIVE_LAYER_ORDER whatever the re-insert order (seed %s)',
    async (seed) => {
      const layers = await mountedLiveLayers();
      for (const built of STYLES()) {
        const style = built.layers.map((l) => l.id);
        const after = replayInsertions(style, shuffled(layers, seed));
        const live = after.filter((id) => (LIVE_LAYER_ORDER as readonly string[]).includes(id));
        expect(live).toEqual(LIVE_LAYER_ORDER.filter((id) => layers.some((l) => l.id === id)));
        // The defect: the followed trail under the location dot.
        expect(after.indexOf('followed-trail-line')).toBeLessThan(
          after.indexOf('inukshuk-puck-dot'),
        );
      }
    },
  );

  it('(control) a layer with no anchor lands on top after a reload — the old defect', () => {
    const style = liveAnchorLayers().map((a) => a.id);
    const after = replayInsertions(style, [
      { id: 'inukshuk-puck-dot', beforeId: liveLayerAnchor('inukshuk-puck-dot') },
      { id: 'followed-trail-line' },
    ]);
    expect(after.indexOf('followed-trail-line')).toBeGreaterThan(
      after.indexOf('inukshuk-puck-dot'),
    );
  });
});

/**
 * The components that need a team session or the pointing-line settings to
 * mount are pinned at the source: each of their layers names its own anchor.
 */
describe('team and pointing-line layers', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', '..', '..', p), 'utf8');
  it.each([
    [
      'src/features/team/map/TeamMapLayers.tsx',
      [
        'team-member-halo',
        'team-member-dot',
        'team-member-initials',
        'team-member-label',
        'team-waypoint-dot',
        'team-waypoint-label',
      ],
    ],
    [
      'src/features/team/map/TeamFieldLayers.tsx',
      [
        'team-rally-area',
        'team-rally-edge',
        'team-rally-dot',
        'team-rally-label',
        'team-trl-casing',
        'team-trl-vertex',
        'team-trl-who',
        'team-sos-halo',
        'team-sos-dot',
        'team-sos-label',
      ],
    ],
    [
      'src/features/team/map/TeamMapMarks.tsx',
      [
        'team-mark-cluster',
        'team-mark-pin',
        'team-mark-pin-badge',
        'team-mark-bubble',
        'team-mark-cluster-count',
        'team-mark-pin-initials',
        'team-mark-pin-count',
        'team-mark-bubble-count',
        'team-mark-task',
      ],
    ],
    [
      'src/features/map/components/PointingLine.tsx',
      ['pointing-line-casing', 'pointing-line', 'pointing-line-end', 'pointing-line-labels'],
    ],
  ])('%s anchors every layer to its own live anchor', (file, ids) => {
    const src = read(file);
    for (const id of ids) expect(src).toContain(`beforeId={liveLayerAnchor('${id}')}`);
    expect(src).not.toMatch(/afterId=/);
    expect(src).not.toMatch(/beforeId=\{PUCK_RING_LAYER_ID\}/);
  });
});

/**
 * Trail photos (#587; 2.5.1 QA: standing on a photo spot, its circle hid the
 * location dot). Several instances share a map, each with its own layer ids;
 * every one sits at its KIND's live anchor, under the pins and the puck.
 */
describe('trail photos', () => {
  const photo = (id: string, at: number): TrackPhoto => ({
    id,
    trackId: 't1',
    distanceM: at,
    lngLat: [-71.2 + at / 1000, 46.8],
    placement: 'time',
    takenAt: at,
    file: `photos/t1/${id}.jpg`,
    thumb: `photos/t1/${id}.sq.jpg`,
    sprite: `photos/t1/${id}.map.png`,
    width: 1,
    height: 1,
    bytes: 1,
    createdAt: 0,
    updatedAt: 0,
  });
  const PHOTO_KIND: Record<string, LiveLayerId> = {
    'photos-img': 'trail-photos',
    'photos-count': 'trail-photos-count',
    'photos-sel-ring': 'trail-photos-selected-ring',
    'photos-sel-img': 'trail-photos-selected',
  };
  const kindOf = (id: string): LiveLayerId | undefined =>
    Object.entries(PHOTO_KIND).find(([suffix]) => id.endsWith(`-${suffix}`))?.[1];

  async function mounted(): Promise<{ id: string; beforeId?: string }[]> {
    mockLayers.length = 0;
    const photos = [photo('a', 10), photo('b', 20)];
    await render(
      <PaperProvider>
        <PuckLayers weakAccuracyM={30} />
        <TrailPhotoLayers id="main-t1" photos={photos} selectedId="a" />
        <TrailPhotoLayers id="rec-live" photos={photos} />
        <WaypointPinLayers
          pins={[{ key: 'saved-a', latitude: 46.8, longitude: -71.2, label: 'A', hasPhoto: true }]}
          selectedKey={null}
          hiddenKey={null}
          glyphs="https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf"
        />
      </PaperProvider>,
    );
    const byId = new Map<string, Props>();
    for (const l of mockLayers) byId.set(l.id as string, l);
    return [...byId.values()].map((l) => ({
      id: l.id as string,
      ...(l.beforeId !== undefined ? { beforeId: l.beforeId as string } : {}),
    }));
  }

  it('sit between the move-mode layers and the waypoint pins, under the puck', () => {
    const at = (id: LiveLayerId) => LIVE_LAYER_ORDER.indexOf(id);
    for (const kind of Object.values(PHOTO_KIND)) {
      expect(at(kind)).toBeGreaterThan(at('waypoint-move-from'));
      expect(at(kind)).toBeLessThan(at('waypoint-pin'));
      expect(at(kind)).toBeLessThan(at('inukshuk-puck-ring'));
    }
  });

  it("every instance's layers name their kind's anchor", async () => {
    const photos = (await mounted()).filter((l) => kindOf(l.id) !== undefined);
    // Two instances: thumbnails + counts each, the selected pair on one.
    expect(photos.length).toBeGreaterThanOrEqual(6);
    for (const l of photos) expect(l.beforeId).toBe(liveLayerAnchor(kindOf(l.id) as LiveLayerId));
  });

  it.each([0, 3, 11, 99])(
    'stay under the pins and the puck dot whatever the re-insert order (seed %s)',
    async (seed) => {
      const layers = await mounted();
      for (const built of STYLES()) {
        const after = replayInsertions(
          built.layers.map((l) => l.id),
          shuffled(layers, seed),
        );
        const photoIdx = layers
          .filter((l) => kindOf(l.id) !== undefined)
          .map((l) => after.indexOf(l.id));
        // The defect: a photo circle over the location dot.
        for (const i of photoIdx) {
          expect(i).toBeLessThan(after.indexOf('waypoint-pin'));
          expect(i).toBeLessThan(after.indexOf('inukshuk-puck-ring'));
          expect(i).toBeLessThan(after.indexOf('inukshuk-puck-dot'));
        }
      }
    },
  );
});

/**
 * No map layer mounts without a height: a `<Layer>` with no `beforeId` lands
 * on top of the whole stack after a style reload — over the puck. Every
 * layer names a live anchor (above) or its slot's anchor (`overlayAnchor`,
 * below the live stack). The maps of their own with no live layers at all
 * (Explore's catalogue map, a long trail's route preview) are the exceptions.
 */
describe('every map layer has an anchor', () => {
  const root = join(__dirname, '..', '..');
  const OWN_MAPS_WITHOUT_LIVE_LAYERS = [
    'features/store/explore/ExploreMapScreen.tsx',
    'features/store/trails/TrailRouteMap.tsx',
  ];
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
    });
  const stripComments = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

  it('names a beforeId on every <Layer> (or spreads props that do)', () => {
    const missing: string[] = [];
    for (const file of files(root)) {
      const rel = file.slice(root.length + 1);
      if (OWN_MAPS_WITHOUT_LIVE_LAYERS.includes(rel)) continue;
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/<Layer\b([^>]*?)\/?>/g)) {
        const body = m[1] ?? '';
        if (/\bbeforeId=/.test(body) || /\{\.\.\.shared\}/.test(body)) continue;
        missing.push(`${rel}: ${body.trim().slice(0, 60)}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

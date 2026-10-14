/**
 * The map's one sprite registration (2.5.2 QA: pin icons and a cluster's
 * count pill gone after leaving drawing mode, back on a theme change).
 *
 * The MapLibre mock keeps a fake style with the native `<Images>` rules
 * (`MLRNImages`): an image is added only when the style lacks it, and an
 * `<Images>` that leaves the map removes EVERY name it was given, whoever
 * added it and whoever still draws it. Against that, layers mount and unmount
 * the way the map screen's do, and the names the pins draw must stay put.
 */
import { WAYPOINT_ICONS } from '@core/library/waypointIcons';
import {
  glyphImagesInUse,
  PHOTO_IMAGE,
  PIN_IMAGE,
  type PinInput,
} from '@core/map/waypointPinStyle';
import type { TrackPhoto } from '@core/photos/model';
import { act, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';
import { lightTheme } from '@ui/theme';

import { TrailPhotoLayers } from '../photos/TrailPhotoLayers';
import { DRAW_IMAGES } from '../team/draw/drawImages';
import {
  BASE_MAP_IMAGES,
  MAP_IMAGE_CATALOG,
  MapImages,
  registeredMapImages,
  requestMapImages,
  resetMapImagesForTests,
} from './MapImages';
import { WaypointPinLayers } from './waypoints/WaypointPinLayers';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));
jest.mock('../photos/photoUri', () => ({ photoFileUri: (p: string) => `file:///doc/${p}` }));

type Props = Record<string, unknown> & { children?: ReactNode };
/** The fake native style: image name → the `<Images>` instance that added it. */
const mockStyle = new Map<string, number>();
/** Live `<Images>` instances → every name each was given (what it removes on leaving). */
const mockGiven = new Map<number, Set<string>>();
/** `onImageMissing` of the instances, latest last. */
const mockMissing: ((e: unknown) => void)[] = [];
let mockSeq = 0;

jest.mock('@maplibre/maplibre-react-native', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const { forwardRef } = R;
  function Images(props: Props) {
    const id = R.useState(() => ++mockSeq)[0];
    const given = R.useState(() => new Set<string>())[0];
    R.useEffect(() => {
      mockGiven.set(id, given);
      return () => {
        // MLRNImages.removeFromMap: every name it holds, from the style.
        for (const name of given) mockStyle.delete(name);
        mockGiven.delete(id);
      };
    }, [id, given]);
    R.useEffect(() => {
      for (const name of Object.keys(props.images as object)) {
        given.add(name);
        if (!mockStyle.has(name)) mockStyle.set(name, id);
      }
    }, [props.images, given, id]);
    if (typeof props.onImageMissing === 'function') {
      mockMissing.push(props.onImageMissing as (mockE: unknown) => void);
    }
    return null;
  }
  return {
    GeoJSONSource: forwardRef((props: Props) => props.children ?? null),
    Layer: () => null,
    Images,
  };
});

const pins: PinInput[] = Array.from({ length: 12 }, (_, i) => ({
  key: `saved-${i}`,
  latitude: 46 + i * 1e-3,
  longitude: -71,
  label: `Waypoint ${i + 1}`,
  icon: WAYPOINT_ICONS[i % 4]?.id,
  hasPhoto: i % 3 === 0,
}));
/** What the pin layers draw: bodies, glyphs, photo badges, the small count pills. */
const PIN_NAMES = [
  PIN_IMAGE,
  PHOTO_IMAGE,
  ...glyphImagesInUse(pins),
  ...Array.from({ length: 9 }, (_, i) => `ph-count-${i + 2}`),
];

const photo = (id: string, at: number): TrackPhoto => ({
  id,
  trackId: 't1',
  distanceM: at,
  lngLat: [-71 + at / 1000, 46.8],
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
const PHOTOS = [photo('a', 10), photo('b', 20)];

function MapLike({ photos, pinsOn = true }: { photos: boolean; pinsOn?: boolean }) {
  return (
    <PaperProvider theme={lightTheme}>
      <MapImages />
      {photos && <TrailPhotoLayers id="main-t1" photos={PHOTOS} />}
      <WaypointPinLayers
        pins={pinsOn ? pins : []}
        selectedKey={null}
        hiddenKey={null}
        glyphs={undefined}
      />
    </PaperProvider>
  );
}

const missing = (names: readonly string[]) => names.filter((n) => !mockStyle.has(n));

beforeEach(() => {
  mockStyle.clear();
  mockGiven.clear();
  mockMissing.length = 0;
  resetMapImagesForTests();
});

describe('MapImages (2.5.2 QA)', () => {
  it('puts every sprite the pins draw on the map, from one <Images>', async () => {
    await render(<MapLike photos={false} />);
    expect(missing(PIN_NAMES)).toEqual([]);
    expect(mockGiven.size).toBe(1);
  });

  it('a layer that mounts and unmounts (a trail’s photos, the drawings) never takes the pins’ sprites', async () => {
    const r = await render(<MapLike photos />);
    expect(missing(PIN_NAMES)).toEqual([]);
    await r.rerender(<MapLike photos={false} />);
    expect(missing(PIN_NAMES)).toEqual([]);
    // …and the drawing sprites stay for the next drawing.
    expect(missing(Object.keys(DRAW_IMAGES))).toEqual([]);
  });

  it('no two <Images> on the map ever hold the same name', async () => {
    const r = await render(<MapLike photos />);
    const owners = new Map<string, number>();
    for (const [id, names] of mockGiven) {
      for (const name of names) {
        expect(owners.get(name)).toBeUndefined();
        owners.set(name, id);
      }
    }
    expect(mockGiven.size).toBe(2); // the map's, and the photos' own sprites
    await r.unmount();
  });

  it('pins going away and coming back: the set never shrinks, nothing re-registers', async () => {
    const r = await render(<MapLike photos={false} />);
    const before = registeredMapImages();
    await r.rerender(<MapLike photos={false} pinsOn={false} />);
    expect(registeredMapImages()).toBe(before);
    expect(missing(PIN_NAMES)).toEqual([]);
    await r.rerender(<MapLike photos={false} />);
    expect(registeredMapImages()).toBe(before);
  });

  it('registers a larger count pill on demand, and ignores names that are not its own', async () => {
    await render(<MapLike photos={false} />);
    await act(async () => mockMissing.at(-1)!({ nativeEvent: { image: 'ph-count-40' } }));
    await act(async () => mockMissing.at(-1)!({ nativeEvent: { image: 'main-t1-photos-0' } }));
    expect(mockStyle.has('ph-count-40')).toBe(true);
    expect(registeredMapImages()).not.toContain('main-t1-photos-0');
  });

  it('re-registers the whole set when the native side lost names it was given', async () => {
    await render(<MapLike photos={false} />);
    // A detached native instance: its names gone from the style, its list cleared.
    mockStyle.clear();
    for (const names of mockGiven.values()) names.clear();
    await act(async () => mockMissing.at(-1)!({ nativeEvent: { image: PIN_IMAGE } }));
    expect(missing(PIN_NAMES)).toEqual([]);
    expect(mockGiven.size).toBe(1);
  });

  it('every base and requested name is in the catalogue, SDF where tinted', () => {
    for (const name of BASE_MAP_IMAGES) expect(MAP_IMAGE_CATALOG[name]).toBeDefined();
    expect(MAP_IMAGE_CATALOG[PIN_IMAGE]).toMatchObject({ sdf: true });
    expect(MAP_IMAGE_CATALOG['wpg-default']).toMatchObject({ sdf: true });
    expect(MAP_IMAGE_CATALOG['draw-pill']).toMatchObject({ sdf: true });
    expect(MAP_IMAGE_CATALOG[PHOTO_IMAGE]).not.toHaveProperty('sdf');
    expect(MAP_IMAGE_CATALOG['ph-count-2']).not.toHaveProperty('sdf');
    requestMapImages(['not-a-sprite']);
    expect(registeredMapImages()).not.toContain('not-a-sprite');
  });
});

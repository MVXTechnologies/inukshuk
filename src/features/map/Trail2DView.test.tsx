import { act, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';
import type { TrackPoint } from '@core/models';
import { TILT_RELIEF_EXAGGERATION } from '@core/map/tiltRelief';
import { useSettingsStore } from '@state/settingsStore';
import { Trail2DView } from './Trail2DView';
import { TILT_RELIEF_LAYER_ID } from './mapStyle';

/**
 * #480: the focused trail view is the MapLibre map, tilted with two fingers
 * like the main map, and it deepens the
 * relief as it tilts. MapLibre is stubbed: the stubs record the props the
 * view hands the native components.
 */
type Props = Record<string, unknown> & { children?: ReactNode };
const mockMapProps: { current: Props | null } = { current: null };
const mockLayers: Props[] = [];

jest.mock('@maplibre/maplibre-react-native', () => {
  const { forwardRef } = jest.requireActual<typeof import('react')>('react');
  const passthrough = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    Map: forwardRef((props: Props, _ref) => {
      mockMapProps.current = props;
      return props.children ?? null;
    }),
    Camera: forwardRef(() => null),
    GeoJSONSource: passthrough,
    Marker: passthrough,
    Layer: (props: Props) => {
      mockLayers.push(props);
      return null;
    },
  };
});

const POINTS: TrackPoint[] = [
  { latitude: 47.07, longitude: -70.93, time: 0 } as TrackPoint,
  { latitude: 47.08, longitude: -70.92, time: 1000 } as TrackPoint,
];

async function mount(): Promise<void> {
  mockLayers.length = 0;
  await render(
    <PaperProvider>
      <Trail2DView points={POINTS} basemap="map" />
    </PaperProvider>,
  );
}

const map = (): Props => {
  if (mockMapProps.current === null) throw new Error('Map not rendered');
  return mockMapProps.current;
};
const styleLayerIds = (): string[] =>
  (map().mapStyle as { layers: { id: string }[] }).layers.map((l) => l.id);
const tiltLayer = (): Props | undefined =>
  [...mockLayers].reverse().find((l) => l.id === TILT_RELIEF_LAYER_ID);

beforeEach(() => {
  useSettingsStore.setState({ showHillshade: true, tiltRelief: 'natural' });
});

it('lets two fingers tilt the map', async () => {
  await mount();
  expect(map().touchPitch).toBe(true);
});

it('builds the style with the hidden relief pass when 3D relief is on', async () => {
  await mount();
  expect(styleLayerIds()).toContain(TILT_RELIEF_LAYER_ID);
  await act(async () => useSettingsStore.setState({ tiltRelief: 'off' }));
  await mount();
  expect(styleLayerIds()).not.toContain(TILT_RELIEF_LAYER_ID);
});

it('drives the pass from the settled pitch, once the style has loaded', async () => {
  await mount();
  // Before the first style load: no layer (it would create a colourless one).
  expect(tiltLayer()).toBeUndefined();
  const onStyle = map().onDidFinishLoadingStyle as () => void;
  const onSettle = map().onRegionDidChange as (e: { nativeEvent: { pitch: number } }) => void;
  await act(async () => onStyle());
  expect(tiltLayer()?.layout).toEqual({ visibility: 'none' });

  await act(async () => onSettle({ nativeEvent: { pitch: 60 } }));
  const tilted = tiltLayer();
  expect(tilted?.layout).toEqual({ visibility: 'visible' });
  expect(JSON.stringify(tilted?.paint)).toContain(String(TILT_RELIEF_EXAGGERATION.natural));

  await act(async () => onSettle({ nativeEvent: { pitch: 0 } }));
  expect(tiltLayer()?.layout).toEqual({ visibility: 'none' });
});

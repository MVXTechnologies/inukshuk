import { act, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import type { TrackNote, TrackPoint } from '@core/models';
import { NOTE_BADGE_DP, PHOTO_CIRCLE_DP } from '@core/photos/notePins';
import { photoScaleAt } from '@core/photos/mapStyle';
import { useSettingsStore } from '@state/settingsStore';
import { Trail2DView } from './Trail2DView';

/**
 * #742 (option 1, photo ring): a note with a photo is its photo's circle on
 * the trail with the green number on the top-right edge, drawn from a
 * resized round sprite (never the full-size photo); a note without a photo
 * keeps its plain pin. A tap on either part opens the note.
 */
type Props = Record<string, unknown> & { children?: ReactNode };
const mockMapProps: { current: Props | null } = { current: null };

jest.mock('@maplibre/maplibre-react-native', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const passthrough = ({ children }: { children?: ReactNode }) => children ?? null;
  const MockMap = React.forwardRef(function MockMap(props: Props, ref) {
    mockMapProps.current = props;
    // 1 px per 0.00001° east / north of (0, 0): enough to place a tap.
    React.useImperativeHandle(ref, () => ({
      project: async ([lng, lat]: [number, number]) => [lng * 1e5, -lat * 1e5],
      getZoom: async () => 15,
    }));
    return props.children ?? null;
  });
  const MockCamera = React.forwardRef(function MockCamera() {
    return null;
  });
  return {
    Map: MockMap,
    Camera: MockCamera,
    Images: () => null,
    GeoJSONSource: passthrough,
    Marker: passthrough,
    Layer: () => null,
  };
});

const mockMake = jest.fn(async (uri: string) => `file:///cache/made-${uri.slice(-5)}.map2.png`);
jest.mock('@data/photos/noteSprites', () => ({
  cachedNoteSprite: (uri: string) =>
    uri === 'file:///p/cached.jpg' ? 'file:///cache/cached.map2.png' : null,
  makeNoteSprite: (uri: string) => mockMake(uri),
}));

const POINTS: TrackPoint[] = [0, 1, 2, 3, 4].map(
  (i) => ({ latitude: 0, longitude: i * 0.001, time: i * 1000, altitude: 0 }) as TrackPoint,
);
const note = (id: string, distanceM: number, photoUri?: string): TrackNote => ({
  id,
  distanceM,
  text: id,
  createdAt: 0,
  ...(photoUri ? { photoUri } : {}),
});

async function mount(notes: TrackNote[], onNotePress = jest.fn()) {
  await render(
    <PaperProvider>
      <Trail2DView points={POINTS} basemap="map" notes={notes} onNotePress={onNotePress} />
    </PaperProvider>,
  );
  return onNotePress;
}

const box = (node: { props: Record<string, unknown> }): { width?: unknown } =>
  StyleSheet.flatten(node.props.style as never) ?? {};

beforeEach(() => {
  mockMake.mockClear();
  useSettingsStore.setState({ pinScale: 100 });
});

it('a note with a cached sprite is a photo circle; a note without photo keeps its pin', async () => {
  await mount([note('n1', 50), note('n2', 200, 'file:///p/cached.jpg')]);
  const pins = screen.getAllByTestId('note-photo-pin');
  expect(pins).toHaveLength(1);
  const img = screen.getByTestId('note-photo-pin-image');
  expect(img.props.source).toEqual({ uri: 'file:///cache/cached.map2.png' });
  // Both numbers are drawn: "1" as the plain pin, "2" on the circle.
  expect(screen.getByText('1')).toBeTruthy();
  expect(screen.getByText('2')).toBeTruthy();
});

it('makes a missing sprite (never shows the full-size photo), the pin until then', async () => {
  await mount([note('n1', 50, 'file:///p/new01.jpg')]);
  expect(mockMake).toHaveBeenCalledWith('file:///p/new01.jpg');
  await waitFor(() => expect(screen.getByTestId('note-photo-pin')).toBeTruthy());
  const img = screen.getByTestId('note-photo-pin-image');
  expect(img.props.source.uri).toBe('file:///cache/made-1.jpg.map2.png');
});

it('grows the circle with the zoom; the badge follows Pin size', async () => {
  await mount([note('n2', 200, 'file:///p/cached.jpg')]);
  const at = () => box(screen.getByTestId('note-photo-pin-image')).width as number;
  expect(at()).toBeCloseTo(PHOTO_CIRCLE_DP * photoScaleAt(15));
  const props = mockMapProps.current!;
  await act(async () =>
    (props.onRegionIsChanging as (e: unknown) => void)({ nativeEvent: { zoom: 18.5 } }),
  );
  expect(at()).toBeCloseTo(PHOTO_CIRCLE_DP * photoScaleAt(18.5));

  await act(async () => useSettingsStore.setState({ pinScale: 150 }));
  const badge = screen.getByTestId('note-badge-1');
  expect(box(badge).width).toBe(NOTE_BADGE_DP * 1.5);
});

it('a tap on the circle’s badge opens the note', async () => {
  const onNotePress = await mount([note('n2', 200, 'file:///p/cached.jpg')]);
  const props = mockMapProps.current!;
  // The note sits ~200 m east of the start: x ≈ 180, y = 0 in the stub's
  // pixels; the badge is up and right of it.
  await act(async () =>
    (props.onPress as (e: unknown) => Promise<void>)({ nativeEvent: { point: [180 + 30, -30] } }),
  );
  expect(onNotePress).toHaveBeenCalledWith('n2');
  onNotePress.mockClear();
  await act(async () =>
    (props.onPress as (e: unknown) => Promise<void>)({ nativeEvent: { point: [180 + 90, 0] } }),
  );
  expect(onNotePress).not.toHaveBeenCalled();
});

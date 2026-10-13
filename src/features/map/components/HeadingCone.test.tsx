import { act, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';

import { HeadingCone } from './HeadingCone';
import { PUCK_RING_LAYER_ID, PuckLayers } from './PuckLayers';

type Props = Record<string, unknown> & { children?: ReactNode };
const mockLayers: Props[] = [];
type Listener = (h: { headingDeg: number; accuracy: number | null }) => void;
let mockHeading: Listener | null = null;

jest.mock('@maplibre/maplibre-react-native', () => ({
  GeoJSONSource: (props: Props) => props.children ?? null,
  Layer: (props: Props) => {
    mockLayers.push(props);
    return null;
  },
  useCurrentPosition: () => ({ coords: { accuracy: 10 } }),
}));
jest.mock('../useCompass', () => ({
  subscribeHeading: (l: Listener) => {
    mockHeading = l;
    return () => {
      mockHeading = null;
    };
  },
}));

beforeEach(() => {
  mockLayers.length = 0;
});

/**
 * 2.5.1 review: the cone was anchored under `mlrn-user-location-puck-white`,
 * a layer of MapLibre's DEFAULT puck — which our PuckLayers replace, so the
 * anchor never existed and the cone was never inserted. It now sits under
 * the custom puck's ring; this pins that the anchor is a layer we draw.
 */
describe('HeadingCone anchor', () => {
  it('sits under a layer the custom puck actually draws', async () => {
    await render(
      <PaperProvider>
        <PuckLayers weakAccuracyM={null} />
      </PaperProvider>,
    );
    expect(mockLayers.map((l) => l.id)).toContain(PUCK_RING_LAYER_ID);
  });

  it('inserts its fill before that ring layer, not the default puck', async () => {
    await render(
      <PaperProvider>
        <HeadingCone location={{ latitude: 46.81, longitude: -71.21 }} />
      </PaperProvider>,
    );
    await act(async () => mockHeading?.({ headingDeg: 90, accuracy: 3 }));
    const fill = mockLayers.find((l) => l.id === 'heading-cone-fill');
    expect(fill?.beforeId).toBe(PUCK_RING_LAYER_ID);
    expect(fill?.beforeId).not.toBe('mlrn-user-location-puck-white');
  });
});

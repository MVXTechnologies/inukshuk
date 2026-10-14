import { LIVE_LAYER_ORDER, liveLayerAnchor } from '@core/map/liveLayerOrder';
import { act, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';

import { HeadingCone } from './HeadingCone';
import { PUCK_RING_LAYER_ID, PuckLayers } from './PuckLayers';

type Props = Record<string, unknown> & { children?: ReactNode };
const mockLayers: Props[] = [];
type Listener = (h: { headingDeg: number; accuracy: number | null; moving: boolean }) => void;
let mockHeading: Listener | null = null;
const mockSources: Props[] = [];

jest.mock('@maplibre/maplibre-react-native', () => ({
  GeoJSONSource: (props: Props) => {
    mockSources.push(props);
    return props.children ?? null;
  },
  Layer: (props: Props) => {
    mockLayers.push(props);
    return null;
  },
  useCurrentPosition: () => ({ coords: { accuracy: 10 } }),
}));
jest.mock('../headingMotion', () => ({
  subscribeHeadingMotion: (l: Listener) => {
    mockHeading = l;
    return () => {
      mockHeading = null;
    };
  },
}));

beforeEach(() => {
  mockLayers.length = 0;
  mockSources.length = 0;
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

  it('inserts its fill under the ring layer, not the default puck', async () => {
    await render(
      <PaperProvider>
        <HeadingCone location={{ latitude: 46.81, longitude: -71.21 }} />
      </PaperProvider>,
    );
    await act(async () => mockHeading?.({ headingDeg: 90, accuracy: 3, moving: false }));
    const fill = mockLayers.find((l) => l.id === 'heading-cone-fill');
    // Its own live anchor, which the style keeps under the puck's ring.
    expect(fill?.beforeId).toBe(liveLayerAnchor('heading-cone-fill'));
    expect(fill?.beforeId).not.toBe('mlrn-user-location-puck-white');
    expect(LIVE_LAYER_ORDER.indexOf('heading-cone-fill')).toBeLessThan(
      LIVE_LAYER_ORDER.indexOf(PUCK_RING_LAYER_ID),
    );
  });
});

describe('HeadingCone motion', () => {
  /** The beam's centre bearing, from its polygon (apex first, arc after). */
  function beamBearing(): number {
    const data = mockSources.at(-1)?.data as { geometry: { coordinates: number[][][] } };
    const ring = data.geometry.coordinates[0]!;
    const [lon0, lat0] = ring[0]!;
    const mid = ring[Math.floor(ring.length / 2)]!;
    const dx = (mid[0]! - lon0!) * Math.cos((lat0! * Math.PI) / 180);
    const dy = mid[1]! - lat0!;
    return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  }

  it('turns with every display frame: one polygon per frame, no steps', async () => {
    await render(
      <PaperProvider>
        <HeadingCone location={{ latitude: 46.81, longitude: -71.21 }} />
      </PaperProvider>,
    );
    await act(async () => mockHeading?.({ headingDeg: 90, accuracy: 3, moving: false }));
    const before = mockSources.length;
    for (let i = 1; i <= 30; i++) {
      await act(async () => mockHeading?.({ headingDeg: 90 + i * 0.5, accuracy: 3, moving: true }));
      expect(beamBearing()).toBeCloseTo(90 + i * 0.5, 6);
    }
    expect(mockSources.length - before).toBe(30);
  });
});

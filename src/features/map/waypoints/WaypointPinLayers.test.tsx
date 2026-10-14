import { liveLayerAnchor } from '@core/map/liveLayerOrder';
import { WAYPOINT_ICONS } from '@core/library/waypointIcons';
import type { PinInput } from '@core/map/waypointPinStyle';
import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';

import { WAYPOINT_PIN_LAYERS, WaypointPinLayers } from './WaypointPinLayers';

type Props = Record<string, unknown> & { children?: ReactNode };
const mockLayers: Props[] = [];
const mockSources: Props[] = [];
const mockImages: Props[] = [];

jest.mock('@maplibre/maplibre-react-native', () => ({
  GeoJSONSource: (props: Props) => {
    mockSources.push(props);
    return props.children ?? null;
  },
  Layer: (props: Props) => {
    mockLayers.push(props);
    return null;
  },
  Images: (props: Props) => {
    mockImages.push(props);
    return null;
  },
}));

beforeEach(() => {
  mockLayers.length = 0;
  mockSources.length = 0;
  mockImages.length = 0;
});

const OFM_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

const pins = (n: number): PinInput[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `saved-${i}`,
    latitude: 46 + i * 1e-3,
    longitude: -71,
    label: `Waypoint ${i + 1}`,
    icon: WAYPOINT_ICONS[i % 5]?.id,
    hasPhoto: i % 3 === 0,
  }));

async function draw(p: PinInput[], glyphs: string | null = OFM_GLYPHS) {
  return render(
    <PaperProvider>
      <WaypointPinLayers
        pins={p}
        selectedKey={null}
        hiddenKey={null}
        glyphs={glyphs ?? undefined}
      />
    </PaperProvider>,
  );
}

describe('WaypointPinLayers (#675)', () => {
  it('draws 500 pins with ONE source and three layers — no view per pin', async () => {
    await draw(pins(500));
    expect(mockSources).toHaveLength(1);
    const data = mockSources[0]?.data as { features: unknown[] };
    // A body and a glyph feature per pin, in one layer (drawn in source order).
    expect(data.features).toHaveLength(1000);
    expect(mockLayers.map((l) => l.id)).toEqual([
      WAYPOINT_PIN_LAYERS.pin,
      WAYPOINT_PIN_LAYERS.photo,
      WAYPOINT_PIN_LAYERS.label,
    ]);
    expect(mockLayers.every((l) => l.type === 'symbol')).toBe(true);
    // Each pin layer sits under its own anchor in the style's live slot.
    expect(mockLayers.map((l) => l.beforeId)).toEqual([
      liveLayerAnchor('waypoint-pin'),
      liveLayerAnchor('waypoint-pin-photo'),
      liveLayerAnchor('waypoint-pin-label'),
    ]);
  });

  it('registers the SDF body, the photo badge and only the glyphs in use', async () => {
    await draw(pins(500));
    const images = mockImages[0]?.images as Record<string, unknown>;
    const names = Object.keys(images).sort();
    // 5 icons in use + the inukshuk + body + badge.
    expect(names).toHaveLength(8);
    expect(images['wp-pin']).toMatchObject({ sdf: true });
    expect(images[`wpg-${WAYPOINT_ICONS[0]?.id}`]).toMatchObject({ sdf: true });
    expect(images['wp-photo']).not.toHaveProperty('sdf');
  });

  it('draws no labels on a style without glyphs (raster, satellite)', async () => {
    await draw(pins(3), null);
    expect(mockLayers.map((l) => l.id)).not.toContain(WAYPOINT_PIN_LAYERS.label);
  });

  it('draws nothing at all without pins', async () => {
    await draw([]);
    expect(mockSources).toHaveLength(0);
    expect(mockImages).toHaveLength(0);
  });

  it('keeps the same data object across re-renders with the same pins', async () => {
    const p = pins(50);
    const { rerender } = await draw(p);
    const first = mockSources[0]?.data;
    await rerender(
      <PaperProvider>
        <WaypointPinLayers pins={p} selectedKey={null} hiddenKey={null} glyphs={OFM_GLYPHS} />
      </PaperProvider>,
    );
    expect(mockSources[mockSources.length - 1]?.data).toBe(first);
  });
});

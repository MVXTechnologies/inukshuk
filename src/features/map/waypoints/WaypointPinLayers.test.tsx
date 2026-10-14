import { liveLayerAnchor } from '@core/map/liveLayerOrder';
import { WAYPOINT_ICONS } from '@core/library/waypointIcons';
import { pinClusterRadius } from '@core/map/waypointClusters';
import type { PinInput } from '@core/map/waypointPinStyle';
import { useSettingsStore } from '@state/settingsStore';
import { act, render } from '@testing-library/react-native';
import { useEffect, type ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';
import { darkTheme, lightTheme } from '@ui/theme';
import { schemeTokens } from '@ui/tokens';

import { WAYPOINT_PIN_LAYERS, WAYPOINT_PIN_SOURCE, WaypointPinLayers } from './WaypointPinLayers';
import { useWaypointClusterSheet, waypointClusterSource } from './waypointTap';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

type Props = Record<string, unknown> & { children?: ReactNode };
const mockLayers: Props[] = [];
const mockSources: Props[] = [];
const mockImages: Props[] = [];
/** Native source creations (a mount), by source id: what a cluster-option change costs. */
const mockMounts: string[] = [];

jest.mock('@maplibre/maplibre-react-native', () => {
  const {
    forwardRef,
    useEffect: useMountEffect,
    useImperativeHandle,
  } = jest.requireActual('react');
  return {
    GeoJSONSource: forwardRef((props: Props, ref: unknown) => {
      mockSources.push(props);
      useImperativeHandle(ref, () => ({ id: props.id }));
      useMountEffect(() => {
        mockMounts.push(props.id as string);
      }, []);
      return props.children ?? null;
    }),
    Layer: (props: Props) => {
      mockLayers.push(props);
      return null;
    },
    Images: (props: Props) => {
      mockImages.push(props);
      return null;
    },
  };
});

beforeEach(() => {
  mockLayers.length = 0;
  mockSources.length = 0;
  mockImages.length = 0;
  mockMounts.length = 0;
  useSettingsStore.setState({ pinScale: 100 });
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

function Tree({
  p,
  selectedKey = null,
  glyphs = OFM_GLYPHS,
  dark = false,
}: {
  p: PinInput[];
  selectedKey?: string | null;
  glyphs?: string | null;
  dark?: boolean;
}) {
  return (
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <WaypointPinLayers
        pins={p}
        selectedKey={selectedKey}
        hiddenKey={null}
        glyphs={glyphs ?? undefined}
      />
    </PaperProvider>
  );
}

const last = (id: string) => [...mockSources].reverse().find((s) => s.id === id);
const layer = (id: string) => [...mockLayers].reverse().find((l) => l.id === id);

describe('WaypointPinLayers (#675, #685)', () => {
  it('draws 500 pins from ONE clustered source, one feature per pin — no view per pin', async () => {
    await render(<Tree p={pins(500)} />);
    expect(mockSources).toHaveLength(1);
    const source = mockSources[0]!;
    expect(source).toMatchObject({
      id: WAYPOINT_PIN_SOURCE,
      cluster: true,
      clusterRadius: pinClusterRadius(['M']),
      clusterMaxZoom: 18,
    });
    const data = source.data as { features: { properties: { key: string } }[] };
    // One feature per waypoint: body and glyph can never cluster apart.
    expect(data.features).toHaveLength(500);
    expect(new Set(data.features.map((f) => f.properties.key)).size).toBe(500);
    expect(mockLayers.map((l) => l.id)).toEqual([
      WAYPOINT_PIN_LAYERS.cluster,
      WAYPOINT_PIN_LAYERS.clusterGlyph,
      WAYPOINT_PIN_LAYERS.clusterCount,
      WAYPOINT_PIN_LAYERS.pin,
      WAYPOINT_PIN_LAYERS.glyph,
      WAYPOINT_PIN_LAYERS.photo,
      WAYPOINT_PIN_LAYERS.label,
    ]);
    // Each layer sits under its own anchor in the style's live slot.
    for (const l of mockLayers) expect(l.beforeId).toBe(liveLayerAnchor(l.id as never));
    // Clusters draw only clusters; pins only what is not one.
    expect(layer(WAYPOINT_PIN_LAYERS.cluster)?.filter).toEqual(['has', 'point_count']);
    expect(layer(WAYPOINT_PIN_LAYERS.pin)?.filter).toEqual(['!', ['has', 'point_count']]);
    expect(layer(WAYPOINT_PIN_LAYERS.glyph)?.filter).toEqual(['!', ['has', 'point_count']]);
  });

  it('draws the selected pin from its own source, on top, never clustered', async () => {
    await render(<Tree p={pins(3)} selectedKey="saved-1" />);
    const clustered = last(WAYPOINT_PIN_SOURCE)?.data as {
      features: { properties: { key: string } }[];
    };
    expect(clustered.features.map((f) => f.properties.key)).toEqual(['saved-0', 'saved-2']);
    const selected = last('waypoint-pin-selected');
    expect(selected?.cluster).toBeUndefined();
    const sel = selected?.data as { features: { id: string }[] };
    // The one-layer, source-order drawing: body then glyph.
    expect(sel.features.map((f) => f.id)).toEqual(['saved-1:body', 'saved-1:glyph']);
    expect(mockLayers.map((l) => l.id)).toEqual(
      expect.arrayContaining([
        WAYPOINT_PIN_LAYERS.selected,
        WAYPOINT_PIN_LAYERS.selectedPhoto,
        WAYPOINT_PIN_LAYERS.selectedLabel,
      ]),
    );
  });

  it('a pin opened from a cluster’s list stands alone: the list’s other pins step aside, then come back', async () => {
    const keysOf = () =>
      (last(WAYPOINT_PIN_SOURCE)?.data as { features: { properties: { key: string } }[] }).features
        .map((f) => f.properties.key)
        .sort();
    useWaypointClusterSheet.getState().open(['saved-1', 'saved-2', 'saved-3']);
    useWaypointClusterSheet.getState().openedFrom('saved-2');
    const r = await render(<Tree p={pins(5)} selectedKey="saved-2" />);
    expect(keysOf()).toEqual(['saved-0', 'saved-4']);
    // Another pin selected (or none): the store forgets, everyone is back.
    await r.rerender(<Tree p={pins(5)} selectedKey={null} />);
    expect(useWaypointClusterSheet.getState().opened).toBeNull();
    expect(keysOf()).toEqual(['saved-0', 'saved-1', 'saved-2', 'saved-3', 'saved-4']);
  });

  it('hands the clustered source to the tap code', async () => {
    await render(<Tree p={pins(3)} />);
    expect(waypointClusterSource.current).toEqual({ id: WAYPOINT_PIN_SOURCE });
  });

  it('registers the SDF body, the photo badge, the glyphs in use and the small count pills', async () => {
    await render(<Tree p={pins(500)} />);
    const images = mockImages[0]?.images as Record<string, unknown>;
    expect(images['wp-pin']).toMatchObject({ sdf: true });
    expect(images[`wpg-${WAYPOINT_ICONS[0]?.id}`]).toMatchObject({ sdf: true });
    expect(images['wp-photo']).not.toHaveProperty('sdf');
    // 5 icons in use + the inukshuk + body + badge + pills 2…10.
    expect(Object.keys(images)).toHaveLength(8 + 9);
    expect(images['ph-count-2']).toBeDefined();
    expect(images['ph-count-23']).toBeUndefined();
  });

  it('adds a larger count pill when a cluster first asks for it, and nothing else', async () => {
    await render(<Tree p={pins(3)} />);
    const onMissing = mockImages[mockImages.length - 1]?.onImageMissing as (e: unknown) => void;
    await act(async () => onMissing({ nativeEvent: { image: 'ph-count-23' } }));
    await act(async () => onMissing({ nativeEvent: { image: 'someone-elses' } }));
    const images = mockImages[mockImages.length - 1]?.images as Record<string, unknown>;
    expect(images['ph-count-23']).toBeDefined();
    expect(images['someone-elses']).toBeUndefined();
  });

  it('draws no labels on a style without glyphs (raster, satellite)', async () => {
    await render(<Tree p={pins(3)} selectedKey="saved-0" glyphs={null} />);
    const ids = mockLayers.map((l) => l.id);
    expect(ids).not.toContain(WAYPOINT_PIN_LAYERS.label);
    expect(ids).not.toContain(WAYPOINT_PIN_LAYERS.selectedLabel);
    // The count is an image: it still draws.
    expect(ids).toContain(WAYPOINT_PIN_LAYERS.clusterCount);
  });

  it('draws nothing at all without pins', async () => {
    await render(<Tree p={[]} />);
    expect(mockSources).toHaveLength(0);
    expect(mockImages).toHaveLength(0);
  });

  it.each([false, true])(
    'dark %p: the marks are the same, the names follow the theme',
    async (dark) => {
      await render(<Tree p={pins(3)} dark={dark} />);
      const disc = layer(WAYPOINT_PIN_LAYERS.cluster)?.paint as Record<string, unknown>;
      expect(disc['circle-color']).toBe('#566B33');
      expect(disc['circle-stroke-color']).toBe('#FBF8F2');
      const count = layer(WAYPOINT_PIN_LAYERS.clusterCount)?.layout as Record<string, unknown>;
      expect(JSON.stringify(count['icon-image'])).toContain('ph-count-');
      const label = layer(WAYPOINT_PIN_LAYERS.label)?.paint as Record<string, unknown>;
      expect(label['text-color']).toBe(schemeTokens(dark).team.mapInk);
      expect(schemeTokens(true).team.mapInk).not.toBe(schemeTokens(false).team.mapInk);
    },
  );
});

/**
 * Measure, don't assert wall-clock: what each event costs in source
 * updates (a new `data` object), native source creations and renders.
 */
describe('cost', () => {
  it('a re-render with the same pins (a pan, a GPS tick) costs nothing', async () => {
    const p = pins(50);
    let renders = 0;
    function Counted() {
      useEffect(() => {
        renders += 1;
      });
      return <Tree p={p} />;
    }
    const { rerender } = await render(<Counted />);
    const first = last(WAYPOINT_PIN_SOURCE)?.data;
    const sourcesBefore = mockSources.length;
    const layersBefore = mockLayers.length;
    for (let i = 0; i < 10; i++) await rerender(<Counted />);
    expect(renders).toBe(11);
    // The memoised component never re-rendered: no source or layer render, no new data.
    expect(mockSources.length).toBe(sourcesBefore);
    expect(mockLayers.length).toBe(layersBefore);
    expect(last(WAYPOINT_PIN_SOURCE)?.data).toBe(first);
    expect(mockMounts).toEqual([WAYPOINT_PIN_SOURCE]);
  });

  it('changing the Pin size re-creates the clustered source ONCE, with the same data', async () => {
    const p = pins(50);
    await render(<Tree p={p} />);
    const data = last(WAYPOINT_PIN_SOURCE)?.data;
    const before = layer(WAYPOINT_PIN_LAYERS.pin)?.layout as Record<string, unknown>;
    expect(before['icon-size']).toEqual(['get', 'bsz']);
    mockMounts.length = 0;
    const sourcesBefore = mockSources.length;

    await act(async () => useSettingsStore.setState({ pinScale: 150 }));

    // One render of the source (the new one), one native creation.
    expect(mockSources.length - sourcesBefore).toBe(1);
    expect(mockMounts).toEqual([WAYPOINT_PIN_SOURCE]);
    const after = last(WAYPOINT_PIN_SOURCE)!;
    expect(after.data).toBe(data); // the pins' data is not rebuilt
    expect(after.clusterRadius).toBe(pinClusterRadius(['M'], 1.5));
    expect(
      (layer(WAYPOINT_PIN_LAYERS.pin)?.layout as Record<string, unknown>)['icon-size'],
    ).toEqual(['*', ['get', 'bsz'], 1.5]);
    expect(
      (layer(WAYPOINT_PIN_LAYERS.cluster)?.paint as Record<string, unknown>)['circle-radius'],
    ).toBe(27);
  });

  it('a pin added in the same sizes updates the data without re-creating the source', async () => {
    const { rerender } = await render(<Tree p={pins(10)} />);
    mockMounts.length = 0;
    await rerender(<Tree p={pins(11)} />);
    expect(mockMounts).toEqual([]);
    const data = last(WAYPOINT_PIN_SOURCE)?.data as { features: unknown[] };
    expect(data.features).toHaveLength(11);
  });

  it('a larger pin size on the map widens the radius (one re-creation)', async () => {
    const p = pins(10);
    const { rerender } = await render(<Tree p={p} />);
    mockMounts.length = 0;
    await rerender(<Tree p={[...p, { ...p[0]!, key: 'saved-xl', size: 'XL' }]} />);
    expect(mockMounts).toEqual([WAYPOINT_PIN_SOURCE]);
    expect(last(WAYPOINT_PIN_SOURCE)?.clusterRadius).toBe(pinClusterRadius(['M', 'XL']));
  });

  it('selecting a pin (even the only XL) is one data update, never a re-creation', async () => {
    const p = [...pins(10), { ...pins(1)[0]!, key: 'saved-xl', size: 'XL' as const }];
    const { rerender } = await render(<Tree p={p} />);
    mockMounts.length = 0;
    const before = last(WAYPOINT_PIN_SOURCE)?.data;
    await rerender(<Tree p={p} selectedKey="saved-xl" />);
    // Only the selected pin's own small source is created.
    expect(mockMounts).toEqual(['waypoint-pin-selected']);
    expect(last(WAYPOINT_PIN_SOURCE)?.data).not.toBe(before);
    expect(last(WAYPOINT_PIN_SOURCE)?.clusterRadius).toBe(pinClusterRadius(['M', 'XL']));
  });
});

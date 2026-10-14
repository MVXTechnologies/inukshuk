/**
 * The pointing line on the map (#681): hidden/visible rules, the
 * no-magnetometer COG fallback, Edge, the layers, both themes — and, measured,
 * that heading ticks re-render this leaf only, at 4 Hz at most.
 */
import { LIVE_LAYER_ORDER, liveLayerAnchor, type LiveLayerId } from '@core/map/liveLayerOrder';
import { haversineMeters, initialBearingDeg } from '@core/geo/geomath';
import { DEFAULT_POINTING_LINE, type PointingLineSettings } from '@core/map/pointingLineSettings';
import type { LatLng } from '@core/models';
import { signedDeltaDeg } from '@core/signal/heading';
import { useSettingsStore } from '@state/settingsStore';
import { darkTheme, lightTheme } from '@ui/theme';
import { darkScheme, lightScheme } from '@ui/tokens';
import { act, render } from '@testing-library/react-native';
import { Profiler, useState, type ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';
import { POINTING_LINE_LAYERS, PointingLine, type PointingLineProps } from './PointingLine';
import { PUCK_RING_LAYER_ID } from './PuckLayers';

type Props = Record<string, unknown> & { children?: ReactNode };
const mockLayers: Props[] = [];
const mockSources: Props[] = [];
/** Sources on the map right now (mounted, not unmounted). */
const mockMounted = { count: 0 };
jest.mock('@maplibre/maplibre-react-native', () => ({
  GeoJSONSource: (props: Props) => {
    mockSources.push(props);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(() => {
      mockMounted.count++;
      return () => {
        mockMounted.count--;
      };
    }, []);
    return props.children ?? null;
  },
  Layer: (props: Props) => {
    mockLayers.push(props);
    return null;
  },
  useCurrentPosition: () => null,
}));
jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: async () => null }));

type Listener = (s: { headingDeg: number; accuracy: number | null }) => void;
const mockListeners = new Set<Listener>();
jest.mock('../useCompass', () => ({
  subscribeHeading: (l: Listener) => {
    mockListeners.add(l);
    return () => mockListeners.delete(l);
  },
}));

// The heading throttle and the COG refresh are timers.
jest.useFakeTimers();

const QC: LatLng = { latitude: 46.8139, longitude: -71.2082 };
const OFM = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const BASE: PointingLineProps = {
  location: QC,
  bounds: null,
  zoom: 16,
  glyphs: OFM,
  suppressed: false,
};

/** Set before mounting (nothing subscribed yet, so no act needed). */
function configure(patch: Partial<PointingLineSettings>) {
  useSettingsStore.setState({ pointingLine: { ...DEFAULT_POINTING_LINE, ...patch } });
}

async function heading(deg: number) {
  await act(async () => {
    for (const l of mockListeners) l({ headingDeg: deg, accuracy: 3 });
  });
}

function wrap(props: Partial<PointingLineProps>, dark = false) {
  return (
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <PointingLine {...BASE} {...props} />
    </PaperProvider>
  );
}

type F = {
  geometry: { type: string; coordinates: unknown };
  properties: { kind: string; text?: string };
};
/** The source's data on its latest render, or null when none is drawn. */
function drawn(): { features: F[] } | null {
  return (mockSources.at(-1)?.data as { features: F[] } | undefined) ?? null;
}
function lineOf(fc: { features: F[] }): { from: LatLng; to: LatLng } {
  const line = fc.features.find((f) => f.properties.kind === 'line')!;
  const [[a, b], [c, d]] = line.geometry.coordinates as [[number, number], [number, number]];
  return { from: { latitude: b, longitude: a }, to: { latitude: d, longitude: c } };
}
const labels = (fc: { features: F[] }) =>
  fc.features.filter((f) => f.properties.kind === 'label').map((f) => f.properties.text);

beforeEach(() => {
  mockLayers.length = 0;
  mockSources.length = 0;
  mockListeners.clear();
  useSettingsStore.setState({ pointingLine: DEFAULT_POINTING_LINE, units: 'metric' });
});

describe('PointingLine: when it shows', () => {
  it('is off by default: draws nothing and listens to nothing', async () => {
    await render(wrap({}));
    expect(mockSources).toHaveLength(0);
    expect(mockListeners.size).toBe(0);
  });

  it('draws 500 m along the heading, below the puck ring', async () => {
    configure({ enabled: true });
    await render(wrap({}));
    expect(mockListeners.size).toBe(1);
    expect(mockSources).toHaveLength(0); // no heading yet, no COG: hidden
    await heading(62);
    const fc = drawn()!;
    const { from, to } = lineOf(fc);
    expect(haversineMeters(from, to)).toBeCloseTo(500, 3);
    expect(initialBearingDeg(from, to)).toBeCloseTo(62, 6);
    // 50 m ticks: 8 minor and 2 major, no labels by default.
    expect(fc.features.filter((f) => f.properties.kind === 'tick')).toHaveLength(8);
    expect(fc.features.filter((f) => f.properties.kind === 'major')).toHaveLength(2);
    expect(labels(fc)).toEqual([]);
    const ids = mockLayers.map((l) => l.id);
    expect(ids).toEqual([
      POINTING_LINE_LAYERS.casing,
      POINTING_LINE_LAYERS.line,
      POINTING_LINE_LAYERS.end,
      POINTING_LINE_LAYERS.labels,
    ]);
    // Each under its own live anchor: below the pins and the puck's ring (2.5.1).
    for (const l of mockLayers) {
      expect(l.beforeId).toBe(liveLayerAnchor(l.id as LiveLayerId));
    }
    expect(LIVE_LAYER_ORDER.indexOf('pointing-line')).toBeLessThan(
      LIVE_LAYER_ORDER.indexOf(PUCK_RING_LAYER_ID),
    );
  });

  it('hides during waypoint move, region select and the map maker, and without a fix', async () => {
    configure({ enabled: true, direction: 'fixed', fixedBearingDeg: 10 });
    const view = await render(wrap({ suppressed: true }));
    expect(mockSources).toHaveLength(0);
    expect(mockListeners.size).toBe(0);
    await view.rerender(wrap({ location: null }));
    expect(mockSources).toHaveLength(0);
    await view.rerender(wrap({}));
    expect(drawn()).not.toBeNull();
  });

  it('labels every 5th tick when asked; no glyph host, no labels at all', async () => {
    configure({ enabled: true, direction: 'fixed', fixedBearingDeg: 0, labelEvery5th: true });
    const view = await render(wrap({}));
    expect(labels(drawn()!)).toEqual(['250 m', '500 m']);
    mockLayers.length = 0;
    await view.rerender(wrap({ glyphs: undefined }));
    expect(labels(drawn()!)).toEqual([]);
    expect(mockLayers.map((l) => l.id)).not.toContain(POINTING_LINE_LAYERS.labels);
  });

  it('follows the unit setting: round feet in imperial, redrawn when it changes', async () => {
    configure({ enabled: true, direction: 'fixed', fixedBearingDeg: 0, labelEvery5th: true });
    useSettingsStore.setState({ units: 'imperial' });
    await render(wrap({}));
    // The 500 m stop is 0.5 mi in imperial (2.5.1 final QA): 2640 ft long, and
    // 50 m stands for 200 ft: 13 ticks (11 minor), the 5th and 10th labelled.
    let fc = drawn()!;
    const { from, to } = lineOf(fc);
    expect(haversineMeters(from, to)).toBeCloseTo(2640 * 0.3048, 0);
    expect(fc.features.filter((f) => f.properties.kind === 'tick')).toHaveLength(11);
    expect(labels(fc)).toEqual(['1000 ft', '2000 ft']);
    await act(async () => useSettingsStore.setState({ units: 'metric' }));
    fc = drawn()!;
    expect(labels(fc)).toEqual(['250 m', '500 m']);
  });

  it('a fixed bearing works with no compass and standing still', async () => {
    configure({ enabled: true, direction: 'fixed', fixedBearingDeg: 270 });
    await render(wrap({}));
    expect(mockListeners.size).toBe(0); // no compass needed
    const { from, to } = lineOf(drawn()!);
    expect(signedDeltaDeg(270, initialBearingDeg(from, to))).toBeCloseTo(0, 6);
  });

  it('Edge runs to the settled bounds, and waits for them', async () => {
    configure({ enabled: true, direction: 'fixed', fixedBearingDeg: 0, length: 'edge' });
    const view = await render(wrap({ bounds: null }));
    expect(mockSources).toHaveLength(0);
    const bounds = { west: -71.23, south: 46.8, east: -71.19, north: 46.82 };
    await view.rerender(wrap({ bounds }));
    const { from, to } = lineOf(drawn()!);
    expect(to.latitude).toBeCloseTo(46.82, 6);
    expect(haversineMeters(from, to)).toBeCloseTo(
      haversineMeters(QC, { ...QC, latitude: 46.82 }),
      0,
    );
  });
});

describe('PointingLine: no magnetometer', () => {
  /** A walk north at 5 m/s: a fix every 2 s, 10 m apart. */
  async function walk(view: Awaited<ReturnType<typeof render>>, steps: number) {
    let at = QC;
    for (let i = 1; i <= steps; i++) {
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      at = { latitude: QC.latitude + (i * 10) / 111_195, longitude: QC.longitude };
      await view.rerender(wrap({ location: at }));
    }
    return at;
  }

  it('heading: course over ground above 0.5 m/s, labelled COG; hidden when you stop', async () => {
    configure({ enabled: true });
    const view = await render(wrap({}));
    expect(mockSources).toHaveLength(0);
    await walk(view, 2);
    const fc = drawn()!;
    const { from, to } = lineOf(fc);
    expect(signedDeltaDeg(0, initialBearingDeg(from, to))).toBeCloseTo(0, 3);
    expect(labels(fc)).toEqual(['COG']);
    expect(mockMounted.count).toBe(1);
    // Stopped: no new fix; the refresh re-reads the same one and the speed decays.
    await act(async () => {
      jest.advanceTimersByTime(6000);
    });
    expect(mockMounted.count).toBe(0);
  });

  it('the compass wins as soon as it speaks (no COG label)', async () => {
    configure({ enabled: true });
    const view = await render(wrap({}));
    await walk(view, 2);
    await heading(90);
    const fc = drawn()!;
    const { from, to } = lineOf(fc);
    expect(initialBearingDeg(from, to)).toBeCloseTo(90, 6);
    expect(labels(fc)).toEqual([]);
  });

  it('course: COG even with a compass; hidden standing still', async () => {
    configure({ enabled: true, direction: 'course' });
    const view = await render(wrap({}));
    expect(mockListeners.size).toBe(0);
    expect(mockSources).toHaveLength(0);
    await walk(view, 2);
    expect(labels(drawn()!)).toEqual(['COG']);
  });
});

describe('PointingLine: themes', () => {
  it.each([
    ['light', false, lightScheme],
    ['dark', true, darkScheme],
  ] as const)('labels use the %s scheme’s map ink and halo', async (_n, dark, scheme) => {
    configure({ enabled: true, direction: 'fixed', labelEvery5th: true });
    await render(wrap({}, dark));
    const label = mockLayers.find((l) => l.id === POINTING_LINE_LAYERS.labels)!;
    expect(label.paint).toMatchObject({
      'text-color': scheme.team.mapInk,
      'text-halo-color': scheme.team.mapHalo,
    });
    const line = mockLayers.find((l) => l.id === POINTING_LINE_LAYERS.line)!;
    expect((line.paint as Record<string, unknown>)['line-color']).toBe('#D32F2F');
  });
});

describe('PointingLine render cost (measured)', () => {
  it('heading ticks re-render the leaf only, at most 4 times a second, never the parent', async () => {
    configure({ enabled: true });
    let parentRenders = 0;
    let leafCommits = 0;
    function Parent() {
      parentRenders++;
      const [props] = useState(BASE);
      return (
        <Profiler id="line" onRender={() => leafCommits++}>
          <PointingLine {...props} />
        </Profiler>
      );
    }
    await render(
      <PaperProvider theme={lightTheme}>
        <Parent />
      </PaperProvider>,
    );
    await heading(100);
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    const parentBefore = parentRenders;
    const commitsBefore = leafCommits;
    const sourcesBefore = mockSources.length;

    // Sub-degree jitter at 20 Hz for 1 s: no work at all.
    for (let i = 1; i <= 20; i++) {
      await heading(100 + (i % 2) * 0.6);
      await act(async () => {
        jest.advanceTimersByTime(50);
      });
    }
    expect(leafCommits).toBe(commitsBefore);

    // A steady 3°-per-sample turn at 20 Hz for 2 s: ≤ 4 Hz → at most 8 commits (+1 trailing).
    for (let i = 1; i <= 40; i++) {
      await heading(100 + i * 3);
      await act(async () => {
        jest.advanceTimersByTime(50);
      });
    }
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    const commits = leafCommits - commitsBefore;
    expect(commits).toBeGreaterThanOrEqual(7);
    expect(commits).toBeLessThanOrEqual(9);
    // One native source update per commit, and the turn's last heading is the one drawn.
    expect(mockSources.length - sourcesBefore).toBe(commits);
    const { from, to } = lineOf(drawn()!);
    expect(signedDeltaDeg(220, initialBearingDeg(from, to))).toBeCloseTo(0, 6);
    expect(parentRenders).toBe(parentBefore);
  });
});

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import type { OverlayTab } from '@core/map/overlayTabs';
import { defaultExtensionPrefs } from '@core/extensions/prefs';
import type { ExtensionKey } from '@core/extensions/keys';
import type { ExtensionPrefs } from '@core/extensions/types';
import { darkTheme, lightTheme } from '@ui/theme';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { OverlaysPanel } from './MapOverlaysMenu';
import { resetStripRuntime, useStripRuntime } from '../infoStrip/stripRuntime';

/**
 * The #484 Overlays sheet: one themed, scrolling list of Switch rows and
 * level pickers. Every row must drive the SAME setting the old drill-down's
 * checkbox or slider drove — the map reads those settings, not the menu.
 *
 * The parked state of the Weather and Marine rows is SHIPPED BEHAVIOUR, so it
 * gets a test like anything else — and the same suite, run with the flags
 * flipped, is the executable proof of the parking's central promise: turning
 * `WEATHER_ENABLED` / `MARINE_ENABLED` back on is all it takes to get the
 * features back. The flags are mocked through getters so one module registry
 * serves both halves; the component reads them at render time.
 */
const mockFlags = { WEATHER_ENABLED: false, MARINE_ENABLED: false };
jest.mock('@core/features/flags', () => ({
  get WEATHER_ENABLED() {
    return mockFlags.WEATHER_ENABLED;
  },
  get MARINE_ENABLED() {
    return mockFlags.MARINE_ENABLED;
  },
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
// The base-map previews are cached tile fetches (RegionPreviewThumb, covered on
// its own); here a stub that records what each one was asked to show.
const mockThumbs: { basemap: string; bbox: unknown }[] = [];
jest.mock('../RegionPreviewThumb', () => ({
  RegionPreviewThumb: (props: { basemap: string; bbox: unknown }) => {
    mockThumbs.push({ basemap: props.basemap, bbox: props.bbox });
    return null;
  },
}));

const noop = (): void => undefined;

interface Node {
  type: string;
  props: Record<string, unknown>;
  children: (Node | string)[] | null;
}

/** Every host node of a rendered tree (`toJSON()`), depth first. */
function nodes(tree: unknown): Node[] {
  const out: Node[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const node = n as Node;
    out.push(node);
    node.children?.forEach(walk);
  };
  walk(tree);
  return out;
}

/** Put some extensions' persisted state in the settings store (the rest at defaults). */
function setExtensions(p: Partial<Record<ExtensionKey, Partial<ExtensionPrefs>>>): void {
  const d = defaultExtensionPrefs();
  useSettingsStore.setState({
    extensions: {
      geodetic: { ...d.geodetic, ...p.geodetic },
      tides: { ...d.tides, ...p.tides },
      gnss: d.gnss,
      team: d.team,
    },
  });
}

// `render` resolves asynchronously here (React 19 act); awaiting it is what
// populates `screen`, exactly as mapLayers.test.tsx does.
async function renderMenu(
  props: Partial<{ onClose: () => void; onOpenFolders: () => void }> = {},
): Promise<void> {
  await render(
    <OverlaysPanel
      onSlopeEnabled={noop}
      onOpenFolders={props.onOpenFolders ?? noop}
      onClose={props.onClose ?? noop}
    />,
  );
}

/** Open the sheet on a tab (the remembered tab is the one it opens on). */
const onTab = (tab: OverlayTab) => useSettingsStore.setState({ overlaysTab: tab });

const checked = (label: string): unknown =>
  screen.getByLabelText(label).props.accessibilityState?.checked;
const selected = (label: string): unknown =>
  screen.getByLabelText(label).props.accessibilityState?.selected;

afterEach(async () => {
  mockPush.mockClear();
  mockThumbs.length = 0;
  mockFlags.WEATHER_ENABLED = false;
  mockFlags.MARINE_ENABLED = false;
  await act(async () => {
    useSettingsStore.getState().reset();
    useMapStore.setState({ basemap: 'map' });
  });
});

describe('Overlays sheet layout (#484)', () => {
  it('has four tabs, each with its rows; the last tab is remembered', async () => {
    await renderMenu();
    for (const t of ['Map', 'Terrain', 'Sports', 'Extensions']) {
      expect(screen.getByLabelText(`${t} tab`).props.accessibilityRole).toBe('tab');
    }
    expect(screen.getByText('Ext.')).toBeTruthy();
    expect(screen.getByLabelText('Map tab').props.accessibilityState).toEqual({ selected: true });
    const tabs: [string, string[], string[]][] = [
      [
        'Map',
        [
          'Content: everything',
          'PDF maps',
          'Parks & protected areas',
          'MAP AIDS',
          'Customize info strip',
          'Pointing line',
        ],
        // Satellite's, PDF maps' and the pointing line's own options live in their sub-panels.
        [
          'Shading',
          'Personal heatmap',
          'Labels on satellite',
          'Imagery',
          'See-through white',
          'Tick marks',
        ],
      ],
      [
        'Terrain',
        [
          'BASE MAP',
          'Trails, contours, names',
          'Aerial imagery',
          'RELIEF',
          'Shading',
          '3D relief',
          'Contours',
          'Slope',
        ],
        ['PDF maps', 'Personal heatmap', 'See-through white', 'Labels on satellite'],
      ],
      // Weather and Marine are parked: no Live layers section at all.
      ['Sports', ['Personal heatmap'], ['PDF maps', 'Shading', 'LIVE LAYERS']],
    ];
    for (const [tab, shown, hidden] of tabs) {
      await fireEvent.press(screen.getByLabelText(`${tab} tab`));
      for (const label of shown) expect(screen.getByText(label)).toBeTruthy();
      for (const label of hidden) expect(screen.queryByText(label)).toBeNull();
    }
    expect(useSettingsStore.getState().overlaysTab).toBe('sports');
    // The drill-down group is gone; the ✕ is the open-state handle now.
    expect(screen.queryByLabelText('Topology')).toBeNull();
    expect(screen.getByLabelText('Close overlays')).toBeTruthy();
  });

  it('is titled "Map layers"; the a11y/Maestro handles stay "… overlays"', async () => {
    await renderMenu();
    expect(screen.getByText('Map layers')).toBeTruthy();
    expect(screen.queryByText('Overlays')).toBeNull();
    expect(screen.getByLabelText('Close overlays')).toBeTruthy();
  });

  it.each([
    ['map', 'map'],
    ['map', 'terrain'],
    ['satellite', 'map'],
    ['satellite', 'terrain'],
  ] as const)('greys out no item on the %s base map, %s tab', async (basemap, tab) => {
    useMapStore.setState({ basemap });
    useSettingsStore.setState({ satelliteLabels: false, showPdfOverlay: false });
    onTab(tab);
    await renderMenu();
    const resting = nodes(screen.toJSON())
      .filter((n) => (n.props.accessibilityState as { disabled?: boolean })?.disabled === true)
      .map((n) => n.props.accessibilityLabel);
    // Only a picker that belongs to an OFF switch above it rests (contour
    // density, the slope window) — and 3D relief on builds without native
    // terrain, out of scope here (every store build has native 3D).
    const allowed = ['Off', 'Natural', 'Dramatic', '10 m', '25 m', '50 m', '100 m', 'Auto'];
    for (const label of resting) {
      expect([...allowed, 'Slope minimum', 'Slope maximum']).toContain(label);
    }
  });

  it('reopens on the remembered tab', async () => {
    onTab('terrain');
    await renderMenu();
    expect(screen.getByLabelText('Terrain tab').props.accessibilityState).toEqual({
      selected: true,
    });
    expect(screen.getByText('Peaks')).toBeTruthy();
  });

  it('opens on a row’s sub-panel when asked (the geodetic filter)', async () => {
    setExtensions({ geodetic: { installedAt: 1 } });
    await render(
      <OverlaysPanel
        onSlopeEnabled={noop}
        onOpenFolders={noop}
        onClose={noop}
        openOn="geodeticFilter"
      />,
    );
    expect(screen.getByText('Geodetic points')).toBeTruthy();
    expect(screen.getByLabelText('Show geodetic points')).toBeTruthy();
    expect(screen.queryByLabelText('Map tab')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Back to extensions'));
    expect(screen.getByLabelText('Extensions tab').props.accessibilityState).toEqual({
      selected: true,
    });
  });

  it.each([
    ['seeThroughWhite', 'See-through white', 'Map tab'],
    ['imagery', 'Labels on satellite', 'Terrain tab'],
  ] as const)(
    'opens %s in its sub-panel, whose back returns to its tab',
    async (row, label, tab) => {
      await render(
        <OverlaysPanel onSlopeEnabled={noop} onOpenFolders={noop} onClose={noop} openOn={row} />,
      );
      expect(screen.getByText(label)).toBeTruthy();
      await fireEvent.press(screen.getByLabelText('Back to overlays'));
      expect(screen.getByLabelText(tab).props.accessibilityState).toEqual({ selected: true });
    },
  );

  it('closes from the ✕', async () => {
    const onClose = jest.fn();
    await renderMenu({ onClose });
    fireEvent.press(screen.getByLabelText('Close overlays'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('"Customize info strip" (#673) closes the sheet and opens the strip editor', async () => {
    const onClose = jest.fn();
    resetStripRuntime();
    await renderMenu({ onClose });
    expect(screen.getByText('Default · fields, dock, centre cursor')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Customize info strip'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useStripRuntime.getState().editorOpen).toBe(true);
    resetStripRuntime();
  });

  it('opens the folder picker from the Content row', async () => {
    const onOpenFolders = jest.fn();
    await renderMenu({ onOpenFolders });
    fireEvent.press(screen.getByLabelText('Content: everything'));
    expect(onOpenFolders).toHaveBeenCalledTimes(1);
  });

  it('never wraps a row label (the owner’s stray "s" of Contours)', async () => {
    onTab('terrain');
    await renderMenu();
    for (const label of ['Contours', 'Shading', '3D relief', 'Peaks', 'Slope']) {
      expect(screen.getByText(label).props.numberOfLines).toBe(1);
    }
  });

  it('has no Elevation tint row (it was drawn only by the removed three.js 3D view)', async () => {
    await renderMenu();
    expect(screen.queryByText('Elevation tint')).toBeNull();
  });
});

describe('switches drive the same settings as the old checkboxes', () => {
  it.each([
    ['PDF maps', 'showPdfOverlay', 'map'],
    ['Personal heatmap', 'showHeatmap', 'sports'],
    ['Contours', 'terrainContours', 'terrain'],
    ['Slope', 'terrainSlope', 'terrain'],
  ] as const)('%s toggles %s and reports it as a switch state', async (label, key, tab) => {
    const before = useSettingsStore.getState()[key];
    onTab(tab);
    await renderMenu();
    expect(checked(label)).toBe(before);
    expect(screen.getByLabelText(label).props.accessibilityRole).toBe('switch');
    await act(async () => {
      fireEvent.press(screen.getByLabelText(label));
    });
    expect(useSettingsStore.getState()[key]).toBe(!before);
    expect(checked(label)).toBe(!before);
  });

  it('says where hidden PDF maps went', async () => {
    useSettingsStore.setState({ showPdfOverlay: false });
    await renderMenu();
    expect(screen.getByText('Hidden on the map')).toBeTruthy();
  });

  it('turning Slope on fires the one-time disclaimer hook', async () => {
    const onSlopeEnabled = jest.fn();
    onTab('terrain');
    await render(
      <OverlaysPanel onSlopeEnabled={onSlopeEnabled} onOpenFolders={noop} onClose={noop} />,
    );
    fireEvent.press(screen.getByLabelText('Slope'));
    expect(onSlopeEnabled).toHaveBeenCalledTimes(1);
  });

  it('keeps the slope range thumbs (Maestro keys on "Slope minimum")', async () => {
    onTab('terrain');
    await renderMenu();
    expect(screen.getByLabelText('Slope minimum')).toBeTruthy();
    expect(screen.getByLabelText('Slope maximum')).toBeTruthy();
  });

  it('Contours density picks the interval', async () => {
    useSettingsStore.setState({ terrainContours: true, terrainContourIntervalM: 0 });
    onTab('terrain');
    await renderMenu();
    expect(selected('Auto')).toBe(true);
    fireEvent.press(screen.getByLabelText('50 m'));
    expect(useSettingsStore.getState().terrainContourIntervalM).toBe(50);
  });
});

describe("Base map cards (#669: the rail's Base map, moved into Terrain)", () => {
  beforeEach(() => onTab('terrain'));
  const MAP = 'Map, Trails, contours, names';
  const SATELLITE = 'Satellite, Aerial imagery';

  it.each([false, true])(
    'marks the current base map, one check, and switches without closing (dark: %s)',
    async (dark) => {
      const onClose = jest.fn();
      useMapStore.setState({ basemap: 'map' });
      await render(
        <PaperProvider theme={dark ? darkTheme : lightTheme}>
          <OverlaysPanel onSlopeEnabled={noop} onOpenFolders={noop} onClose={onClose} />
        </PaperProvider>,
      );
      expect(selected(MAP)).toBe(true);
      expect(selected(SATELLITE)).toBe(false);
      expect(screen.getAllByTestId('map-type-check')).toHaveLength(1);
      await fireEvent.press(screen.getByLabelText(SATELLITE));
      expect(useMapStore.getState().basemap).toBe('satellite');
      expect(selected(SATELLITE)).toBe(true);
      expect(screen.getAllByTestId('map-type-check')).toHaveLength(1);
      expect(onClose).not.toHaveBeenCalled();
      // The selection ring is the sheet accent in both themes.
      const theme = dark ? darkTheme : lightTheme;
      const ringed = nodes(screen.toJSON()).filter(
        (n) =>
          n.type === 'View' &&
          StyleSheet.flatten(n.props.style as StyleProp<ViewStyle>)?.borderColor ===
            theme.colors.secondary,
      );
      expect(ringed).toHaveLength(1);
    },
  );

  it('previews each base map over the user’s own last position', async () => {
    useSettingsStore.setState({ lastKnownPosition: { latitude: 46.8, longitude: -71.2 } });
    await renderMenu();
    expect(new Set(mockThumbs.map((t) => t.basemap))).toEqual(new Set(['map', 'satellite']));
    const bbox = mockThumbs[0]?.bbox as { minLat: number; maxLat: number; minLng: number };
    expect(bbox.minLat).toBeLessThan(46.8);
    expect(bbox.maxLat).toBeGreaterThan(46.8);
    expect(bbox.minLng).toBeCloseTo(-71.22);
  });

  it('only Satellite has a sub-panel: Map has no options of its own', async () => {
    await renderMenu();
    expect(screen.getByLabelText('Options for Satellite')).toBeTruthy();
    expect(screen.queryByLabelText('Options for Map')).toBeNull();
  });
});

describe('Satellite sub-panel (#669)', () => {
  beforeEach(() => onTab('terrain'));
  const open = async () => {
    await renderMenu();
    await fireEvent.press(screen.getByLabelText('Options for Satellite'));
  };

  it('holds Labels on satellite and Imagery, never greyed, even on the Map base', async () => {
    useMapStore.setState({ basemap: 'map' });
    await open();
    expect(screen.queryByLabelText('Terrain tab')).toBeNull(); // the page takes the sheet
    const labels = screen.getByLabelText('Labels on satellite');
    expect(labels.props.accessibilityState).toMatchObject({ checked: true, disabled: false });
    await fireEvent.press(labels);
    expect(useSettingsStore.getState().satelliteLabels).toBe(false);
    expect(selected('Brighter')).toBe(true);
    expect(screen.getByLabelText('Bright').props.accessibilityState).toMatchObject({
      disabled: false,
    });
    await fireEvent.press(screen.getByLabelText('Original'));
    expect(useSettingsStore.getState().satelliteImagery).toBe('original');
    // Still on the Map base: setting them never switches it.
    expect(useMapStore.getState().basemap).toBe('map');
  });

  it('offers "Use" while Map is the base map, and says "Base map in use" once it is', async () => {
    useMapStore.setState({ basemap: 'map' });
    await open();
    await fireEvent.press(screen.getByLabelText('Use Satellite as the base map'));
    expect(useMapStore.getState().basemap).toBe('satellite');
    expect(screen.getByLabelText('Base map in use')).toBeTruthy();
    expect(screen.queryByLabelText('Use Satellite as the base map')).toBeNull();
  });

  it('goes back to the Terrain tab', async () => {
    await open();
    await fireEvent.press(screen.getByLabelText('Back to overlays'));
    expect(screen.getByLabelText('Terrain tab').props.accessibilityState).toEqual({
      selected: true,
    });
  });
});

describe('Parks & protected areas', () => {
  it('is on by default and toggles the setting on the Map base', async () => {
    useMapStore.setState({ basemap: 'map' });
    await renderMenu();
    expect(checked('Parks & protected areas')).toBe(true);
    expect(screen.getByText('Boundaries and names')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Parks & protected areas'));
    expect(useSettingsStore.getState().showParks).toBe(false);
  });

  it.each([true, false])(
    'works over Satellite whatever its labels (labels on: %s) — its own pass (#669)',
    async (satelliteLabels) => {
      useMapStore.setState({ basemap: 'satellite' });
      useSettingsStore.setState({ satelliteLabels, showParks: false });
      await renderMenu();
      const row = screen.getByLabelText('Parks & protected areas');
      expect(row.props.accessibilityState).toMatchObject({ checked: false, disabled: false });
      expect(screen.getByText('Boundaries and names')).toBeTruthy();
      await fireEvent.press(row);
      expect(useSettingsStore.getState().showParks).toBe(true);
    },
  );
});

describe('Extensions tab', () => {
  beforeEach(() => onTab('extensions'));

  it('with nothing installed, an empty state leads to Settings → Extensions', async () => {
    await renderMenu();
    expect(screen.getByText('No extensions yet')).toBeTruthy();
    expect(screen.queryByLabelText('Geodetic points')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Get extensions'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/settings',
      params: { open: 'extensions' },
    });
  });

  it('lists what is installed, then "Get more extensions"', async () => {
    setExtensions({ geodetic: { installedAt: 1, show: true }, tides: { installedAt: 0 } });
    await renderMenu();
    expect(checked('Geodetic points')).toBe(true);
    expect(screen.queryByLabelText('Tide stations')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Get more extensions'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/settings',
      params: { open: 'extensions' },
    });
  });

  it('geodetic: one row, its switch and its summary (the legend lives in Settings)', async () => {
    setExtensions({ geodetic: { installedAt: 1, show: true } });
    await renderMenu();
    expect(screen.getByText('Survey marks and benchmarks').props.numberOfLines).toBe(1);
    expect(screen.queryByLabelText('Geodetic points legend')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Geodetic points'));
    expect(useSettingsStore.getState().extensions.geodetic.show).toBe(false);
  });

  it('geodetic: filters in its sub-panel, back to the tab, badge counted, reset', async () => {
    setExtensions({ geodetic: { installedAt: 1, show: true } });
    await renderMenu();
    expect(screen.queryByTestId('sub-panel-badge')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Options for Geodetic points'));
    expect(screen.queryByLabelText('Map tab')).toBeNull(); // the sub-panel takes the sheet
    await fireEvent.press(screen.getByLabelText('GNSS'));
    await fireEvent.press(screen.getByLabelText('Has heights'));
    const f = useSettingsStore.getState().geodeticFilter;
    expect(f.types).not.toContain('gnss');
    expect(f.hasHeights).toBe(true);
    await fireEvent.press(screen.getByLabelText('Back to extensions'));
    expect(screen.getByText('Filtered · 2 filters')).toBeTruthy();
    expect(screen.getByTestId('sub-panel-badge')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Options for Geodetic points, 2 filters on'));
    await fireEvent.press(screen.getByLabelText('Reset geodetic filters'));
    expect(useSettingsStore.getState().geodeticFilter.hasHeights).toBe(false);
    expect(useSettingsStore.getState().geodeticFilter.types).toContain('gnss');
  });

  it('geodetic: its sub-panel starts with the same switch as its row', async () => {
    setExtensions({ geodetic: { installedAt: 1, show: true } });
    await renderMenu();
    await fireEvent.press(screen.getByLabelText('Options for Geodetic points'));
    await fireEvent.press(screen.getByLabelText('Show geodetic points'));
    expect(useSettingsStore.getState().extensions.geodetic.show).toBe(false);
    await fireEvent.press(screen.getByLabelText('Back to extensions'));
    expect(checked('Geodetic points')).toBe(false);
  });

  it('tide stations: its own one-line row once installed', async () => {
    setExtensions({ tides: { installedAt: 1, show: true } });
    await renderMenu();
    expect(screen.queryByLabelText('Geodetic points')).toBeNull();
    expect(checked('Tide stations')).toBe(true);
    expect(screen.getByText('Tide gauges and tidal levels').props.numberOfLines).toBe(1);
    expect(screen.queryByLabelText('Gauge symbols legend')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Tide stations'));
    expect(useSettingsStore.getState().extensions.tides.show).toBe(false);
  });
});

describe('Terrain levels', () => {
  beforeEach(() => onTab('terrain'));
  it('shows Shading and Peaks with their current values', async () => {
    useSettingsStore.setState({ showHillshade: true, hillshadeStrength: 'heavy' });
    await renderMenu();
    expect(selected('Heavy')).toBe(true);
    expect(selected('Normal')).toBe(true);
  });

  it('reads the hillshade switch off as None', async () => {
    useSettingsStore.setState({ showHillshade: false, hillshadeStrength: 'heavy' });
    await renderMenu();
    expect(selected('None')).toBe(true);
  });

  it('None turns the hillshade off and keeps the chosen strength', async () => {
    useSettingsStore.setState({ showHillshade: true, hillshadeStrength: 'light' });
    await renderMenu();
    fireEvent.press(screen.getByLabelText('None'));
    expect(useSettingsStore.getState().showHillshade).toBe(false);
    expect(useSettingsStore.getState().hillshadeStrength).toBe('light');
  });

  it('a strength turns the hillshade on at that strength', async () => {
    useSettingsStore.setState({ showHillshade: false, hillshadeStrength: 'medium' });
    await renderMenu();
    fireEvent.press(screen.getByLabelText('Heavy'));
    expect(useSettingsStore.getState().showHillshade).toBe(true);
    expect(useSettingsStore.getState().hillshadeStrength).toBe('heavy');
  });

  it.each(['Fewer', 'More'] as const)('Peaks: %s sets the density', async (label) => {
    await renderMenu();
    fireEvent.press(screen.getByLabelText(label));
    expect(useSettingsStore.getState().peakDensity).toBe(label.toLowerCase());
  });

  it.each([
    ['Off', 'off'],
    ['Dramatic', 'dramatic'],
    ['Natural', 'natural'],
  ] as const)('3D relief: %s sets the setting and never the shading', async (label, value) => {
    useSettingsStore.setState({
      showHillshade: true,
      hillshadeStrength: 'light',
      tiltRelief: value === 'natural' ? 'off' : 'natural',
    });
    await renderMenu();
    fireEvent.press(screen.getByLabelText(label));
    expect(useSettingsStore.getState().tiltRelief).toBe(value);
    expect(useSettingsStore.getState().showHillshade).toBe(true);
    expect(useSettingsStore.getState().hillshadeStrength).toBe('light');
  });

  it('3D relief rests with Shading None', async () => {
    useSettingsStore.setState({ showHillshade: false });
    await renderMenu();
    expect(screen.getByText('Needs shading')).toBeTruthy();
    expect(screen.getByLabelText('Dramatic').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });
});

describe('Pointing line row and sub-panel (#681)', () => {
  it('is off by default and says what it would draw; the switch turns it on', async () => {
    await renderMenu();
    expect(checked('Pointing line')).toBe(false);
    expect(screen.getByText('Off · 500 m along your heading')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Pointing line'));
    expect(useSettingsStore.getState().pointingLine.enabled).toBe(true);
    expect(screen.getByText('500 m along your heading')).toBeTruthy();
  });

  it('opens its page from the accessory, and goes back to the Map tab', async () => {
    onTab('terrain');
    await renderMenu();
    await fireEvent.press(screen.getByLabelText('Map tab'));
    await fireEvent.press(screen.getByLabelText('Options for pointing line'));
    expect(screen.queryByLabelText('Map tab')).toBeNull();
    expect(checked('Show pointing line')).toBe(false);
    await fireEvent.press(screen.getByLabelText('Show pointing line'));
    expect(useSettingsStore.getState().pointingLine.enabled).toBe(true);
    await fireEvent.press(screen.getByLabelText('Back to overlays'));
    expect(selected('Map tab')).toBe(true);
    expect(checked('Pointing line')).toBe(true);
  });
});

describe('PDF maps sub-panel: See-through white (#670)', () => {
  const slider = () => screen.getByLabelText('See-through white');
  const adjust = (actionName: 'increment' | 'decrement') =>
    act(async () => {
      fireEvent(slider(), 'accessibilityAction', { nativeEvent: { actionName } });
    });
  const open = async () => {
    await renderMenu();
    await fireEvent.press(screen.getByLabelText('Options for PDF maps'));
  };

  it('opens from the PDF maps row, starting with its switch', async () => {
    await open();
    expect(screen.queryByLabelText('Map tab')).toBeNull();
    expect(checked('Show PDF maps')).toBe(true);
    await fireEvent.press(screen.getByLabelText('Show PDF maps'));
    expect(useSettingsStore.getState().showPdfOverlay).toBe(false);
    await fireEvent.press(screen.getByLabelText('Back to overlays'));
    expect(checked('PDF maps')).toBe(false);
  });

  it('is a 5-stop slider, Off by default', async () => {
    await open();
    expect(screen.getByText('See-through white')).toBeTruthy();
    expect(slider().props.accessibilityRole).toBe('adjustable');
    expect(slider().props.accessibilityValue).toEqual({ min: 0, max: 4, now: 0, text: 'Off' });
  });

  it('steps through 25 / 50 / 75 / 100 %, each setting the global level', async () => {
    await open();
    const seen: string[] = [];
    for (const expected of [1, 2, 3, 4]) {
      await adjust('increment');
      expect(useSettingsStore.getState().pdfWhiteKey).toBe(expected);
      seen.push(String(slider().props.accessibilityValue.text));
    }
    expect(seen).toEqual(['25 %', '50 %', '75 %', '100 %']);
    // Clamped at Full.
    await adjust('increment');
    expect(useSettingsStore.getState().pdfWhiteKey).toBe(4);
  });

  it('steps back down to Off', async () => {
    useSettingsStore.setState({ pdfWhiteKey: 1 });
    await open();
    expect(slider().props.accessibilityValue).toMatchObject({ now: 1, text: '25 %' });
    await adjust('decrement');
    expect(useSettingsStore.getState().pdfWhiteKey).toBe(0);
    expect(slider().props.accessibilityValue).toMatchObject({ now: 0, text: 'Off' });
  });

  it('is never greyed: it can be set while the PDF maps are hidden', async () => {
    useSettingsStore.setState({ showPdfOverlay: false, pdfWhiteKey: 2 });
    await open();
    expect(screen.queryByText('Needs PDF maps')).toBeNull();
    expect(slider().props.accessibilityState?.disabled).not.toBe(true);
    await adjust('increment');
    expect(useSettingsStore.getState().pdfWhiteKey).toBe(3);
  });

  it.each([
    [0, '50 %', 0.5],
    [1, '25 %', 0.75],
    [4, '100 %', 0],
  ] as const)(
    'its before/after sample shows the level (setting %s → %s, paper %s)',
    async (level, label, paper) => {
      useSettingsStore.setState({ pdfWhiteKey: level });
      await open();
      expect(screen.getByText('Off · paper white')).toBeTruthy();
      expect(screen.getByText(`${label} · base map shows`)).toBeTruthy();
      const sheet = StyleSheet.flatten(screen.getByTestId('pdf-sample-paper').props.style);
      expect(sheet.opacity).toBeCloseTo(paper);
      expect(mockThumbs.some((t) => t.basemap === 'map')).toBe(true);
    },
  );

  it('says a map can override it from the Library', async () => {
    await open();
    expect(screen.getByText(/Library › the map’s ⋮ › See-through white/)).toBeTruthy();
  });
});

describe('Live layers (Sports tab)', () => {
  beforeEach(() => onTab('sports'));
  describe('with weather and marine parked', () => {
    it('shows no row for them at all — no greyed "Coming soon" rows (owner rule)', async () => {
      await renderMenu();
      expect(screen.queryByText('Weather')).toBeNull();
      expect(screen.queryByText('Marine')).toBeNull();
      expect(screen.queryByText('Coming soon')).toBeNull();
      // With nothing live, the section title goes too.
      expect(screen.queryByText(/live layers/i)).toBeNull();
      // The heatmap stays.
      expect(screen.getByLabelText('Personal heatmap')).toBeTruthy();
    });

    it('shows the one layer that is back, alone', async () => {
      mockFlags.MARINE_ENABLED = true;
      await renderMenu();
      expect(screen.getByLabelText('Marine')).toBeTruthy();
      expect(screen.queryByText('Weather')).toBeNull();
    });
  });

  describe('with the flags flipped back on', () => {
    it('restores the live Weather and Marine rows', async () => {
      mockFlags.WEATHER_ENABLED = true;
      mockFlags.MARINE_ENABLED = true;
      await renderMenu();
      expect(screen.getByLabelText('Weather')).toBeTruthy();
      expect(screen.getByLabelText('Marine')).toBeTruthy();
      expect(screen.queryByText('Coming soon')).toBeNull();
    });

    it('Marine switches the whole chart mode', async () => {
      mockFlags.MARINE_ENABLED = true;
      await renderMenu();
      await act(async () => {
        fireEvent.press(screen.getByLabelText('Marine'));
      });
      expect(useSettingsStore.getState().marineLayers.length).toBeGreaterThan(0);
      expect(checked('Marine')).toBe(true);
    });
    it('opens the weather list and comes back', async () => {
      mockFlags.WEATHER_ENABLED = true;
      await renderMenu();
      fireEvent.press(screen.getByLabelText('Weather'));
      expect(await screen.findByLabelText('Back to overlays')).toBeTruthy();
      fireEvent.press(screen.getByLabelText('Rain radar'));
      expect(useSettingsStore.getState().weatherLayer).toBe('radar-rain');
      fireEvent.press(screen.getByLabelText('Back to overlays'));
      expect(await screen.findByLabelText('Weather: Rain radar')).toBeTruthy();
    });
  });
});

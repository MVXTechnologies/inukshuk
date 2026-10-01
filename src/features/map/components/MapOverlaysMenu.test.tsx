import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { OverlaysPanel } from './MapOverlaysMenu';

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
  PARKED_LABEL: 'Coming soon',
}));

const noop = (): void => undefined;

// `render` resolves asynchronously here (React 19 act); awaiting it is what
// populates `screen`, exactly as mapLayers.test.tsx does.
async function renderMenu(
  props: Partial<{ showHypso: boolean; onClose: () => void; onOpenFolders: () => void }> = {},
): Promise<void> {
  await render(
    <OverlaysPanel
      showHypso={props.showHypso ?? false}
      onSlopeEnabled={noop}
      onOpenFolders={props.onOpenFolders ?? noop}
      onClose={props.onClose ?? noop}
    />,
  );
}

const checked = (label: string): unknown =>
  screen.getByLabelText(label).props.accessibilityState?.checked;
const selected = (label: string): unknown =>
  screen.getByLabelText(label).props.accessibilityState?.selected;

afterEach(async () => {
  mockFlags.WEATHER_ENABLED = false;
  mockFlags.MARINE_ENABLED = false;
  await act(async () => {
    useSettingsStore.getState().reset();
    useMapStore.setState({ basemap: 'map' });
  });
});

describe('Overlays sheet layout (#484)', () => {
  it('groups the rows under On the map / Terrain / Live layers', async () => {
    await renderMenu();
    for (const title of ['ON THE MAP', 'TERRAIN', 'LIVE LAYERS']) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    for (const label of [
      'Content: everything',
      'PDF maps',
      'Personal heatmap',
      'Labels on satellite',
      'Shading',
      '3D relief',
      'Contours',
      'Slope',
      'Peaks',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // The drill-down group is gone; the ✕ is the open-state handle now.
    expect(screen.queryByLabelText('Topology')).toBeNull();
    expect(screen.getByLabelText('Close overlays')).toBeTruthy();
  });

  it('closes from the ✕', async () => {
    const onClose = jest.fn();
    await renderMenu({ onClose });
    fireEvent.press(screen.getByLabelText('Close overlays'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens the folder picker from the Content row', async () => {
    const onOpenFolders = jest.fn();
    await renderMenu({ onOpenFolders });
    fireEvent.press(screen.getByLabelText('Content: everything'));
    expect(onOpenFolders).toHaveBeenCalledTimes(1);
  });

  it('never wraps a row label (the owner’s stray "s" of Contours)', async () => {
    await renderMenu();
    for (const label of ['Contours', 'Shading', '3D relief', 'Peaks', 'Slope', 'PDF maps']) {
      expect(screen.getByText(label).props.numberOfLines).toBe(1);
    }
  });

  it('hides Elevation tint in 2D', async () => {
    await renderMenu();
    expect(screen.queryByText('Elevation tint')).toBeNull();
  });

  it('shows Elevation tint in 3D, driving the same setting', async () => {
    await renderMenu({ showHypso: true });
    fireEvent.press(screen.getByLabelText('Elevation tint'));
    expect(useSettingsStore.getState().terrainHypso).toBe(true);
  });
});

describe('switches drive the same settings as the old checkboxes', () => {
  it.each([
    ['PDF maps', 'showPdfOverlay'],
    ['Personal heatmap', 'showHeatmap'],
    ['Contours', 'terrainContours'],
    ['Slope', 'terrainSlope'],
  ] as const)('%s toggles %s and reports it as a switch state', async (label, key) => {
    const before = useSettingsStore.getState()[key];
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
    await render(
      <OverlaysPanel
        showHypso={false}
        onSlopeEnabled={onSlopeEnabled}
        onOpenFolders={noop}
        onClose={noop}
      />,
    );
    fireEvent.press(screen.getByLabelText('Slope'));
    expect(onSlopeEnabled).toHaveBeenCalledTimes(1);
  });

  it('keeps the slope range thumbs (Maestro keys on "Slope minimum")', async () => {
    await renderMenu();
    expect(screen.getByLabelText('Slope minimum')).toBeTruthy();
    expect(screen.getByLabelText('Slope maximum')).toBeTruthy();
  });

  it('Contours density picks the interval', async () => {
    useSettingsStore.setState({ terrainContours: true, terrainContourIntervalM: 0 });
    await renderMenu();
    expect(selected('Auto')).toBe(true);
    fireEvent.press(screen.getByLabelText('50 m'));
    expect(useSettingsStore.getState().terrainContourIntervalM).toBe(50);
  });
});

describe('Labels on satellite (#484)', () => {
  it('is on by default and toggles the setting while the base map is Satellite', async () => {
    useMapStore.setState({ basemap: 'satellite' });
    await renderMenu();
    expect(checked('Labels on satellite')).toBe(true);
    expect(screen.getByText('Trails and names over imagery')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Labels on satellite'));
    expect(useSettingsStore.getState().satelliteLabels).toBe(false);
  });

  it('is greyed with a hint, and inert, on the Map base', async () => {
    useMapStore.setState({ basemap: 'map' });
    await renderMenu();
    const row = screen.getByLabelText('Labels on satellite');
    expect(row.props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByText('For the Satellite map type')).toBeTruthy();
    fireEvent.press(row);
    expect(useSettingsStore.getState().satelliteLabels).toBe(true);
  });
});

describe('Terrain levels', () => {
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

describe('See-through white (PDF maps)', () => {
  const slider = () => screen.getByLabelText('See-through white');
  const adjust = (actionName: 'increment' | 'decrement') =>
    act(async () => {
      fireEvent(slider(), 'accessibilityAction', { nativeEvent: { actionName } });
    });

  it('sits under PDF maps as a 5-stop slider, Off by default', async () => {
    await renderMenu();
    expect(screen.getByText('See-through white')).toBeTruthy();
    expect(slider().props.accessibilityRole).toBe('adjustable');
    expect(slider().props.accessibilityValue).toEqual({ min: 0, max: 4, now: 0, text: 'Off' });
  });

  it('steps through 25 / 50 / 75 / 100 %, each setting the global level', async () => {
    await renderMenu();
    const seen: string[] = [];
    for (const expected of [1, 2, 3, 4]) {
      await adjust('increment');
      expect(useSettingsStore.getState().pdfWhiteKey).toBe(expected);
      seen.push(String(slider().props.accessibilityValue.text));
    }
    expect(seen).toEqual(['25 %', '50 %', '75 %', '100 %']);
    expect(screen.getByText('100 %')).toBeTruthy();
    // Clamped at Full.
    await adjust('increment');
    expect(useSettingsStore.getState().pdfWhiteKey).toBe(4);
  });

  it('steps back down to Off and leaves the 3D relief Off alone', async () => {
    useSettingsStore.setState({ pdfWhiteKey: 1, tiltRelief: 'natural' });
    await renderMenu();
    expect(slider().props.accessibilityValue).toMatchObject({ now: 1, text: '25 %' });
    await adjust('decrement');
    expect(useSettingsStore.getState().pdfWhiteKey).toBe(0);
    expect(slider().props.accessibilityValue).toMatchObject({ now: 0, text: 'Off' });
    expect(useSettingsStore.getState().tiltRelief).toBe('natural');
    // The 3D relief segment owns the plain 'Off' name.
    expect(screen.getByLabelText('Off')).toBeTruthy();
  });

  it('rests while PDF maps are hidden', async () => {
    useSettingsStore.setState({ showPdfOverlay: false, pdfWhiteKey: 2 });
    await renderMenu();
    expect(screen.getByText('Needs PDF maps')).toBeTruthy();
    expect(slider().props.accessibilityState).toMatchObject({ disabled: true });
    await adjust('increment');
    expect(useSettingsStore.getState().pdfWhiteKey).toBe(2);
  });
});

describe('Live layers', () => {
  describe('with weather and marine parked', () => {
    it('keeps both rows visible, greyed and labelled "Coming soon"', async () => {
      await renderMenu();
      // Visible, not removed — the row is the only place the user is told
      // this is deliberate rather than broken.
      const weather = screen.getByLabelText('Weather (coming soon)');
      const marine = screen.getByLabelText('Marine (coming soon)');
      expect(weather.props.accessibilityState).toMatchObject({ disabled: true });
      // The marine row must not advertise a chart mode the map is not drawing.
      expect(marine.props.accessibilityState).toMatchObject({ disabled: true, checked: false });
      expect(screen.getByText('Weather')).toBeTruthy();
      expect(screen.getByText('Marine')).toBeTruthy();
      expect(screen.getAllByText('Coming soon')).toHaveLength(2);
    });

    it('does not open the weather list when the row is pressed', async () => {
      await renderMenu();
      fireEvent.press(screen.getByLabelText('Weather (coming soon)'));
      expect(await screen.findByLabelText('Weather (coming soon)')).toBeTruthy();
      expect(screen.queryByLabelText('Back to overlays')).toBeNull();
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

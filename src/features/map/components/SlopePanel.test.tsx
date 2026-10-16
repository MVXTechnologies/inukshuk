import { IMPERIAL, METRIC } from '@core/format/units';
import { DEFAULT_SLOPE_FILTER } from '@core/map/slopeSettings';
import { useSettingsStore } from '@state/settingsStore';
import { useTerrainAreaStore } from '@state/terrainAreaStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { darkTheme, lightTheme } from '@ui/theme';
import { PaperProvider } from 'react-native-paper';
import { AspectRose, SlopeLegendChip, SlopeRow, SlopeSubPanel } from './SlopePanel';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: async () => null }));

/** #723 — Map layers › Terrain › Slope: its row, its page, and the map's legend chip. */
const NBSP = ' ';
const NNW = (1 << 7) | (1 << 0) | (1 << 1);
const noop = (): void => undefined;

async function show(ui: React.ReactElement, dark = false) {
  await render(<PaperProvider theme={dark ? darkTheme : lightTheme}>{ui}</PaperProvider>);
}

const filter = () => useSettingsStore.getState().terrainSlopeFilter;
const a11yAction = (label: string, actionName: 'increment' | 'decrement') =>
  fireEvent(screen.getByLabelText(label), 'accessibilityAction', { nativeEvent: { actionName } });

beforeEach(() => {
  useSettingsStore.setState({
    terrainSlope: true,
    terrainSlopeMinDeg: 27,
    terrainSlopeMaxDeg: 90,
    terrainSlopeFilter: DEFAULT_SLOPE_FILTER,
    units: METRIC,
  });
  useTerrainAreaStore.setState({ elevationRange: { minM: 312, maxM: 1154 } });
});

describe('Slope row (mockup B1)', () => {
  it('hints the whole selection, and opens its page from the round chevron', async () => {
    const onOpen = jest.fn();
    await show(<SlopeRow onOpen={onOpen} onSlopeEnabled={noop} />);
    expect(screen.getByText('All aspects · 27–90°')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Options for slope'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('summarises aspect, steepness and altitude: "NW · N · NE · 30–90° · 800 m+"', async () => {
    useSettingsStore.setState({
      terrainSlopeMinDeg: 30,
      terrainSlopeFilter: { aspectMask: NNW, minAltM: 800, maxAltM: null },
    });
    await show(<SlopeRow onOpen={noop} onSlopeEnabled={noop} />);
    expect(screen.getByText('NW · N · NE · 30–90° · 800 m+')).toBeTruthy();
  });

  it('keeps its switch: off → on fires the one-time disclaimer hook', async () => {
    useSettingsStore.setState({ terrainSlope: false });
    const onSlopeEnabled = jest.fn();
    await show(<SlopeRow onOpen={noop} onSlopeEnabled={onSlopeEnabled} />);
    await fireEvent.press(screen.getByLabelText('Slope'));
    expect(useSettingsStore.getState().terrainSlope).toBe(true);
    expect(onSlopeEnabled).toHaveBeenCalledTimes(1);
  });
});

describe('Aspect rose', () => {
  it('toggles a petal; the hub toggles all and none', async () => {
    let mask = 0xff;
    const onChange = jest.fn((m: number) => (mask = m));
    const { rerender } = await render(
      <PaperProvider theme={lightTheme}>
        <AspectRose mask={mask} onChange={onChange} />
      </PaperProvider>,
    );
    expect(screen.getByLabelText('NW').props.accessibilityState).toEqual({ checked: true });
    await fireEvent.press(screen.getByLabelText('S'));
    expect(onChange).toHaveBeenLastCalledWith(0xff & ~(1 << 4));
    await rerender(
      <PaperProvider theme={lightTheme}>
        <AspectRose mask={mask} onChange={onChange} />
      </PaperProvider>,
    );
    expect(screen.getByLabelText('S').props.accessibilityState).toEqual({ checked: false });
    expect(screen.getByLabelText('All aspects').props.accessibilityState).toEqual({
      checked: false,
    });
    await fireEvent.press(screen.getByLabelText('All aspects'));
    expect(onChange).toHaveBeenLastCalledWith(0xff);
    await rerender(
      <PaperProvider theme={lightTheme}>
        <AspectRose mask={0xff} onChange={onChange} />
      </PaperProvider>,
    );
    await fireEvent.press(screen.getByLabelText('All aspects'));
    expect(onChange).toHaveBeenLastCalledWith(0);
  });
});

describe('Slope page (mockup B2)', () => {
  it('petals write the persisted filter, and the caption follows', async () => {
    await show(<SlopeSubPanel onBack={noop} />);
    expect(screen.getByTestId('aspect-selection').props.children).toBe('All aspects');
    await fireEvent.press(screen.getByLabelText('All aspects'));
    for (const s of ['NW', 'N', 'NE']) await fireEvent.press(screen.getByLabelText(s));
    expect(filter().aspectMask).toBe(NNW);
    expect(screen.getByTestId('aspect-selection').props.children).toBe('NW · N · NE');
  });

  it('the steepness slider drives the slope window', async () => {
    await show(<SlopeSubPanel onBack={noop} />);
    expect(screen.getByText('27–90°')).toBeTruthy();
    await a11yAction('Slope minimum', 'increment');
    expect(useSettingsStore.getState().terrainSlopeMinDeg).toBe(28);
  });

  it('altitude: 0 → highest ground rounded up to 500 m, the top open ("+"), stored in metres', async () => {
    await show(<SlopeSubPanel onBack={noop} />);
    expect(screen.getByText(`1${NBSP}500 m+`)).toBeTruthy(); // the scale's end label
    // No filter: the whole scale reads as such, and the hint/legend say nothing of altitude.
    expect(screen.getByText('Any altitude')).toBeTruthy();
    expect(screen.queryByText('0 m+')).toBeNull();
    await a11yAction('Altitude minimum', 'increment');
    expect(filter()).toEqual({ aspectMask: 0xff, minAltM: 10, maxAltM: null });
    expect(screen.getByText('10 m+')).toBeTruthy();
    await a11yAction('Altitude maximum', 'decrement');
    expect(filter()).toEqual({ aspectMask: 0xff, minAltM: 10, maxAltM: 1490 });
    expect(screen.getByText(`10–1${NBSP}490 m`)).toBeTruthy();
    // Back to the top end: "and above" again (no upper limit).
    await a11yAction('Altitude maximum', 'increment');
    expect(filter().maxAltM).toBeNull();
  });

  it('"+" extends the scale by 500 m per tap; the open top stays open', async () => {
    await show(<SlopeSubPanel onBack={noop} />);
    await fireEvent.press(screen.getByLabelText('Extend altitude range'));
    expect(screen.getByText(`2${NBSP}000 m+`)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Extend altitude range'));
    expect(screen.getByText(`2${NBSP}500 m+`)).toBeTruthy();
    expect(filter().maxAltM).toBeNull();
    // A bound set out there: Reset brings the area's own scale back.
    await a11yAction('Altitude maximum', 'decrement');
    expect(filter().maxAltM).toBe(2490);
    await fireEvent.press(screen.getByLabelText('Reset slope options'));
    expect(screen.getByText(`1${NBSP}500 m+`)).toBeTruthy();
  });

  it('respects feet: 1 500 ft chunks, 50 ft steps, metres stored', async () => {
    useSettingsStore.setState({ units: IMPERIAL });
    await show(<SlopeSubPanel onBack={noop} />);
    expect(screen.getByText(`4${NBSP}500 ft+`)).toBeTruthy(); // 1 154 m = 3 786 ft
    await a11yAction('Altitude minimum', 'increment');
    expect(filter().minAltM).toBe(15.2); // 50 ft
    await fireEvent.press(screen.getByLabelText('Extend altitude range'));
    expect(screen.getByText(`6${NBSP}000 ft+`)).toBeTruthy();
  });

  it('Reset puts steepness, aspects and altitude back; quiet when nothing to reset', async () => {
    await show(<SlopeSubPanel onBack={noop} />);
    expect(screen.getByLabelText('Reset slope options').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await act(async () =>
      useSettingsStore.setState({
        terrainSlopeMinDeg: 35,
        terrainSlopeFilter: { aspectMask: NNW, minAltM: 800, maxAltM: 1150 },
      }),
    );
    expect(screen.getByLabelText('Reset slope options').props.accessibilityState).toMatchObject({
      disabled: false,
    });
    await fireEvent.press(screen.getByLabelText('Reset slope options'));
    const s = useSettingsStore.getState();
    expect([s.terrainSlopeMinDeg, s.terrainSlopeMaxDeg]).toEqual([27, 90]);
    expect(s.terrainSlopeFilter).toEqual(DEFAULT_SLOPE_FILTER);
  });

  it('renders in the dark theme too', async () => {
    await show(<SlopeSubPanel onBack={noop} />, true);
    expect(screen.getByLabelText('Back to overlays')).toBeTruthy();
    expect(screen.getByLabelText('NW')).toBeTruthy();
  });
});

describe('Slope legend chip (mockup B3/B4 option 2)', () => {
  it('is hidden with no filter or with slope off', async () => {
    await show(<SlopeLegendChip onPress={noop} />);
    expect(screen.queryByTestId('slope-legend')).toBeNull();
    useSettingsStore.setState({
      terrainSlope: false,
      terrainSlopeFilter: { aspectMask: NNW, minAltM: null, maxAltM: null },
    });
    await show(<SlopeLegendChip onPress={noop} />);
    expect(screen.queryByTestId('slope-legend')).toBeNull();
  });

  it('shows the selection with a mini rose and opens the Slope page', async () => {
    useSettingsStore.setState({
      terrainSlopeMinDeg: 30,
      terrainSlopeFilter: { aspectMask: NNW, minAltM: 800, maxAltM: null },
    });
    const onPress = jest.fn();
    await show(<SlopeLegendChip onPress={onPress} />);
    expect(screen.getByText('NW · N · NE')).toBeTruthy();
    expect(screen.getByText('≥30° · 800 m+')).toBeTruthy();
    const chip = screen.getByLabelText('Slope filter: NW · N · NE, ≥30° · 800 m+');
    await fireEvent.press(chip);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('an altitude-only filter shows it too', async () => {
    useSettingsStore.setState({
      terrainSlopeFilter: { aspectMask: 0xff, minAltM: null, maxAltM: 1150 },
    });
    await show(<SlopeLegendChip onPress={noop} />, true);
    expect(screen.getByText(`≥27° · 0–1${NBSP}150 m`)).toBeTruthy();
  });
});

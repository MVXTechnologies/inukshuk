import { useMapStore } from '@state/mapStore';
import { useScreenSheetStore } from '@state/screenSheetStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { darkTheme, lightTheme } from '@ui/theme';
import { schemeTokens } from '@ui/tokens';
import { AccessibilityInfo, BackHandler, StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { WaypointScreenReaderList, type ListedPin } from './WaypointScreenReaderList';

const HERE = { latitude: 46.8139, longitude: -71.2082 };
const M_PER_DEG = 111_195;
/** `dn` m north, `de` m east of HERE. */
const pin = (id: string, label: string, dn: number, de: number): ListedPin => ({
  source: 'saved',
  id,
  label,
  latitude: HERE.latitude + dn / M_PER_DEG,
  longitude: HERE.longitude + de / (M_PER_DEG * Math.cos((HERE.latitude * Math.PI) / 180)),
});
const PINS = [
  pin('far', 'Sommet', 900, 0),
  pin('near', 'Camp lac', 0, 120),
  pin('mid', 'Pont', -400, 0),
];

type Listener = (on: boolean) => void;
let srListeners: Listener[] = [];
let backHandlers: (() => boolean)[] = [];

function mockScreenReader(on: boolean) {
  jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(on);
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((
    _event: string,
    h: Listener,
  ) => {
    srListeners.push(h);
    return { remove: () => (srListeners = srListeners.filter((x) => x !== h)) };
  }) as unknown as typeof AccessibilityInfo.addEventListener);
}

beforeEach(() => {
  srListeners = [];
  backHandlers = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, h) => {
    backHandlers.push(h as () => boolean);
    return { remove: () => (backHandlers = backHandlers.filter((x) => x !== h)) };
  });
  useMapStore.setState({ mapCenter: null });
  useScreenSheetStore.setState({ open: 0 });
});
afterEach(() => jest.restoreAllMocks());

async function setup({
  on = true,
  here = HERE as typeof HERE | null,
  available = true,
  dark = false,
  pins = PINS,
} = {}) {
  mockScreenReader(on);
  const onOpen = jest.fn();
  await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <WaypointScreenReaderList
        pins={pins}
        here={here}
        units="metric"
        onOpen={onOpen}
        available={available}
        screenFocused
        top={100}
      />
    </PaperProvider>,
  );
  // Let the isScreenReaderEnabled promise settle.
  await act(async () => undefined);
  return { onOpen };
}

const button = () => screen.queryByLabelText(/^Waypoints on the map \(\d+\)$/);
const rowLabels = () =>
  screen
    .getAllByRole('button')
    .map((b) => b.props.accessibilityLabel as string)
    .filter((l) => !l.startsWith('Close'));

describe('WaypointScreenReaderList', () => {
  it('draws nothing without a screen reader', async () => {
    await setup({ on: false });
    expect(button()).toBeNull();
    expect(screen.queryByTestId('waypoint-a11y-list-button')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers "Waypoints on the map (N)" as a button while a screen reader is on', async () => {
    await setup();
    const b = button();
    expect(b).not.toBeNull();
    expect(b?.props.accessibilityLabel).toBe('Waypoints on the map (3)');
    expect(b?.props.accessibilityRole).toBe('button');
  });

  it('appears and goes as the screen reader is switched on and off', async () => {
    await setup({ on: false });
    expect(button()).toBeNull();
    await act(async () => srListeners.forEach((l) => l(true)));
    expect(button()).not.toBeNull();
    await act(async () => srListeners.forEach((l) => l(false)));
    expect(button()).toBeNull();
  });

  it('steps aside while another mode owns the map', async () => {
    await setup({ available: false });
    expect(button()).toBeNull();
  });

  it('lists the pins nearest first from you, with distance and direction', async () => {
    await setup();
    await fireEvent.press(button()!);
    expect(screen.getByText('Nearest first, from you.')).toBeOnTheScreen();
    expect(rowLabels()).toEqual([
      'Camp lac, 120 m east',
      'Pont, 400 m south',
      'Sommet, 900 m north',
    ]);
    expect(screen.getByText('Waypoints on the map').props.accessibilityRole).toBe('header');
  });

  it('measures from the map centre before a fix', async () => {
    useMapStore.setState({ mapCenter: pin('c', 'c', 900, 0) });
    await setup({ here: null });
    await fireEvent.press(button()!);
    expect(screen.getByText('Nearest first, from the map centre.')).toBeOnTheScreen();
    expect(rowLabels()[0]).toBe('Sommet, here');
  });

  it('opens the card of the chosen pin and closes the list', async () => {
    const { onOpen } = await setup();
    await fireEvent.press(button()!);
    await fireEvent.press(screen.getByLabelText('Pont, 400 m south'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'mid', source: 'saved' }));
    expect(screen.queryByTestId('waypoint-a11y-list')).toBeNull();
    expect(button()).not.toBeNull();
  });

  it('closes on Back and on its close button, and hides the tab bar while open', async () => {
    await setup();
    expect(backHandlers).toHaveLength(0);
    await fireEvent.press(button()!);
    expect(backHandlers).toHaveLength(1);
    expect(useScreenSheetStore.getState().open).toBe(1);
    await act(async () => {
      backHandlers[0]?.();
    });
    expect(screen.queryByTestId('waypoint-a11y-list')).toBeNull();
    expect(useScreenSheetStore.getState().open).toBe(0);
    await fireEvent.press(button()!);
    await fireEvent.press(screen.getAllByLabelText('Close waypoint list')[0]!);
    expect(screen.queryByTestId('waypoint-a11y-list')).toBeNull();
  });

  it('says so when there are no pins', async () => {
    await setup({ pins: [] });
    expect(button()?.props.accessibilityLabel).toBe('Waypoints on the map (0)');
    await fireEvent.press(button()!);
    expect(screen.getByText('No waypoints on the map.')).toBeOnTheScreen();
  });

  it.each([
    ['light', false],
    ['dark', true],
  ])('paints the sheet with the %s surface', async (_name, dark) => {
    await setup({ dark });
    await fireEvent.press(button()!);
    const sheet = screen.getByTestId('waypoint-a11y-list-sheet');
    const bg = (StyleSheet.flatten(sheet.props.style) as { backgroundColor?: string })
      .backgroundColor;
    expect(bg).toBe(schemeTokens(dark).surface);
  });
});

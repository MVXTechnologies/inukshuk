import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { darkTheme, lightTheme } from '@ui/theme';
import { AccessibilityInfo } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { PointChipScreenReaderActions } from './PointChipScreenReaderActions';

type Listener = (on: boolean) => void;
let listeners: Listener[] = [];

function mockScreenReader(on: boolean) {
  jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(on);
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((
    _e: string,
    h: Listener,
  ) => {
    listeners.push(h);
    return { remove: () => (listeners = listeners.filter((x) => x !== h)) };
  }) as unknown as typeof AccessibilityInfo.addEventListener);
}

beforeEach(() => {
  listeners = [];
});
afterEach(() => jest.restoreAllMocks());

async function setup(on: boolean, dark = false) {
  mockScreenReader(on);
  const onAction = jest.fn();
  const onClose = jest.fn();
  await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <PointChipScreenReaderActions
        label="Point 46.81390, -71.20820, 120 m, 042° NE"
        top={120}
        onAction={onAction}
        onClose={onClose}
      />
    </PaperProvider>,
  );
  await act(async () => undefined);
  return { onAction, onClose };
}

describe('PointChipScreenReaderActions', () => {
  it('draws nothing for sighted users', async () => {
    await setup(false);
    expect(screen.queryByTestId('point-chip-a11y')).toBeNull();
  });

  it('reads the point and offers every chip action as a labelled button', async () => {
    const { onAction, onClose } = await setup(true);
    expect(screen.getByText('Point 46.81390, -71.20820, 120 m, 042° NE')).toBeOnTheScreen();
    expect(screen.getByTestId('point-chip-a11y').props.accessibilityLiveRegion).toBe('polite');
    await fireEvent.press(screen.getByLabelText('Navigate to coordinates'));
    await fireEvent.press(screen.getByLabelText('Add waypoint here'));
    await fireEvent.press(screen.getByLabelText('Convert coordinates'));
    await fireEvent.press(screen.getByLabelText('Copy coordinates'));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([
      'navigate',
      'waypoint',
      'convert',
      'copy',
    ]);
    await fireEvent.press(screen.getByLabelText('Close point'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('appears when the screen reader is turned on', async () => {
    await setup(false);
    await act(async () => listeners.forEach((l) => l(true)));
    expect(screen.getByTestId('point-chip-a11y')).toBeOnTheScreen();
  });

  it('renders in the dark theme too', async () => {
    await setup(true, true);
    expect(screen.getByTestId('point-chip-a11y')).toBeOnTheScreen();
  });
});

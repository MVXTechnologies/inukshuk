import { fireEvent, render, screen } from '@testing-library/react-native';
import { useSettingsStore } from '@state/settingsStore';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DisplaySheet } from './DisplaySheet';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

async function renderSheet() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <PaperProvider>
        <DisplaySheet visible onDismiss={jest.fn()} />
      </PaperProvider>
    </SafeAreaProvider>,
  );
}

describe('DisplaySheet (decision 4)', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      displayCondition: 'normal',
      autoNightAtSunset: false,
      sunlightWhileRecording: false,
      lastKnownPosition: null,
    });
  });

  it('shows Normal selected by default, with the opt-in note', async () => {
    await renderSheet();
    expect(screen.getByText('Sunlight and Night are opt-in. Normal is the default.')).toBeTruthy();
    expect(screen.getByLabelText('Normal, Paper & stone').props.accessibilityState).toMatchObject({
      selected: true,
    });
  });

  it('switches the chosen mode from a card', async () => {
    await renderSheet();
    await fireEvent.press(screen.getByLabelText('Night, Red only'));
    expect(useSettingsStore.getState().displayCondition).toBe('night');
    await fireEvent.press(screen.getByLabelText('Sunlight, Max contrast'));
    expect(useSettingsStore.getState().displayCondition).toBe('sunlight');
  });

  it('turns the opt-in toggles on', async () => {
    await renderSheet();
    await fireEvent(screen.getByLabelText('Auto night at sunset'), 'valueChange', true);
    await fireEvent(screen.getByLabelText('Sunlight while recording'), 'valueChange', true);
    expect(useSettingsStore.getState().autoNightAtSunset).toBe(true);
    expect(useSettingsStore.getState().sunlightWhileRecording).toBe(true);
  });

  it('says when auto night starts without a known position', async () => {
    await renderSheet();
    expect(screen.getByText('After sunset, off at sunrise')).toBeTruthy();
  });
});

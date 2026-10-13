/** Settings › Display › "Show phone navigation buttons" (#682): Android only, toggles the store. */
import { useSettingsStore } from '@state/settingsStore';
import { darkTheme, lightTheme } from '@ui/theme';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { NavigationButtonsSetting } from './NavigationButtonsSetting';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

beforeAll(async () => {
  await useSettingsStore.getState().hydrate();
});

afterEach(() => {
  useSettingsStore.getState().reset();
  jest.restoreAllMocks();
});

const LABEL = 'Show phone navigation buttons';

function renderRow(theme = lightTheme) {
  return render(
    <PaperProvider theme={theme}>
      <NavigationButtonsSetting />
    </PaperProvider>,
  );
}

// With Platform.OS swapped to android, RN draws its AndroidSwitch, whose
// host props carry the state as `on` (not `value`).
function switchValue(): unknown {
  return screen.getByLabelText(LABEL).props.on;
}

describe('on Android', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'android');
  });

  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ])('shows the row, off by default (%s theme)', async (_name, theme) => {
    await renderRow(theme);
    expect(screen.getByText(LABEL)).toBeTruthy();
    expect(switchValue()).toBe(false);
  });

  it('toggles the setting on and back off', async () => {
    await renderRow();
    await fireEvent(screen.getByLabelText(LABEL), 'valueChange', true);
    expect(useSettingsStore.getState().showNavigationButtons).toBe(true);
    expect(switchValue()).toBe(true);
    await fireEvent(screen.getByLabelText(LABEL), 'valueChange', false);
    expect(useSettingsStore.getState().showNavigationButtons).toBe(false);
  });
});

describe('on iOS', () => {
  it('draws nothing', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    await renderRow();
    expect(screen.queryByText(LABEL)).toBeNull();
    expect(screen.queryByLabelText(LABEL)).toBeNull();
  });
});

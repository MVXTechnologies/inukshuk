import { render, screen, fireEvent } from '@testing-library/react-native';
import { Keyboard } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { KeyboardDoneBar, KEYBOARD_DONE_BAR_ID } from './KeyboardDoneBar';

/**
 * #235 — the bar IS the fix, so its two contract points are worth pinning:
 * it exists on iOS (with a Done that blurs) and it does not exist on Android,
 * where the platform's own back gesture already dismisses and an extra bar
 * would be foreign chrome.
 */

// jest-expo's default platform is ios, so the on-platform case needs no mock.
describe('KeyboardDoneBar on iOS', () => {
  it('renders a Done control that dismisses the keyboard', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    await render(
      <PaperProvider>
        <KeyboardDoneBar />
      </PaperProvider>,
    );
    // Reads "Done"; announced as "Hide keyboard" so it never collides with
    // the waypoint dialog's own "Done" save button (waypoint.yaml taps that
    // one on iOS with the keyboard still up).
    expect(await screen.findByText('Done')).toBeOnTheScreen();
    fireEvent.press(screen.getByLabelText('Hide keyboard'));
    expect(dismiss).toHaveBeenCalled();
    dismiss.mockRestore();
  });

  it('exposes a stable accessory id for fields to point at', () => {
    expect(KEYBOARD_DONE_BAR_ID).toBe('inukshuk-keyboard-done');
  });
});

/**
 * Re-import the component against a mocked `Platform.OS` — the same
 * `isolateModules` + `doMock` shape `settingsStore.hillshade.test.ts` uses.
 * Only the react-native surface the module actually touches is stubbed.
 */
function renderFor(os: 'ios' | 'android'): unknown {
  let tree: unknown = 'not rendered';
  jest.isolateModules(() => {
    // Stubbed rather than spread from the real module: spreading react-native
    // eagerly evaluates its lazy getters, which reach for native TurboModules
    // that do not exist under jest. The module only ever touches these five.
    jest.doMock('react-native', () => ({
      Platform: { OS: os },
      StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
      InputAccessoryView: 'InputAccessoryView',
      View: 'View',
      Keyboard: { dismiss: jest.fn() },
    }));
    jest.doMock('react-native-paper', () => ({
      Button: 'Button',
      useTheme: () => ({ colors: { elevation: { level2: '#222' }, outlineVariant: '#333' } }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./KeyboardDoneBar') as typeof import('./KeyboardDoneBar');
    // Called as a plain function: we only care whether it produces an element
    // tree at all, and that keeps the assertion free of a renderer + theme.
    tree = mod.KeyboardDoneBar();
  });
  return tree;
}

it('renders nothing on Android', () => {
  expect(renderFor('android')).toBeNull();
  expect(renderFor('ios')).not.toBeNull();
});

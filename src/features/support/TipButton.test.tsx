/**
 * The Map's tip button (#476, round 3): five swappable looks, one set of
 * rules. Real timers with a short test period (fake timers leave this
 * renderer's scheduler on the wrong clock between renders); the 15 s period
 * itself is pinned in `@core/support/tipJar`.
 */
import {
  DEFAULT_TIP_BUTTON_VARIANT,
  TIP_BUTTON_VARIANTS,
  TIP_JAR_REST_MS,
} from '@core/support/tipJar';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSupportStore } from '@state/supportStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { useReducedMotion } from 'react-native-reanimated';

import { TipButton } from './TipButton';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: jest.fn(async () => null) }));

const PERIOD = 25;
const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

beforeEach(() => {
  useSettingsStore.setState({ showTipJar: true, tipJarRestingUntil: 0 });
  useSupportStore.setState({ tipCount: 0, totalCents: 0 });
  useRecorderStore.setState({ status: 'idle' });
  jest.mocked(useReducedMotion).mockReturnValue(false);
});

async function mount(props: Partial<Parameters<typeof TipButton>[0]> = {}) {
  return render(
    <PaperProvider>
      <TipButton intervalMs={PERIOD} {...props} />
    </PaperProvider>,
  );
}

it('defaults to the coffee mug the owner picked, with its steam heart', async () => {
  await mount();
  expect(DEFAULT_TIP_BUTTON_VARIANT).toBe('coffeeSteam');
  expect(screen.getByTestId('tip-button-coffeeSteam')).toBeTruthy();
  expect(screen.getByTestId('tip-steam-heart')).toBeTruthy();
});

it('holds the animation while the map is being panned or zoomed', async () => {
  const onAnimate = jest.fn();
  const view = await mount({ onAnimate, paused: true });
  await wait(PERIOD * 4);
  expect(onAnimate).not.toHaveBeenCalled();
  expect(screen.getByTestId('tip-button-coffeeSteam')).toBeTruthy();
  view.unmount();
});

it('holds the animation while the app is in the background, and resumes after', async () => {
  let listener: ((state: string) => void) | undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementationOnce((_type, l) => {
    listener = l as (state: string) => void;
    return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
  });
  const onAnimate = jest.fn();
  const view = await mount({ onAnimate });
  await act(async () => {
    listener?.('background');
  });
  onAnimate.mockClear();
  await wait(PERIOD * 4);
  expect(onAnimate).not.toHaveBeenCalled();
  await act(async () => {
    listener?.('active');
  });
  await wait(PERIOD * 4);
  expect(onAnimate).toHaveBeenCalled();
  view.unmount();
});

it.each(TIP_BUTTON_VARIANTS)(
  '%s renders, opens the tips and animates on its period',
  async (variant) => {
    const onAnimate = jest.fn();
    const view = await mount({ variant, onAnimate });
    await wait(PERIOD * 4);
    expect(onAnimate.mock.calls.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      fireEvent.press(screen.getByTestId(`tip-button-${variant}`));
    });
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/support', params: { from: 'jar' } });
    view.unmount();
  },
);

it.each(TIP_BUTTON_VARIANTS)('%s stays still with reduce motion on', async (variant) => {
  jest.mocked(useReducedMotion).mockReturnValue(true);
  const onAnimate = jest.fn();
  const view = await mount({ variant, onAnimate });
  await wait(PERIOD * 4);
  expect(onAnimate).not.toHaveBeenCalled();
  expect(screen.getByTestId(`tip-button-${variant}`)).toBeTruthy();
  view.unmount();
});

it('stays still for someone who has tipped before', async () => {
  useSupportStore.setState({ tipCount: 1, totalCents: 299 });
  const onAnimate = jest.fn();
  const view = await mount({ onAnimate });
  await wait(PERIOD * 4);
  expect(onAnimate).not.toHaveBeenCalled();
  view.unmount();
});

it.each([
  ['switched off in Settings', () => useSettingsStore.setState({ showTipJar: false }), {}],
  ['recording', () => useRecorderStore.setState({ status: 'recording' }), {}],
  ['following a destination', () => undefined, { navigating: true }],
  ['the corner is taken', () => undefined, { blocked: true }],
  [
    'resting for 12 months after a tip or a verified donation',
    () => useSettingsStore.setState({ tipJarRestingUntil: Date.now() + TIP_JAR_REST_MS }),
    {},
  ],
])('is hidden when %s', async (_label, arrange, props) => {
  arrange();
  const view = await mount(props);
  expect(screen.queryByTestId(`tip-button-${DEFAULT_TIP_BUTTON_VARIANT}`)).toBeNull();
  view.unmount();
});

it('comes back once the rest is over', async () => {
  useSettingsStore.setState({ tipJarRestingUntil: Date.now() - 1 });
  const view = await mount();
  expect(screen.getByTestId(`tip-button-${DEFAULT_TIP_BUTTON_VARIANT}`)).toBeTruthy();
  view.unmount();
});

it('long-press offers Hide, which turns the setting off', async () => {
  const view = await mount();
  await act(async () => {
    fireEvent(screen.getByTestId(`tip-button-${DEFAULT_TIP_BUTTON_VARIANT}`), 'longPress');
  });
  await act(async () => {
    fireEvent.press(screen.getByText('Hide tip button'));
  });
  expect(useSettingsStore.getState().showTipJar).toBe(false);
  view.unmount();
});

/**
 * The Map's tip button (#476): five swappable looks, one set of rules. The
 * loop runs on the UI thread (Reanimated `withRepeat`); `onAnimate` reports
 * each time that loop is (re)started, so these tests pin WHEN it runs and
 * what never stops it. The 12 s period itself is pinned in
 * `@core/support/tipJar`.
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
// The stock Reanimated mock hands out a NEW shared value on every render; the
// real hook returns the same one. Here it is stable like the real thing, so
// "a re-render does not restart the loop" is tested for what it is.
jest.mock('react-native-reanimated', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const mock = require('react-native-reanimated/mock');
  const { useState } = require('react');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    __esModule: true,
    ...mock,
    useReducedMotion: jest.fn(() => false),
    cancelAnimation: jest.fn(),
    useSharedValue: (init: unknown) => {
      const [value] = useState(() => mock.useSharedValue(init));
      return value;
    },
  };
});

const PERIOD = 25;
const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

beforeEach(() => {
  useSettingsStore.setState({ showTipJar: true, tipJarRestingUntil: 0, tipJarHiddenUntil: 0 });
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

it('keeps animating while the map is being moved (owner: no gesture pause)', async () => {
  const onAnimate = jest.fn();
  const view = await mount({ onAnimate, gestureActive: true });
  expect(onAnimate).toHaveBeenCalledTimes(1);
  await view.unmount();
});

it('never stops or restarts the loop for map gestures, however many', async () => {
  const onAnimate = jest.fn();
  const as = (gestureActive: boolean) => (
    <PaperProvider>
      <TipButton intervalMs={PERIOD} onAnimate={onAnimate} gestureActive={gestureActive} />
    </PaperProvider>
  );
  const view = await render(as(false));
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await view.rerender(as(i % 2 === 0));
    });
  }
  // Started once on mount; pans, pinches and taps leave it alone.
  expect(onAnimate).toHaveBeenCalledTimes(1);
  await view.unmount();
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
  await view.unmount();
});

it.each(TIP_BUTTON_VARIANTS)(
  '%s renders, opens the tips and animates on its period',
  async (variant) => {
    const onAnimate = jest.fn();
    const view = await mount({ variant, onAnimate });
    expect(onAnimate).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.press(screen.getByTestId(`tip-button-${variant}`));
    });
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/support', params: { from: 'jar' } });
    await view.unmount();
  },
);

it.each(TIP_BUTTON_VARIANTS)('%s stays still with reduce motion on', async (variant) => {
  jest.mocked(useReducedMotion).mockReturnValue(true);
  const onAnimate = jest.fn();
  const view = await mount({ variant, onAnimate });
  await wait(PERIOD * 4);
  expect(onAnimate).not.toHaveBeenCalled();
  expect(screen.getByTestId(`tip-button-${variant}`)).toBeTruthy();
  await view.unmount();
});

it('stays still for someone who has tipped before', async () => {
  useSupportStore.setState({ tipCount: 1, totalCents: 299 });
  const onAnimate = jest.fn();
  const view = await mount({ onAnimate });
  await wait(PERIOD * 4);
  expect(onAnimate).not.toHaveBeenCalled();
  await view.unmount();
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
  await view.unmount();
});

it('comes back once the rest is over', async () => {
  useSettingsStore.setState({ tipJarRestingUntil: Date.now() - 1 });
  const view = await mount();
  expect(screen.getByTestId(`tip-button-${DEFAULT_TIP_BUTTON_VARIANT}`)).toBeTruthy();
  await view.unmount();
});

describe('long-press › "Hide for an hour" (injected clock)', () => {
  const MIN = 60_000;
  const T0 = 1_800_000_000_000;
  let mockNow = T0;
  const clock = () => mockNow;
  const RECHECK = 10;
  const ID = `tip-button-${DEFAULT_TIP_BUTTON_VARIANT}`;
  type View = Awaited<ReturnType<typeof render>>;
  const ui = (recheck = RECHECK) => (
    <PaperProvider>
      <TipButton intervalMs={PERIOD} clock={clock} hideRecheckMs={recheck} />
    </PaperProvider>
  );
  /** Move the wall clock and let the Map's recheck run. */
  const at = async (ms: number) => {
    mockNow = T0 + ms;
    await wait(RECHECK * 4);
  };
  async function hide(view: View) {
    await act(async () => {
      fireEvent(view.getByTestId(ID), 'longPress');
    });
    await act(async () => {
      fireEvent.press(view.getByText('Hide for an hour'));
    });
  }
  beforeEach(() => {
    mockNow = T0;
  });

  it('hides it, still hidden at 59 min, back at 60 min; the Settings switch untouched', async () => {
    const view = await render(ui());
    await hide(view);
    expect(view.queryByTestId(ID)).toBeNull();
    expect(useSettingsStore.getState()).toMatchObject({
      showTipJar: true,
      tipJarHiddenUntil: T0 + 60 * MIN,
    });
    await at(59 * MIN);
    expect(view.queryByTestId(ID)).toBeNull();
    await at(60 * MIN);
    expect(view.getByTestId(ID)).toBeTruthy();
    await view.unmount();
  });

  it('keeps counting across an app restart (wall clock, not time open)', async () => {
    const first = await render(ui());
    await hide(first);
    await first.unmount();
    // The app was closed; it is relaunched 30 min later, then 61 min later.
    mockNow = T0 + 30 * MIN;
    const second = await render(ui());
    expect(second.queryByTestId(ID)).toBeNull();
    await second.unmount();
    mockNow = T0 + 61 * MIN;
    const third = await render(ui());
    expect(third.getByTestId(ID)).toBeTruthy();
    await third.unmount();
  });

  it('comes back on return to the foreground once the hour is over', async () => {
    let listener: ((state: string) => void) | undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementationOnce((_type, l) => {
      listener = l as (state: string) => void;
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    // A recheck far too slow to matter: the foreground event alone brings it back.
    const view = await render(ui(10 * MIN));
    await hide(view);
    await act(async () => {
      listener?.('background');
    });
    mockNow = T0 + 65 * MIN;
    await act(async () => {
      listener?.('active');
    });
    expect(view.getByTestId(ID)).toBeTruthy();
    await view.unmount();
  });

  it('never overrides the Settings switch or the 12-month rest after a gift', async () => {
    useSettingsStore.setState({ showTipJar: false, tipJarHiddenUntil: T0 - 1 });
    const off = await render(ui());
    expect(off.queryByTestId(ID)).toBeNull();
    await off.unmount();
    useSettingsStore.setState({
      showTipJar: true,
      tipJarHiddenUntil: T0 - 1,
      tipJarRestingUntil: T0 + TIP_JAR_REST_MS,
    });
    const resting = await render(ui());
    await at(2 * 60 * MIN);
    expect(resting.queryByTestId(ID)).toBeNull();
    await resting.unmount();
  });
});

it('stops while the Map tab is not in front, and starts again when it is', async () => {
  const onAnimate = jest.fn();
  const as = (focused: boolean) => (
    <PaperProvider>
      <TipButton intervalMs={PERIOD} onAnimate={onAnimate} focused={focused} />
    </PaperProvider>
  );
  const view = await render(as(false));
  expect(onAnimate).not.toHaveBeenCalled();
  await act(async () => {
    await view.rerender(as(true));
  });
  expect(onAnimate).toHaveBeenCalledTimes(1);
  await view.unmount();
});

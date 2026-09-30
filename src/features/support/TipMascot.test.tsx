/**
 * The coffee mascot (#476, round 4): the tip button decides when a bubble is
 * due, the Map's bubble layer shows it. Real timers with a short check period
 * and an injected clock (fake timers leave this renderer's scheduler on the
 * wrong clock between renders); the schedule itself is pinned with fake
 * timers in `@core/support/tipJar.test.ts`.
 */
import { FUN_FACTS } from '@core/support/funFacts';
import { BUBBLE_FIRST_DELAY_MS, BUBBLE_INTERVAL_MS } from '@core/support/tipJar';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSupportStore } from '@state/supportStore';
import { useTipMascotStore } from '@state/tipMascotStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { useReducedMotion } from 'react-native-reanimated';

import { TipBubble } from './TipBubble';
import { TipButton } from './TipButton';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: jest.fn(async () => null) }));

const CHECK = 10;
const T0 = 5_000_000;
let mockNow = T0;
const clock = () => mockNow;

const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

type ButtonProps = Partial<Parameters<typeof TipButton>[0]>;

function ui(props: ButtonProps = {}, visibleMs = 60_000) {
  return (
    <PaperProvider>
      <TipButton intervalMs={100_000} bubbleCheckMs={CHECK} clock={clock} {...props} />
      <TipBubble right={16} bottom={80} tailRight={24} visibleMs={visibleMs} />
    </PaperProvider>
  );
}

async function mount(props: ButtonProps = {}, visibleMs?: number) {
  return render(ui(props, visibleMs));
}

/** Move the injected clock and let a few checks run. */
async function at(ms: number) {
  mockNow = T0 + ms;
  await wait(CHECK * 4);
}

beforeEach(() => {
  mockNow = T0;
  useTipMascotStore.setState({
    bubbleFact: null,
    lastFact: null,
    lastBubbleAt: null,
    snoozed: false,
  });
  useSettingsStore.setState({ showTipJar: true, tipJarRestingUntil: 0 });
  useSupportStore.setState({ tipCount: 0, totalCents: 0 });
  useRecorderStore.setState({ status: 'idle' });
  jest.mocked(useReducedMotion).mockReturnValue(false);
});

it('pops the first bubble two minutes after the Map opens, with a fun fact', async () => {
  const view = await mount();
  await at(BUBBLE_FIRST_DELAY_MS - 1_000);
  expect(screen.queryByTestId('tip-bubble')).toBeNull();
  await at(BUBBLE_FIRST_DELAY_MS);
  expect(screen.getByTestId('tip-bubble')).toBeTruthy();
  const fact = useTipMascotStore.getState().bubbleFact;
  expect(fact).not.toBeNull();
  expect(screen.getByText(FUN_FACTS[fact ?? 0]?.en ?? '')).toBeTruthy();
  // The mug's face is drawn while the bubble is up.
  expect(screen.getByTestId('tip-mascot-eyes')).toBeTruthy();
  expect(screen.getByTestId('tip-mascot-smile')).toBeTruthy();
  view.unmount();
});

it('shows at most one bubble a minute, never the same fact twice in a row', async () => {
  const view = await mount();
  await at(BUBBLE_FIRST_DELAY_MS);
  const first = useTipMascotStore.getState().bubbleFact;
  await act(async () => {
    useTipMascotStore.getState().hide();
  });
  await at(BUBBLE_FIRST_DELAY_MS + BUBBLE_INTERVAL_MS - 1_000);
  expect(useTipMascotStore.getState().bubbleFact).toBeNull();
  await at(BUBBLE_FIRST_DELAY_MS + BUBBLE_INTERVAL_MS);
  const second = useTipMascotStore.getState().bubbleFact;
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);
  view.unmount();
});

it.each<[string, () => void, ButtonProps]>([
  ['recording', () => useRecorderStore.setState({ status: 'recording' }), {}],
  ['following a destination', () => undefined, { navigating: true }],
  ['a sheet, menu or search is open', () => undefined, { bubbleBlocked: true }],
  ['the person is moving the map', () => undefined, { paused: true }],
  ['the Map tab is not in front', () => undefined, { focused: false }],
  ['switched off in Settings', () => useSettingsStore.setState({ showTipJar: false }), {}],
  [
    'resting after a gift',
    () => useSettingsStore.setState({ tipJarRestingUntil: T0 + 1_000_000_000 }),
    {},
  ],
  ['the person has tipped before', () => useSupportStore.setState({ tipCount: 1 }), {}],
])('never bubbles while %s', async (_label, arrange, props) => {
  arrange();
  const view = await mount(props);
  await at(BUBBLE_FIRST_DELAY_MS + 5 * BUBBLE_INTERVAL_MS);
  expect(screen.queryByTestId('tip-bubble')).toBeNull();
  view.unmount();
});

it('waits 5 s of calm after the person’s own map gesture', async () => {
  const view = await mount({ paused: true });
  await at(BUBBLE_FIRST_DELAY_MS + 10_000);
  await act(async () => {
    await view.rerender(ui({ paused: false }));
  });
  await at(BUBBLE_FIRST_DELAY_MS + 12_000);
  expect(screen.queryByTestId('tip-bubble')).toBeNull();
  await at(BUBBLE_FIRST_DELAY_MS + 15_000);
  expect(screen.getByTestId('tip-bubble')).toBeTruthy();
  view.unmount();
});

it('closes the bubble when a sheet opens over it', async () => {
  const view = await mount();
  await at(BUBBLE_FIRST_DELAY_MS);
  expect(screen.getByTestId('tip-bubble')).toBeTruthy();
  await act(async () => {
    await view.rerender(ui({ bubbleBlocked: true }));
  });
  expect(screen.queryByTestId('tip-bubble')).toBeNull();
  view.unmount();
});

it('(x) closes it and snoozes bubbles for the rest of the session', async () => {
  const view = await mount();
  await at(BUBBLE_FIRST_DELAY_MS);
  await act(async () => {
    fireEvent.press(screen.getByLabelText('Close'));
  });
  expect(screen.queryByTestId('tip-bubble')).toBeNull();
  await at(BUBBLE_FIRST_DELAY_MS + 10 * BUBBLE_INTERVAL_MS);
  expect(screen.queryByTestId('tip-bubble')).toBeNull();
  // The mug stays: only the bubbles are snoozed.
  expect(screen.getByTestId('tip-button-coffeeSteam')).toBeTruthy();
  view.unmount();
});

it('tapping the bubble opens Support at the tips', async () => {
  const view = await mount();
  await at(BUBBLE_FIRST_DELAY_MS);
  await act(async () => {
    fireEvent.press(screen.getByTestId('tip-bubble-open'));
  });
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/support', params: { from: 'jar' } });
  expect(screen.queryByTestId('tip-bubble')).toBeNull();
  view.unmount();
});

it('folds away on its own when left alone', async () => {
  const view = await mount({}, 30);
  await at(BUBBLE_FIRST_DELAY_MS);
  expect(useTipMascotStore.getState().bubbleFact).not.toBeNull();
  await wait(80);
  expect(screen.queryByTestId('tip-bubble')).toBeNull();
  view.unmount();
});

it('is readable by screen readers, with 44 dp targets', async () => {
  const view = await mount();
  await at(BUBBLE_FIRST_DELAY_MS);
  const fact = FUN_FACTS[useTipMascotStore.getState().bubbleFact ?? 0]?.en ?? '';
  expect(screen.getByLabelText(`${fact} Opens Support Inukshuk.`)).toBeTruthy();
  const close = screen.getByLabelText('Close');
  expect(close).toHaveStyle({ width: 44, height: 44 });
  view.unmount();
});

it('still appears with reduce motion on (without the face animation)', async () => {
  jest.mocked(useReducedMotion).mockReturnValue(true);
  const view = await mount();
  await at(BUBBLE_FIRST_DELAY_MS);
  expect(screen.getByTestId('tip-bubble')).toBeTruthy();
  view.unmount();
});

/**
 * The floating tip jar (#476): its wobble schedule and when it stays still.
 * The 15 s period itself is pinned in `@core/support/tipJar`; here the
 * component runs on a short period with real timers (fake timers leave this
 * renderer's scheduler on the wrong clock between renders).
 */
import { TIP_JAR_WOBBLE_INTERVAL_MS } from '@core/support/tipJar';
import { useSettingsStore } from '@state/settingsStore';
import { useSupportStore } from '@state/supportStore';
import { act, render } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { useReducedMotion } from 'react-native-reanimated';

import { TipJarButton } from './TipJarButton';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: jest.fn(async () => null) }));

const PERIOD = 25;
const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

beforeEach(() => {
  useSettingsStore.setState({ showTipJar: true });
  useSupportStore.setState({ tipCount: 0, totalCents: 0 });
  jest.mocked(useReducedMotion).mockReturnValue(false);
});

async function mountWith(onWobble: () => void) {
  return render(
    <PaperProvider>
      <TipJarButton onWobble={onWobble} intervalMs={PERIOD} />
    </PaperProvider>,
  );
}

it('defaults to one wobble every 15 s', () => {
  expect(TIP_JAR_WOBBLE_INTERVAL_MS).toBe(15_000);
});

it('wobbles on its period', async () => {
  const onWobble = jest.fn();
  const view = await mountWith(onWobble);
  await wait(PERIOD * 4);
  expect(onWobble.mock.calls.length).toBeGreaterThanOrEqual(2);
  view.unmount();
});

it.each([
  ['reduce motion is on', () => jest.mocked(useReducedMotion).mockReturnValue(true)],
  ['the person has tipped', () => useSupportStore.setState({ tipCount: 1, totalCents: 299 })],
])('stays still when %s, but still shows', async (_label, arrange) => {
  arrange();
  const onWobble = jest.fn();
  const view = await mountWith(onWobble);
  await wait(PERIOD * 4);
  expect(onWobble).not.toHaveBeenCalled();
  expect(view.getByTestId('tip-jar')).toBeTruthy();
  view.unmount();
});

it('stops the schedule when it unmounts', async () => {
  const onWobble = jest.fn();
  const view = await mountWith(onWobble);
  view.unmount();
  await wait(PERIOD * 4);
  expect(onWobble).not.toHaveBeenCalled();
});

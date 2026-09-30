/** Support Inukshuk (#476): costs, store prices, and every purchase outcome. */
import type { CostsDocument } from '@core/support/costs';
import type { StoreProduct } from '@core/support/tips';
import type { TipEvent, TipStore } from '@lib/iap';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useSupportStore } from '@state/supportStore';

import { SupportScreen } from './SupportScreen';
import { STORE_TIMEOUT_MS } from './useTipJar';

const mockReplace = jest.fn();
const mockBack = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, back: mockBack }),
  useLocalSearchParams: () => mockParams,
}));

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: jest.fn(async () => null) }));

let mockCosts: { doc: CostsDocument; fromCache: boolean } | null = null;
jest.mock('@data/supportCosts', () => ({
  loadSupportCosts: jest.fn(async () => mockCosts),
}));

const mockReport = jest.fn();
jest.mock('@lib/errorReporting', () => ({ reportError: (...a: unknown[]) => mockReport(...a) }));

let mockStore: TipStore | null = null;
jest.mock('@lib/iap', () => ({ getTipStore: () => mockStore }));

const COSTS: CostsDocument = {
  year: 2026,
  goals: [
    { id: 'keepUp', percent: 40 },
    { id: 'features', percent: 0 },
  ],
  supporters: 12,
  updated: '2026-09-30',
  donors: [],
};

const PRODUCTS: StoreProduct[] = [
  { id: 'tip_large', displayPrice: '19,99 $' },
  { id: 'tip_small', displayPrice: '3,99 $' },
  { id: 'tip_medium', displayPrice: '8,99 $' },
  { id: 'tip_patron', displayPrice: '139,99 $' },
  { id: 'tip_xlarge', displayPrice: '41,99 $' },
];

function fakeStore(overrides: Partial<TipStore> = {}) {
  let emit: ((e: TipEvent) => void) | null = null;
  const store: TipStore = {
    connect: jest.fn(async () => true),
    fetchTips: jest.fn(async () => PRODUCTS),
    requestTip: jest.fn(async () => undefined),
    subscribe: jest.fn((l: (e: TipEvent) => void) => {
      emit = l;
      return () => {
        emit = null;
      };
    }),
    sweepUnfinished: jest.fn(async () => []),
    disconnect: jest.fn(async () => undefined),
    ...overrides,
  };
  return {
    store,
    emit: (e: TipEvent) =>
      act(async () => {
        emit?.(e);
      }),
  };
}

async function mount() {
  const view = await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 400, height: 800 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>
        <SupportScreen />
      </PaperProvider>
    </SafeAreaProvider>,
  );
  // Let the connect → fetch chain and the costs load settle.
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
  return view;
}

async function press(node: Parameters<typeof fireEvent.press>[0]) {
  await act(async () => {
    fireEvent.press(node);
  });
}

beforeEach(() => {
  mockCosts = { doc: COSTS, fromCache: false };
  mockStore = null;
  mockParams = {};
  useSupportStore.setState({ totalCents: 0, tipCount: 0, transactionIds: [], hydrated: true });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('costs', () => {
  it('shows the active goal as a percentage, the supporters, and what donations pay for', async () => {
    mockStore = fakeStore().store;
    await mount();
    expect(screen.getByText('Free for everyone. Kept alive by donations.')).toBeTruthy();
    expect(
      within(screen.getByTestId('support-progress')).getByText('Keep the app up'),
    ).toBeTruthy();
    expect(screen.getByText('40% funded')).toBeTruthy();
    expect(screen.getByText('12 supporters · updated monthly')).toBeTruthy();
    expect(screen.getByRole('progressbar').props.accessibilityValue).toMatchObject({ now: 40 });
    expect(screen.queryByTestId('goal-funded-keepUp')).toBeNull();
    expect(screen.getByText('· Developer time')).toBeTruthy();
    expect(screen.getByText('· Map servers and data')).toBeTruthy();
  });

  it('never shows an amount of money in the progress or the list', async () => {
    mockStore = null;
    await mount();
    const progress = screen.getByTestId('support-progress');
    const list = screen.getByTestId('donations-pay-for');
    for (const node of [progress, list]) {
      expect(node).not.toHaveTextContent(/\$|€|USD|CAD/);
    }
    expect(list).not.toHaveTextContent(/\d/);
    expect(screen.queryByText(/Total per year|Where the money goes/)).toBeNull();
  });

  it('marks "Keep the app up" funded and moves the bar to new features', async () => {
    mockCosts = {
      doc: {
        ...COSTS,
        goals: [
          { id: 'keepUp', percent: 100 },
          { id: 'features', percent: 15 },
        ],
      },
      fromCache: false,
    };
    await mount();
    expect(screen.getByTestId('goal-funded-keepUp')).toHaveTextContent(
      /Keep the app up ✓ funded for 2026/,
    );
    expect(
      within(screen.getByTestId('support-progress')).getByText('Implement new features'),
    ).toBeTruthy();
    expect(screen.getByText('15% funded')).toBeTruthy();
  });

  it('thanks everyone when both goals are funded', async () => {
    mockCosts = {
      doc: {
        ...COSTS,
        goals: [
          { id: 'keepUp', percent: 100 },
          { id: 'features', percent: 100 },
        ],
      },
      fromCache: false,
    };
    await mount();
    expect(screen.getByTestId('goals-all-funded')).toHaveTextContent(
      'Both goals are funded for 2026. Thank you!',
    );
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('hides the progress when the file publishes no goals', async () => {
    mockCosts = { doc: { ...COSTS, goals: null }, fromCache: true };
    await mount();
    expect(screen.queryByTestId('support-progress')).toBeNull();
  });

  it('leaves the progress out when it is unavailable (offline, no copy)', async () => {
    mockCosts = null;
    mockStore = fakeStore().store;
    await mount();
    expect(screen.queryByTestId('support-progress')).toBeNull();
    // What donations pay for is static copy: it stays.
    expect(screen.getByTestId('donations-pay-for')).toBeTruthy();
    // The tips and the website link do not depend on them.
    expect(screen.getByText('Tip 8,99 $')).toBeTruthy();
    expect(screen.getByText('More about supporting Inukshuk on the website →')).toBeTruthy();
  });

  it('opens the public accounts on the website', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await mount();
    await press(screen.getByText('More about supporting Inukshuk on the website →'));
    expect(open).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/inukshuk\.mvxtechnologies\.com\/(fr\/)?support\/$/),
    );
  });
});

describe('tips', () => {
  it('shows a spinner while the store loads', async () => {
    mockStore = fakeStore({ connect: () => new Promise(() => undefined) }).store;
    await mount();
    expect(screen.getByLabelText('Loading tips')).toBeTruthy();
  });

  it('gives up calmly on a store that never answers', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    mockStore = fakeStore({ connect: () => new Promise(() => undefined) }).store;
    await mount();
    await act(async () => {
      jest.advanceTimersByTime(STORE_TIMEOUT_MS + 1);
    });
    expect(screen.getByText(/Tips aren't available on this device right now/)).toBeTruthy();
  });

  it('lists the tiers with the store prices, middle one chosen', async () => {
    const { store } = fakeStore();
    mockStore = store;
    await mount();
    expect(screen.getByText('Coffee at the trailhead')).toBeTruthy();
    expect(screen.getByText('3,99 $')).toBeTruthy();
    expect(screen.getByText('8,99 $')).toBeTruthy();
    expect(screen.getByText('19,99 $')).toBeTruthy();
    expect(screen.getByText('Tip 8,99 $')).toBeTruthy();
    expect(screen.getByText(/A tip unlocks nothing: everything stays free\./)).toBeTruthy();
    // Leftovers from an earlier session are consumed quietly.
    expect(store.sweepUnfinished).toHaveBeenCalled();
    await press(screen.getByText('A day on the trail'));
    expect(screen.getByText('Tip 19,99 $')).toBeTruthy();
  });

  it.each([
    ['no native module (older build, simulator)', () => null],
    ['no billing connection', () => fakeStore({ connect: jest.fn(async () => false) }).store],
    ['no products', () => fakeStore({ fetchTips: jest.fn(async () => []) }).store],
    [
      'a store that throws',
      () => fakeStore({ fetchTips: jest.fn(async () => Promise.reject(new Error('boom'))) }).store,
    ],
  ])('says tips are unavailable, never crashing, with %s', async (_label, make) => {
    mockStore = make();
    await mount();
    expect(screen.getByText(/Tips aren't available on this device right now/)).toBeTruthy();
    expect(screen.queryByText(/^Tip /)).toBeNull();
  });

  it('offers all five tiers in order, from coffee to patron', async () => {
    mockStore = fakeStore().store;
    await mount();
    const names = [
      'Coffee at the trailhead',
      'Lunch at the lookout',
      'A day on the trail',
      'A season of trails',
      'Patron of the trail',
    ];
    for (const name of names) expect(screen.getByText(name)).toBeTruthy();
    expect(screen.getByText('139,99 $')).toBeTruthy();
    expect(screen.queryByTestId('support-jar-prompt')).toBeNull();
  });

  it('greets people who came from the tip jar', async () => {
    mockParams = { from: 'jar' };
    mockStore = fakeStore().store;
    await mount();
    expect(screen.getByTestId('support-jar-prompt')).toBeTruthy();
  });

  it('thanks the person after a successful tip', async () => {
    const { store, emit } = fakeStore();
    mockStore = store;
    await mount();
    await press(screen.getByText('Coffee at the trailhead'));
    await press(screen.getByText('Tip 3,99 $'));
    expect(store.requestTip).toHaveBeenCalledWith('tip_small');
    expect(screen.getByLabelText('Waiting for the store')).toBeTruthy();
    await emit({ kind: 'purchased', productId: 'tip_small', transactionId: 'GPA.7' });
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/support/thanks',
      params: { tip: 'tip_small' },
    });
    // Counted toward the person's own total (donors list) before the thanks.
    expect(useSupportStore.getState()).toMatchObject({ totalCents: 299, tipCount: 1 });
  });

  it('says nothing when the person cancels, and lets them try again', async () => {
    const { store, emit } = fakeStore();
    mockStore = store;
    await mount();
    await press(screen.getByText('Tip 8,99 $'));
    await emit({ kind: 'error', code: 'user-cancelled', message: 'cancelled' });
    expect(screen.queryByTestId('support-notice')).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByText('Tip 8,99 $')).toBeTruthy();
  });

  it('explains a pending payment', async () => {
    const { store, emit } = fakeStore();
    mockStore = store;
    await mount();
    await press(screen.getByText('Tip 8,99 $'));
    await emit({ kind: 'pending', productId: 'tip_medium' });
    expect(screen.getByTestId('support-notice')).toHaveTextContent(/waiting for approval/);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('reports an unexpected store error and says so calmly', async () => {
    const { store, emit } = fakeStore();
    mockStore = store;
    await mount();
    await press(screen.getByText('Tip 8,99 $'));
    await emit({ kind: 'error', code: 'developer-error', message: 'bad sku' });
    expect(screen.getByTestId('support-notice')).toHaveTextContent(/did not go through/);
    expect(mockReport).toHaveBeenCalledWith(expect.any(Error), 'tip');
  });

  it('handles a purchase request that is rejected outright', async () => {
    const { store } = fakeStore({
      requestTip: jest.fn(async () =>
        Promise.reject({ code: 'network-error', message: 'offline' }),
      ),
    });
    mockStore = store;
    await mount();
    await press(screen.getByText('Tip 8,99 $'));
    expect(screen.getByTestId('support-notice')).toHaveTextContent(/Couldn't reach the store/);
    expect(screen.getByText('Tip 8,99 $')).toBeTruthy();
  });

  it('closes the store connection on the way out', async () => {
    const { store } = fakeStore();
    mockStore = store;
    const view = await mount();
    await act(async () => {
      view.unmount();
    });
    expect(store.disconnect).toHaveBeenCalled();
  });
});

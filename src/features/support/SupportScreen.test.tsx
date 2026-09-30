/** Support Inukshuk (#476): costs, store prices, and every purchase outcome. */
import type { CostsDocument } from '@core/support/costs';
import type { StoreProduct } from '@core/support/tips';
import type { TipEvent, TipStore } from '@lib/iap';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SupportScreen } from './SupportScreen';
import { STORE_TIMEOUT_MS } from './useTipJar';

const mockReplace = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, back: mockBack }),
}));

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
  currency: 'USD',
  goal: 1267,
  raised: 317,
  supporters: 12,
  updated: '2026-09-30',
  costs: [
    { labelEn: 'Apple developer account', labelFr: 'x', amount: 99, period: 'year' },
    { labelEn: 'Strava connection (API)', labelFr: 'x', amount: 14, period: 'month' },
    {
      labelEn: 'Servers, maintenance, licences (cushion)',
      labelFr: 'x',
      amount: 1000,
      period: 'year',
    },
    { labelEn: 'Google Play account', labelFr: 'x', amount: 25, period: 'once' },
  ],
  ledger: [],
};

const PRODUCTS: StoreProduct[] = [
  { id: 'tip_large', displayPrice: '19,99 $' },
  { id: 'tip_small', displayPrice: '3,99 $' },
  { id: 'tip_medium', displayPrice: '8,99 $' },
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
    sweepUnfinished: jest.fn(async () => undefined),
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
});

afterEach(() => {
  jest.useRealTimers();
});

describe('costs', () => {
  it('shows this year, the supporters and where the money goes', async () => {
    mockStore = fakeStore().store;
    await mount();
    expect(screen.getByText('Free for everyone. Kept alive by donations.')).toBeTruthy();
    expect(screen.getByText('$317 of $1,267')).toBeTruthy();
    expect(screen.getByText('12 supporters so far · updated monthly')).toBeTruthy();
    expect(screen.getByRole('progressbar').props.accessibilityValue).toMatchObject({ now: 25 });
    expect(screen.getByText('$168')).toBeTruthy();
    expect(screen.getByText('paid once')).toBeTruthy();
    expect(screen.getByText('$1,267')).toBeTruthy();
  });

  it('leaves the numbers out when the accounts are unavailable (offline, no copy)', async () => {
    mockCosts = null;
    mockStore = fakeStore().store;
    await mount();
    expect(screen.queryByTestId('support-progress')).toBeNull();
    expect(screen.queryByText('Where the money goes')).toBeNull();
    // The tips and the website link do not depend on them.
    expect(screen.getByText('Tip 8,99 $')).toBeTruthy();
    expect(screen.getByText('See the full accounts on the website →')).toBeTruthy();
  });

  it('opens the public accounts on the website', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await mount();
    await press(screen.getByText('See the full accounts on the website →'));
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
    await press(screen.getByText('A month of servers'));
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

  it('thanks the person after a successful tip', async () => {
    const { store, emit } = fakeStore();
    mockStore = store;
    await mount();
    await press(screen.getByText('Coffee at the trailhead'));
    await press(screen.getByText('Tip 3,99 $'));
    expect(store.requestTip).toHaveBeenCalledWith('tip_small');
    expect(screen.getByLabelText('Waiting for the store')).toBeTruthy();
    await emit({ kind: 'purchased', productId: 'tip_small' });
    expect(mockReplace).toHaveBeenCalledWith('/support/thanks');
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

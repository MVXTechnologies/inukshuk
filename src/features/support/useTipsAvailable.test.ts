import {
  probeTipsAvailability,
  resetTipsAvailabilityForTests,
  useTipsAvailability,
} from './useTipsAvailable';

const mockGetTipStore = jest.fn();
jest.mock('@lib/iap', () => ({ getTipStore: () => mockGetTipStore() }));

const store = (connect: boolean, products: { id: string; displayPrice: string }[]) => ({
  connect: jest.fn(async () => connect),
  fetchTips: jest.fn(async () => products),
  disconnect: jest.fn(async () => undefined),
});

beforeEach(() => resetTipsAvailabilityForTests());

it('is "no" when the billing module is not in the build', async () => {
  mockGetTipStore.mockReturnValue(null);
  await probeTipsAvailability();
  expect(useTipsAvailability.getState().state).toBe('no');
});

it('is "no" when the store connects but sells no tip yet (accounts not set up)', async () => {
  mockGetTipStore.mockReturnValue(store(true, []));
  await probeTipsAvailability();
  expect(useTipsAvailability.getState().state).toBe('no');
});

it('is "no" when the store cannot connect', async () => {
  const s = store(false, []);
  mockGetTipStore.mockReturnValue(s);
  await probeTipsAvailability();
  expect(useTipsAvailability.getState().state).toBe('no');
  expect(s.fetchTips).not.toHaveBeenCalled();
});

it('leaves no probe timer behind once the store answers', async () => {
  jest.useFakeTimers();
  try {
    mockGetTipStore.mockReturnValue(store(true, [{ id: 'tip_medium', displayPrice: '$6.99' }]));
    await probeTipsAvailability();
    expect(useTipsAvailability.getState().state).toBe('yes');
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

it('is "yes" once a tip product comes back, and probes only once', async () => {
  const s = store(true, [{ id: 'tip_medium', displayPrice: '$6.99' }]);
  mockGetTipStore.mockReturnValue(s);
  await probeTipsAvailability();
  await probeTipsAvailability();
  expect(useTipsAvailability.getState().state).toBe('yes');
  expect(s.connect).toHaveBeenCalledTimes(1);
  expect(s.disconnect).toHaveBeenCalled();
});

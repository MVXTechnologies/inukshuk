import { requireOptionalNativeModule } from 'expo';

import {
  createTipStore,
  getTipStore,
  sweepUnfinishedTips,
  type ExpoIapSlice,
  type TipEvent,
} from './iap';

jest.mock('expo', () => ({ requireOptionalNativeModule: jest.fn(() => null) }));

// expo-iap may not be installed in this checkout yet (it is added with the
// 2.0.2 native build); a virtual mock stands in for it either way.
const mockVirtualIap = {
  initConnection: jest.fn(async () => true),
  endConnection: jest.fn(async () => true),
  finishTransaction: jest.fn(async () => undefined),
  getAvailablePurchases: jest.fn(async () => [
    { id: 'L1', productId: 'tip_large', purchaseState: 'purchased' },
  ]),
};
jest.mock('expo-iap', () => mockVirtualIap, { virtual: true });

type Purchase = {
  id?: string;
  productId: string;
  purchaseState: 'pending' | 'purchased' | 'unknown';
};

function fakeIap() {
  let onUpdate: ((p: Purchase) => void) | null = null;
  let onError: ((e: { code?: string; message?: string }) => void) | null = null;
  const iap = {
    initConnection: jest.fn(async () => true),
    endConnection: jest.fn(async () => true),
    fetchProducts: jest.fn(async () => [
      { id: 'tip_small', displayPrice: '$2.99' },
      { id: 'tip_large', displayPrice: '$14.99' },
    ]),
    requestPurchase: jest.fn(async () => null),
    finishTransaction: jest.fn(async () => undefined),
    getAvailablePurchases: jest.fn(async (): Promise<Purchase[]> => []),
    purchaseUpdatedListener: jest.fn((l: (p: Purchase) => void) => {
      onUpdate = l;
      return { remove: jest.fn(() => (onUpdate = null)) };
    }),
    purchaseErrorListener: jest.fn((l: (e: { code?: string; message?: string }) => void) => {
      onError = l;
      return { remove: jest.fn(() => (onError = null)) };
    }),
  };
  return {
    iap,
    slice: iap as unknown as ExpoIapSlice,
    update: (p: Purchase) => onUpdate?.(p),
    error: (e: { code?: string; message?: string }) => onError?.(e),
    listening: () => onUpdate !== null && onError !== null,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createTipStore', () => {
  it('fetches in-app products and keeps only id and store price', async () => {
    const { iap, slice } = fakeIap();
    const store = createTipStore(slice);
    await expect(store.fetchTips(['tip_small', 'tip_large'])).resolves.toEqual([
      { id: 'tip_small', displayPrice: '$2.99' },
      { id: 'tip_large', displayPrice: '$14.99' },
    ]);
    expect(iap.fetchProducts).toHaveBeenCalledWith({
      skus: ['tip_small', 'tip_large'],
      type: 'in-app',
    });
  });

  it('treats a null product list as empty', async () => {
    const { iap, slice } = fakeIap();
    iap.fetchProducts.mockResolvedValueOnce(null as never);
    await expect(createTipStore(slice).fetchTips(['tip_small'])).resolves.toEqual([]);
  });

  it('requests the same sku on both stores', async () => {
    const { iap, slice } = fakeIap();
    await createTipStore(slice).requestTip('tip_medium');
    expect(iap.requestPurchase).toHaveBeenCalledWith({
      request: { apple: { sku: 'tip_medium' }, google: { skus: ['tip_medium'] } },
      type: 'in-app',
    });
  });

  it('consumes a completed tip before announcing it, so it can be given again', async () => {
    const { iap, slice, update } = fakeIap();
    const events: TipEvent[] = [];
    createTipStore(slice).subscribe((e) => events.push(e));
    const purchase: Purchase = { id: 'GPA.1', productId: 'tip_small', purchaseState: 'purchased' };
    update(purchase);
    await flush();
    expect(iap.finishTransaction).toHaveBeenCalledWith({ purchase, isConsumable: true });
    expect(events).toEqual([{ kind: 'purchased', productId: 'tip_small', transactionId: 'GPA.1' }]);
  });

  it('still thanks the person when the consume fails', async () => {
    const { iap, slice, update } = fakeIap();
    iap.finishTransaction.mockRejectedValueOnce(new Error('later'));
    const events: TipEvent[] = [];
    createTipStore(slice).subscribe((e) => events.push(e));
    update({ productId: 'tip_large', purchaseState: 'purchased' });
    await flush();
    expect(events).toEqual([{ kind: 'purchased', productId: 'tip_large', transactionId: null }]);
  });

  it('never finishes a pending payment, nor anything that is not a tip', async () => {
    const { iap, slice, update } = fakeIap();
    const events: TipEvent[] = [];
    createTipStore(slice).subscribe((e) => events.push(e));
    update({ productId: 'tip_small', purchaseState: 'pending' });
    update({ productId: 'premium', purchaseState: 'purchased' });
    update({ productId: 'tip_small', purchaseState: 'unknown' });
    await flush();
    expect(iap.finishTransaction).not.toHaveBeenCalled();
    expect(events).toEqual([{ kind: 'pending', productId: 'tip_small' }]);
  });

  it('forwards store errors with their code, and unsubscribes', async () => {
    const { slice, error, listening } = fakeIap();
    const events: TipEvent[] = [];
    const unsubscribe = createTipStore(slice).subscribe((e) => events.push(e));
    error({ code: 'user-cancelled', message: 'Cancelled' });
    error({});
    expect(events).toEqual([
      { kind: 'error', code: 'user-cancelled', message: 'Cancelled' },
      { kind: 'error', code: null, message: '[object Object]' },
    ]);
    unsubscribe();
    expect(listening()).toBe(false);
  });

  it('sweeps up unfinished tips only', async () => {
    const { iap, slice } = fakeIap();
    iap.getAvailablePurchases.mockResolvedValueOnce([
      { id: 'T1', productId: 'tip_small', purchaseState: 'purchased' },
      { id: 'T2', productId: 'tip_patron', purchaseState: 'purchased' },
      { productId: 'tip_medium', purchaseState: 'pending' },
      { productId: 'premium', purchaseState: 'purchased' },
    ]);
    iap.finishTransaction
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('later'));
    const finished = await createTipStore(slice).sweepUnfinished();
    expect(iap.finishTransaction).toHaveBeenCalledTimes(2);
    expect(iap.finishTransaction).toHaveBeenCalledWith({
      purchase: { id: 'T1', productId: 'tip_small', purchaseState: 'purchased' },
      isConsumable: true,
    });
    // Only what was actually finished counts toward the person's total.
    expect(finished).toEqual([{ productId: 'tip_small', transactionId: 'T1' }]);
  });

  it('reports a failed connection as false', async () => {
    const { iap, slice } = fakeIap();
    iap.initConnection.mockRejectedValueOnce(new Error('no billing'));
    await expect(createTipStore(slice).connect()).resolves.toBe(false);
    // …and the next caller tries again.
    await expect(createTipStore(slice).connect()).resolves.toBe(true);
  });

  it('shares one connection: the last user out closes it', async () => {
    const { iap, slice } = fakeIap();
    const screen = createTipStore(slice);
    const sweep = createTipStore(slice);
    await Promise.all([screen.connect(), sweep.connect()]);
    expect(iap.initConnection).toHaveBeenCalledTimes(1);
    await sweep.disconnect();
    expect(iap.endConnection).not.toHaveBeenCalled();
    await sweep.disconnect(); // idempotent: cannot close the screen's connection
    expect(iap.endConnection).not.toHaveBeenCalled();
    await screen.disconnect();
    expect(iap.endConnection).toHaveBeenCalledTimes(1);
  });
});

describe('getTipStore', () => {
  it('is null when the native module is missing (older binary, Expo Go)', () => {
    jest.mocked(requireOptionalNativeModule).mockReturnValue(null);
    expect(getTipStore()).toBeNull();
  });

  it('wraps expo-iap when the native module is present', async () => {
    jest
      .mocked(requireOptionalNativeModule)
      .mockImplementation((name: string) => (name === 'ExpoIap' ? {} : null));
    const store = getTipStore();
    expect(store).not.toBeNull();
    await expect(store?.connect()).resolves.toBe(true);
    expect(mockVirtualIap.initConnection).toHaveBeenCalled();
    await store?.disconnect();
  });

  it('reports the tips the launch sweep finished', async () => {
    jest
      .mocked(requireOptionalNativeModule)
      .mockImplementation((name: string) => (name === 'ExpoIap' ? {} : null));
    const onFinished = jest.fn();
    await sweepUnfinishedTips(onFinished);
    expect(onFinished).toHaveBeenCalledWith({ productId: 'tip_large', transactionId: 'L1' });
    expect(mockVirtualIap.endConnection).toHaveBeenCalled();
  });

  it('sweeps at launch without throwing, even with no store', async () => {
    jest.mocked(requireOptionalNativeModule).mockReturnValue(null);
    await expect(sweepUnfinishedTips()).resolves.toBeUndefined();
  });
});

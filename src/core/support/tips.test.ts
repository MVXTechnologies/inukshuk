import {
  classifyTipFailure,
  defaultTipId,
  isTipId,
  TIP_IDS,
  tipFailureMessage,
  tipOffers,
  type TipFailure,
} from './tips';

describe('tip catalog', () => {
  it('sells exactly the three store product ids, smallest first', () => {
    expect(TIP_IDS).toEqual(['tip_small', 'tip_medium', 'tip_large']);
  });

  it('recognizes tip ids', () => {
    expect(isTipId('tip_small')).toBe(true);
    expect(isTipId('premium')).toBe(false);
    expect(isTipId(3)).toBe(false);
  });
});

describe('tipOffers', () => {
  it('uses the store price and catalog order, whatever order the store answers in', () => {
    const offers = tipOffers([
      { id: 'tip_large', displayPrice: '19,99 $' },
      { id: 'tip_small', displayPrice: '3,99 $' },
      { id: 'tip_medium', displayPrice: ' 8,99 $ ' },
    ]);
    expect(offers.map((o) => [o.id, o.displayPrice])).toEqual([
      ['tip_small', '3,99 $'],
      ['tip_medium', '8,99 $'],
      ['tip_large', '19,99 $'],
    ]);
    expect(offers[0]?.name).toBe('Coffee at the trailhead');
  });

  it('offers only what the store returned, ignoring strangers and blank prices', () => {
    const offers = tipOffers([
      { id: 'tip_medium', displayPrice: '$6.99' },
      { id: 'tip_large', displayPrice: '  ' },
      { id: 'premium', displayPrice: '$1' },
    ]);
    expect(offers.map((o) => o.id)).toEqual(['tip_medium']);
  });

  it('is empty when the store has nothing', () => {
    expect(tipOffers([])).toEqual([]);
  });
});

describe('defaultTipId', () => {
  it('starts on the middle tier when all three are on sale', () => {
    const offers = tipOffers(TIP_IDS.map((id) => ({ id, displayPrice: '$1' })));
    expect(defaultTipId(offers)).toBe('tip_medium');
  });

  it('starts on the first otherwise, and on nothing when nothing is on sale', () => {
    const two = tipOffers([
      { id: 'tip_large', displayPrice: '$1' },
      { id: 'tip_small', displayPrice: '$1' },
    ]);
    expect(defaultTipId(two)).toBe('tip_small');
    expect(defaultTipId([])).toBeNull();
  });
});

describe('failures', () => {
  it.each<[string | null | undefined, TipFailure]>([
    ['user-cancelled', 'cancelled'],
    ['deferred-payment', 'pending'],
    ['pending', 'pending'],
    ['billing-unavailable', 'unavailable'],
    ['iap-not-available', 'unavailable'],
    ['sku-not-found', 'unavailable'],
    ['network-error', 'network'],
    ['service-timeout', 'network'],
    ['developer-error', 'failed'],
    ['something-new', 'failed'],
    [null, 'failed'],
    [undefined, 'failed'],
  ])('%p → %s', (code, expected) => {
    expect(classifyTipFailure(code)).toBe(expected);
  });

  it('stays quiet on cancel and says something otherwise', () => {
    expect(tipFailureMessage('cancelled')).toBeNull();
    for (const f of ['pending', 'unavailable', 'network', 'failed'] as const) {
      expect(tipFailureMessage(f)).toEqual(expect.any(String));
    }
    expect(tipFailureMessage('unavailable')).toBe(
      "Tips aren't available on this device right now.",
    );
  });
});

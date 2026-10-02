import {
  classifyTipFailure,
  defaultTipId,
  isTipId,
  TIP_IDS,
  TIP_TIERS,
  TIP_USD,
  tipFailureMessage,
  tipOffers,
  type TipFailure,
} from './tips';

describe('tip catalog', () => {
  it('sells exactly the four store product ids, smallest first (no $2.99 tier)', () => {
    expect(TIP_IDS).toEqual(['tip_medium', 'tip_large', 'tip_xlarge', 'tip_patron']);
    expect(TIP_IDS).not.toContain('tip_small');
  });

  it('reads as a ladder from a coffee upward', () => {
    expect(TIP_TIERS.map((t) => t.name)).toEqual([
      'Coffee at the trailhead',
      'Lunch at the lookout',
      'A day on the trail',
      'Patron of the trail',
    ]);
  });

  it("knows each product's USD base price, rising with the tier", () => {
    const prices = TIP_IDS.map((id) => TIP_USD[id]);
    expect(prices).toEqual([6.99, 14.99, 29.99, 99.99]);
  });

  it('describes no tier as buying a feature', () => {
    for (const tier of TIP_TIERS) {
      expect(`${tier.name} ${tier.what}`).not.toMatch(
        /server|map sheet|unlock|online|feature|premium/i,
      );
    }
  });

  it('recognizes tip ids', () => {
    expect(isTipId('tip_medium')).toBe(true);
    expect(isTipId('tip_small')).toBe(false);
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
    // A leftover tip_small from a console is never offered.
    expect(offers.map((o) => [o.id, o.displayPrice])).toEqual([
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
  it('starts on the first tier, the coffee', () => {
    const offers = tipOffers(TIP_IDS.map((id) => ({ id, displayPrice: '$1' })));
    expect(defaultTipId(offers)).toBe('tip_medium');
  });

  it('starts on the smallest one on sale otherwise, and on nothing when nothing is', () => {
    const two = tipOffers([
      { id: 'tip_patron', displayPrice: '$1' },
      { id: 'tip_xlarge', displayPrice: '$1' },
    ]);
    expect(defaultTipId(two)).toBe('tip_xlarge');
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

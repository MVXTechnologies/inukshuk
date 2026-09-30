import {
  DONOR_MAX_TRANSACTIONS,
  DONOR_NAME_MAX,
  DONOR_PLACE_MAX,
  donorLine,
  donorOfferVisible,
  donorSubmission,
  EMPTY_LEDGER,
  recordTip,
  sanitizeLedger,
  validateDonorForm,
  type TipLedger,
} from './donors';

const tip = (productId: string, transactionId: string | null) => ({ productId, transactionId });

describe('recordTip', () => {
  it('adds USD base prices in cents, without float drift', () => {
    let l: TipLedger = EMPTY_LEDGER;
    for (let i = 0; i < 10; i++) l = recordTip(l, tip('tip_medium', `t${i}`));
    expect(l.totalCents).toBe(6990);
    expect(l.tipCount).toBe(10);
  });

  it('counts a transaction once, however often the store replays it', () => {
    const once = recordTip(EMPTY_LEDGER, tip('tip_large', 'a'));
    expect(recordTip(once, tip('tip_large', 'a'))).toBe(once);
  });

  it('counts tips without a transaction id, and ignores strangers', () => {
    const l = recordTip(EMPTY_LEDGER, tip('tip_medium', null));
    expect(l).toMatchObject({ totalCents: 699, tipCount: 1, transactionIds: [] });
    expect(recordTip(l, tip('premium', 'x'))).toBe(l);
    // The retired $2.99 product is a stranger too.
    expect(recordTip(l, tip('tip_small', 'y'))).toBe(l);
  });

  it('remembers a bounded number of ids', () => {
    let l: TipLedger = EMPTY_LEDGER;
    for (let i = 0; i < 250; i++) l = recordTip(l, tip('tip_medium', `t${i}`));
    expect(l.transactionIds).toHaveLength(200);
    expect(l.transactionIds[199]).toBe('t249');
  });
});

describe('sanitizeLedger', () => {
  it('keeps valid fields and drops junk', () => {
    expect(
      sanitizeLedger({
        totalCents: 500,
        tipCount: 2,
        transactionIds: ['a', 3],
        donorSubmitted: true,
      }),
    ).toEqual({ totalCents: 500, tipCount: 2, transactionIds: ['a'], donorSubmitted: true });
    expect(sanitizeLedger({ totalCents: -1, tipCount: 1.5, transactionIds: 'x' })).toEqual(
      EMPTY_LEDGER,
    );
    expect(sanitizeLedger(null)).toEqual(EMPTY_LEDGER);
  });
});

describe('donorOfferVisible', () => {
  it('opens at $100 of tips, or right after a Patron tip', () => {
    expect(donorOfferVisible({ ...EMPTY_LEDGER, totalCents: 9999 })).toBe(false);
    expect(donorOfferVisible({ ...EMPTY_LEDGER, totalCents: 10000 })).toBe(true);
    expect(donorOfferVisible({ ...EMPTY_LEDGER, totalCents: 9999 }, 'tip_patron')).toBe(true);
    expect(donorOfferVisible(EMPTY_LEDGER, 'tip_xlarge')).toBe(false);
  });

  it('is not offered again once a name was sent', () => {
    expect(
      donorOfferVisible({ ...EMPTY_LEDGER, totalCents: 50000, donorSubmitted: true }, 'tip_patron'),
    ).toBe(false);
  });
});

describe('validateDonorForm', () => {
  it('trims, collapses spaces and makes the place optional', () => {
    expect(validateDonorForm('  Anne   T. ', '  ')).toEqual({
      ok: true,
      name: 'Anne T.',
      place: null,
    });
    expect(validateDonorForm('Anne', ' Rimouski ')).toEqual({
      ok: true,
      name: 'Anne',
      place: 'Rimouski',
    });
  });

  it('requires a name and bounds both fields', () => {
    expect(validateDonorForm(' \n ', '')).toMatchObject({ ok: false });
    expect(validateDonorForm('a'.repeat(DONOR_NAME_MAX), '').ok).toBe(true);
    expect(validateDonorForm('a'.repeat(DONOR_NAME_MAX + 1), '').ok).toBe(false);
    expect(validateDonorForm('Anne', 'b'.repeat(DONOR_PLACE_MAX + 1)).ok).toBe(false);
  });

  it('drops control characters', () => {
    expect(validateDonorForm('An\u0000ne\u0007', '')).toEqual({
      ok: true,
      name: 'Anne',
      place: null,
    });
  });
});

describe('donorSubmission', () => {
  it('sends the latest transaction ids only, and nothing else about the person', () => {
    const ledger = {
      ...EMPTY_LEDGER,
      transactionIds: Array.from({ length: 30 }, (_, i) => `t${i}`),
    };
    const body = donorSubmission({ name: 'Anne', place: null }, 'android', ledger);
    expect(Object.keys(body).sort()).toEqual(['name', 'place', 'platform', 'transactionIds']);
    expect(body.transactionIds).toHaveLength(DONOR_MAX_TRANSACTIONS);
    expect(body.transactionIds[0]).toBe('t10');
  });
});

describe('donorLine', () => {
  it('joins place and year when present', () => {
    expect(donorLine({ name: 'A', place: 'Lévis', since: 2026 })).toBe('Lévis · since 2026');
    expect(donorLine({ name: 'A', place: null, since: 2026 })).toBe('since 2026');
    expect(donorLine({ name: 'A', place: null, since: null })).toBe('');
  });
});

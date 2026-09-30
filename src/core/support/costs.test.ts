import { readFileSync } from 'fs';
import { join } from 'path';

import { annualAmount, annualTotal, parseCostsDocument, progressFraction } from './costs';

const valid = {
  year: 2026,
  currency: 'USD',
  goal: 1267,
  raised: 40,
  supporters: 3,
  updated: '2026-09-30',
  costs: [
    {
      label_en: 'Apple developer account',
      label_fr: 'Compte développeur Apple',
      amount: 99,
      period: 'year',
    },
    {
      label_en: 'Strava connection (API)',
      label_fr: 'Connexion Strava (API)',
      amount: 14,
      period: 'month',
    },
    { label_en: 'Google Play account', label_fr: 'Compte Google Play', amount: 25, period: 'once' },
  ],
  ledger: [{ month: '2026-10', costs: 113, gifts: 40, balance: -73 }],
};

describe('parseCostsDocument', () => {
  it('parses a valid document', () => {
    const { doc, warnings } = parseCostsDocument(valid);
    expect(warnings).toEqual([]);
    expect(doc).toMatchObject({
      year: 2026,
      currency: 'USD',
      goal: 1267,
      raised: 40,
      supporters: 3,
    });
    expect(doc?.updated).toBe('2026-09-30');
    expect(doc?.costs[1]).toEqual({
      labelEn: 'Strava connection (API)',
      labelFr: 'Connexion Strava (API)',
      amount: 14,
      period: 'month',
    });
    expect(doc?.ledger).toEqual([{ month: '2026-10', costs: 113, gifts: 40, balance: -73 }]);
  });

  it('parses the published docs/support/costs.json, whose recurring costs make the goal', () => {
    const raw: unknown = JSON.parse(
      readFileSync(join(__dirname, '../../../docs/support/costs.json'), 'utf8'),
    );
    const { doc, warnings } = parseCostsDocument(raw);
    expect(warnings).toEqual([]);
    expect(doc).not.toBeNull();
    expect(annualTotal(doc?.costs ?? [])).toBe(doc?.goal);
  });

  it.each([
    ['not an object', 42],
    ['an array', []],
    ['a bad year', { ...valid, year: 26 }],
    ['a fractional year', { ...valid, year: 2026.5 }],
    ['a bad currency', { ...valid, currency: 'usd' }],
    ['a zero goal', { ...valid, goal: 0 }],
    ['a negative raised', { ...valid, raised: -1 }],
    ['a NaN raised', { ...valid, raised: Number.NaN }],
    ['fractional supporters', { ...valid, supporters: 1.5 }],
    ['negative supporters', { ...valid, supporters: -2 }],
  ])('rejects %s', (_label, raw) => {
    const { doc, warnings } = parseCostsDocument(raw);
    expect(doc).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('drops bad cost and ledger rows with a warning, keeping the rest', () => {
    const { doc, warnings } = parseCostsDocument({
      ...valid,
      costs: [
        ...valid.costs,
        { label_en: '', amount: 5, period: 'year' },
        { label_en: 'X', amount: 5, period: 'week' },
        { label_en: 'Y', amount: -5, period: 'year' },
        'junk',
      ],
      ledger: [
        ...valid.ledger,
        { month: '2026-13', costs: 1, gifts: 1, balance: 0 },
        { month: '2026-11', costs: 1, gifts: 1, balance: 'x' },
        { month: '2026-11', costs: -1, gifts: 1, balance: 0 },
        null,
      ],
    });
    expect(doc?.costs).toHaveLength(3);
    expect(doc?.ledger).toHaveLength(1);
    expect(warnings).toHaveLength(8);
  });

  it('falls back to the English label when the French one is missing', () => {
    const { doc } = parseCostsDocument({
      ...valid,
      costs: [{ label_en: 'Servers', amount: 1000, period: 'year' }],
    });
    expect(doc?.costs[0]?.labelFr).toBe('Servers');
  });

  it('tolerates a missing costs list and a bad updated date', () => {
    const { doc, warnings } = parseCostsDocument({ ...valid, costs: undefined, updated: 'soon' });
    expect(doc?.costs).toEqual([]);
    expect(doc?.updated).toBeNull();
    expect(warnings).toEqual(['costs: missing costs list']);
  });

  it('treats a missing ledger as empty', () => {
    const { doc } = parseCostsDocument({ ...valid, ledger: undefined });
    expect(doc?.ledger).toEqual([]);
  });
});

describe('annual amounts', () => {
  it('annualizes by period and ignores one-off costs', () => {
    expect(annualAmount({ labelEn: 'a', labelFr: 'a', amount: 99, period: 'year' })).toBe(99);
    expect(annualAmount({ labelEn: 'a', labelFr: 'a', amount: 14, period: 'month' })).toBe(168);
    expect(annualAmount({ labelEn: 'a', labelFr: 'a', amount: 25, period: 'once' })).toBe(0);
  });

  it('sums the recurring lines', () => {
    const { doc } = parseCostsDocument(valid);
    expect(annualTotal(doc?.costs ?? [])).toBe(99 + 168);
  });
});

describe('progressFraction', () => {
  it.each([
    [0, 1267, 0],
    [633.5, 1267, 0.5],
    [1267, 1267, 1],
    [5000, 1267, 1],
    [-10, 1267, 0],
    [10, 0, 0],
    [Number.NaN, 1267, 0],
  ])('%p of %p is %p', (raised, goal, expected) => {
    expect(progressFraction(raised, goal)).toBeCloseTo(expected);
  });
});

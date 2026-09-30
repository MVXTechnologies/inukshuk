import {
  annualCostLabel,
  formatMoney,
  raisedOfGoalLabel,
  SUPPORT_PAGE_URL,
  SUPPORT_PAGE_URL_FR,
  supportersLabel,
  supportPageUrl,
} from './format';

describe('formatMoney', () => {
  it.each([
    [0, 'USD', '$0'],
    [3, 'USD', '$3'],
    [1267, 'USD', '$1,267'],
    [1234567, 'USD', '$1,234,567'],
    [14.5, 'USD', '$14.50'],
    [0.07, 'USD', '$0.07'],
    [99.999, 'USD', '$100'],
    [-73, 'USD', '−$73'],
    [20, 'EUR', '€20'],
    [1267, 'GBP', '1,267 GBP'],
  ])('%p %s → %s', (amount, currency, expected) => {
    expect(formatMoney(amount, currency)).toBe(expected);
  });
});

describe('annualCostLabel', () => {
  it('annualizes monthly costs and names one-off costs', () => {
    expect(
      annualCostLabel({ labelEn: 'a', labelFr: 'a', amount: 14, period: 'month' }, 'USD'),
    ).toBe('$168');
    expect(
      annualCostLabel({ labelEn: 'a', labelFr: 'a', amount: 1000, period: 'year' }, 'USD'),
    ).toBe('$1,000');
    expect(annualCostLabel({ labelEn: 'a', labelFr: 'a', amount: 25, period: 'once' }, 'USD')).toBe(
      'paid once',
    );
  });
});

describe('labels', () => {
  it('pluralizes supporters', () => {
    expect(supportersLabel(0)).toBe('0 supporters so far');
    expect(supportersLabel(1)).toBe('1 supporter so far');
    expect(supportersLabel(12)).toBe('12 supporters so far');
  });

  it('reads raised of goal', () => {
    expect(raisedOfGoalLabel(0, 1267, 'USD')).toBe('$0 of $1,267');
  });
});

describe('supportPageUrl', () => {
  it.each([
    ['fr-CA', SUPPORT_PAGE_URL_FR],
    ['fr', SUPPORT_PAGE_URL_FR],
    ['FR-fr', SUPPORT_PAGE_URL_FR],
    ['en-CA', SUPPORT_PAGE_URL],
    ['french', SUPPORT_PAGE_URL],
    [null, SUPPORT_PAGE_URL],
    [undefined, SUPPORT_PAGE_URL],
  ])('%p → %s', (locale, expected) => {
    expect(supportPageUrl(locale)).toBe(expected);
  });
});

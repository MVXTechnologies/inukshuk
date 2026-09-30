import {
  goalFundedLabel,
  percentFundedLabel,
  SUPPORT_PAGE_URL,
  SUPPORT_PAGE_URL_FR,
  supportersLabel,
  supportPageUrl,
} from './format';

describe('labels', () => {
  it('pluralizes supporters', () => {
    expect(supportersLabel(0)).toBe('0 supporters');
    expect(supportersLabel(1)).toBe('1 supporter');
    expect(supportersLabel(12)).toBe('12 supporters');
  });

  it('shows only a percentage, never an amount', () => {
    expect(percentFundedLabel(40)).toBe('40% funded');
  });

  it('marks a funded goal with its year', () => {
    expect(goalFundedLabel('Keep the app up', 2026)).toBe('Keep the app up ✓ funded for 2026');
    expect(goalFundedLabel('Keep the app up', null)).toBe('Keep the app up ✓ funded');
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

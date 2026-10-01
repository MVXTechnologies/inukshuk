import {
  checkOutcome,
  normalizeCode,
  normalizeEmail,
  restUntil,
  TIP_JAR_REST_MS,
  VERIFY_CODE_TTL_MS,
  verifyMessage,
} from './verify';

describe('inputs', () => {
  it.each([
    [' Anne@Example.org ', 'anne@example.org'],
    ['a.b+c@sub.domain.ca', 'a.b+c@sub.domain.ca'],
    ['nope', null],
    ['a@b', null],
    ['a@b.ca,c@d.ca', null],
    [`${'x'.repeat(250)}@b.ca`, null],
  ])('email %p → %p', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it.each([
    ['123456', '123456'],
    [' 123 456 ', '123456'],
    ['12345', null],
    ['12a456', null],
  ])('code %p → %p', (input, expected) => {
    expect(normalizeCode(input)).toBe(expected);
  });
});

describe('checkOutcome', () => {
  const sentAt = 1_000;
  it('tells a wrong code from an expired one by when the app asked', () => {
    expect(checkOutcome('ok', sentAt, sentAt + 10)).toBe('verified');
    expect(checkOutcome('rejected', sentAt, sentAt + VERIFY_CODE_TTL_MS - 1)).toBe('wrong');
    expect(checkOutcome('rejected', sentAt, sentAt + VERIFY_CODE_TTL_MS)).toBe('expired');
    expect(checkOutcome('rate-limited', sentAt, sentAt)).toBe('rate-limited');
    expect(checkOutcome('offline', sentAt, sentAt)).toBe('offline');
  });

  it('has a calm sentence for every failure', () => {
    for (const o of ['wrong', 'expired', 'rate-limited', 'offline'] as const) {
      expect(verifyMessage(o)).toEqual(expect.any(String));
    }
  });
});

describe('rest window', () => {
  it('is twelve months', () => {
    expect(TIP_JAR_REST_MS).toBe(365 * 24 * 60 * 60 * 1000);
    expect(restUntil(5)).toBe(5 + TIP_JAR_REST_MS);
  });
});

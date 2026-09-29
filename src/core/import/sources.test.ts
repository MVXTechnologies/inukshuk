import { SourceStopError, rangeStart } from './sources';

describe('rangeStart', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');

  it('starts after the last import', () => {
    expect(rangeStart({ kind: 'since', after: 1234 }, now)).toBe(1234);
    expect(rangeStart({ kind: 'since', after: -5 }, now)).toBe(0);
  });

  it('counts back whole days', () => {
    expect(rangeStart({ kind: 'last-days', days: 30 }, now)).toBe(
      Date.parse('2026-08-29T12:00:00Z'),
    );
  });

  it('takes everything from the beginning', () => {
    expect(rangeStart({ kind: 'everything' }, now)).toBe(0);
  });
});

describe('SourceStopError', () => {
  it('carries its kind and resume time', () => {
    const err = new SourceStopError('limit', 'daily-limit', 42);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ name: 'SourceStopError', kind: 'daily-limit', resumeAt: 42 });
    expect(new SourceStopError('auth', 'auth').resumeAt).toBeNull();
  });
});

import { setOp } from '@core/team/crdt';

import { app, APP_TOKEN, flag, has, knownFieldsValid, rewritesOnce, text } from './fields';

const stamp = { wall: Date.UTC(2026, 9, 7), counter: 0, author: 'a' };

describe('group field rules', () => {
  it('flags, texts and app tokens', () => {
    expect([0, 1].map(flag)).toEqual([true, true]);
    expect([2, -1, true, '1', null].map(flag)).toEqual([false, false, false, false, false]);
    const t = text(5);
    expect(t('Camp')).toBe(true);
    expect(t('')).toBe(false);
    expect(t('   ')).toBe(false);
    expect(t('Camp 12')).toBe(false);
    expect(t(5)).toBe(false);
    expect(app('lib')).toBe(true);
    expect(app('self')).toBe(true);
    expect(app('Lib')).toBe(false);
    expect(app('library12')).toBe(false);
    expect(app(1)).toBe(false);
    expect(APP_TOKEN.test('team')).toBe(true);
  });

  it('known fields are checked strictly; unknown ones are accepted (forward-lenient)', () => {
    const rules = { inet: flag };
    expect(knownFieldsValid({ inet: 1 }, rules)).toBe(true);
    expect(knownFieldsValid({ inet: 1, later: 'anything' }, rules)).toBe(true);
    expect(knownFieldsValid({ inet: 3 }, rules)).toBe(false);
    // A prototype name is a field like any other, never a rule.
    expect(knownFieldsValid({ constructor: 1, toString: 'x' }, rules)).toBe(true);
  });

  it('has: own fields only', () => {
    expect(has({ a: 1 }, 'a')).toBe(true);
    expect(has({ a: 1 }, 'toString')).toBe(false);
  });

  it('write-once fields: a new record, a repeat of the same value, or other fields pass', () => {
    const cur = setOp({ app: 'lib', name: 'Maps' }, stamp);
    expect(rewritesOnce(undefined, { app: 'team' }, ['app'])).toBe(false);
    expect(rewritesOnce(cur, { app: 'lib' }, ['app'])).toBe(false);
    expect(rewritesOnce(cur, { name: 'Other' }, ['app'])).toBe(false);
    expect(rewritesOnce(cur, { parent: 'x' }, ['app', 'parent'])).toBe(false);
    expect(rewritesOnce(cur, { app: 'team' }, ['app'])).toBe(true);
    expect(rewritesOnce(cur, { app: 'team' }, [])).toBe(false);
  });
});

import { emptyData } from '@core/team/data';

import { flag } from './fields';
import { KindTable } from './kindTable';
import type { KindWrite } from './registry';

const table = new KindTable({
  sw: {
    owned: false,
    writes: () => true,
    id: (id) => id === 'g',
    rules: { on: flag },
    first: 'on',
    once: [],
  },
});

const write = (over: Partial<KindWrite>): KindWrite => ({
  op: 'set',
  kind: 'sw',
  id: 'g',
  f: { on: 1 },
  o: undefined,
  author: 'a',
  wall: 0,
  ...over,
});

describe('KindTable', () => {
  it('lists, owns and recognises its kinds only', () => {
    expect(table.kinds).toEqual(['sw']);
    expect(table.has('sw')).toBe(true);
    expect(table.has('wpt')).toBe(false);
    expect(table.owned('sw')).toBe(false);
    expect(table.owned('wpt')).toBe(false);
  });

  it('is total on a kind it does not hold', () => {
    const w = write({ kind: 'wpt' });
    expect(table.validate(w)).toBe(false);
    expect(table.authorize(w, 'owner', emptyData())).toBe('invalid');
  });

  it('a shared kind: `o` never, ids checked, writes by its writers, deletes by admins', () => {
    expect(table.validate(write({}))).toBe(true);
    expect(table.validate(write({ id: 'x' }))).toBe(false);
    expect(table.validate(write({ op: 'del', o: 'b' }))).toBe(false);
    expect(table.authorize(write({}), 'guest', emptyData())).toEqual({ owner: undefined });
    expect(table.authorize(write({ op: 'del' }), 'member', emptyData())).toBe('forbidden');
    expect(table.authorize(write({ op: 'del' }), 'admin', emptyData())).toEqual({
      owner: undefined,
    });
  });
});

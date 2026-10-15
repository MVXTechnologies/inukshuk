import { LAC, LCM, LFO, LIT } from './kinds';
import { buildHistory } from './history';
import { comment, edit, newFolder, newItem, purge, setCursor, validFields } from './writes';

const EMPTY = buildHistory([]);

describe('library op bodies', () => {
  it('builds creates, with or without a parent', () => {
    expect(newFolder('f', 'Trips')).toEqual({ k: LFO, id: 'f', f: { n: 'Trips' } });
    expect(newFolder('f', 'Trips', 'root', { o: 1 })).toEqual({
      k: LFO,
      id: 'f',
      f: { o: 1, n: 'Trips', p: 'root' },
    });
    expect(newItem('i', 'map', 'Rivière', 'root', { cat: 'cpa-42' }).f).toEqual({
      cat: 'cpa-42',
      t: 'map',
      n: 'Rivière',
      p: 'root',
    });
    expect(() => newItem('i', 'pdf' as never, 'x')).toThrow('unknown item type');
  });

  it('an edit of a record nobody else wrote carries no base; a stray base is dropped', () => {
    expect(edit(EMPTY, 'me', LIT, 'i', { n: 'x', b: { forged: 1 } })).toEqual({
      k: LIT,
      id: 'i',
      f: { n: 'x' },
    });
  });

  it('purge, cursor and comment bodies', () => {
    expect(purge(LIT, 'i')).toEqual({ k: LIT, id: 'i' });
    expect(setCursor(5)).toEqual({ k: LAC, id: 'g', f: { seen: 5 } });
    expect(comment('c', 'i', 'hi')).toEqual({ k: LCM, id: 'c', f: { on: 'i', tx: 'hi' } });
  });

  it('validFields mirrors the fold field rules', () => {
    expect(validFields(LIT, { n: 'x', t: 'wpt' })).toBe(true);
    expect(validFields(LIT, { n: '' })).toBe(false);
    expect(validFields(LIT, {})).toBe(false);
    expect(validFields('wpt', { n: 'x' })).toBe(false);
    expect(validFields(LCM, { tx: 'ok', on: 'i' })).toBe(true);
  });
});

import { toggleId } from './toggleId';

describe('toggleId', () => {
  it('adds an absent id', () => {
    expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('removes a present id', () => {
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('does not mutate the input', () => {
    const ids = ['a'];
    toggleId(ids, 'b');
    expect(ids).toEqual(['a']);
  });
});

import { isSyncKind, itemKey, LIBRARY_META_ID, parseItemKey, SYNC_KINDS } from './types';

describe('isSyncKind', () => {
  it.each(SYNC_KINDS)('accepts %s', (kind) => {
    expect(isSyncKind(kind)).toBe(true);
  });

  it.each(['map', 'Track', '', 42, null, undefined, {}, ['track']])('rejects %p', (value) => {
    expect(isSyncKind(value)).toBe(false);
  });
});

describe('itemKey / parseItemKey', () => {
  it('round-trips every kind', () => {
    for (const kind of SYNC_KINDS) {
      expect(parseItemKey(itemKey(kind, 'V1StGXR8_Z5j'))).toEqual({ kind, id: 'V1StGXR8_Z5j' });
    }
  });

  it('round-trips the libraryMeta singleton', () => {
    expect(parseItemKey(itemKey('libraryMeta', LIBRARY_META_ID))).toEqual({
      kind: 'libraryMeta',
      id: LIBRARY_META_ID,
    });
  });

  it('keeps colons inside the id (only the first separator splits)', () => {
    expect(parseItemKey('track:a:b')).toEqual({ kind: 'track', id: 'a:b' });
  });

  it.each(['', 'track', ':abc', 'track:', 'map:abc', 'photo'])(
    'returns undefined for malformed key %p',
    (key) => {
      expect(parseItemKey(key)).toBeUndefined();
    },
  );
});

import {
  frameFileName,
  isPngHeader,
  prefetchFrameOrder,
  selectEvictions,
  selectResolvedEvictions,
  type FrameCacheEntry,
} from './framePrefetch';

describe('prefetchFrameOrder', () => {
  it('warms the shown frame first, then playback order', () => {
    expect(prefetchFrameOrder(4, 10, 3)).toEqual([4, 5, 6, 7]);
  });

  it('wraps at the end of the loop', () => {
    expect(prefetchFrameOrder(8, 10, 3)).toEqual([8, 9, 0, 1]);
  });

  it('never asks for more frames than the timeline has', () => {
    expect(prefetchFrameOrder(1, 3, 9)).toEqual([1, 2, 0]);
  });

  it('tolerates junk instead of emitting bad indices', () => {
    expect(prefetchFrameOrder(0, 0, 3)).toEqual([]);
    expect(prefetchFrameOrder(NaN, 10, 3)).toEqual([]);
    expect(prefetchFrameOrder(-1, 10, 0)).toEqual([9]);
  });
});

describe('selectEvictions', () => {
  const e = (key: string, bytes: number, usedAt: number): FrameCacheEntry => ({
    key,
    bytes,
    usedAt,
  });

  it('keeps everything while the cache fits the budget', () => {
    expect(selectEvictions([e('a', 10, 1), e('b', 10, 2)], 100, [])).toEqual([]);
  });

  it('drops least-recently-used first, only down to the budget', () => {
    const entries = [e('old', 40, 1), e('mid', 40, 2), e('new', 40, 3)];
    expect(selectEvictions(entries, 90, [])).toEqual(['old']);
  });

  it('never evicts a frame the drape is showing', () => {
    const entries = [e('shown', 60, 1), e('other', 60, 2)];
    // 'shown' is the oldest, but evicting it would blank the drape.
    expect(selectEvictions(entries, 60, ['shown'])).toEqual(['other']);
  });

  it('stops rather than evicting pinned frames it cannot free', () => {
    const entries = [e('a', 60, 1), e('b', 60, 2)];
    expect(selectEvictions(entries, 10, ['a', 'b'])).toEqual([]);
  });
});

describe('selectResolvedEvictions', () => {
  it('keeps everything while the map fits', () => {
    expect(selectResolvedEvictions(['a', 'b'], [], 4)).toEqual([]);
  });

  it('drops oldest-first down to the cap', () => {
    expect(selectResolvedEvictions(['a', 'b', 'c', 'd', 'e'], [], 3)).toEqual(['a', 'b']);
  });

  it('never drops a key a crossfade slot is showing — that is a visible blank', () => {
    // 'a' and 'b' are the oldest, but they are the two live slots; the next
    // unprotected key has to go instead.
    expect(selectResolvedEvictions(['a', 'b', 'c', 'd', 'e'], ['a', 'b'], 3)).toEqual(['c', 'd']);
  });

  it('stays over the cap rather than unmounting a live slot', () => {
    expect(selectResolvedEvictions(['a', 'b', 'c'], ['a', 'b', 'c'], 1)).toEqual([]);
  });

  it('protects the incoming frame as well as the shown one', () => {
    // selected + pending + shown can all be protected at once during a scrub.
    expect(selectResolvedEvictions(['w', 'x', 'y', 'z'], ['x', 'z'], 2)).toEqual(['w', 'y']);
  });
});

describe('isPngHeader', () => {
  it('accepts the PNG signature', () => {
    expect(isPngHeader(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
      true,
    );
  });

  it('rejects the XML ServiceException GeoMet answers with HTTP 200', () => {
    const xml = new TextEncoder().encode("<?xml version='1.0'?><ogc:Service");
    expect(isPngHeader(xml)).toBe(false);
  });

  it('rejects a truncated read', () => {
    expect(isPngHeader(new Uint8Array([0x89, 0x50]))).toBe(false);
  });
});

describe('frameFileName', () => {
  it('is deterministic and distinct per URL', () => {
    const a = frameFileName('https://x/geomet?time=1');
    expect(frameFileName('https://x/geomet?time=1')).toBe(a);
    expect(frameFileName('https://x/geomet?time=2')).not.toBe(a);
  });

  it('is filesystem-safe', () => {
    expect(frameFileName('https://a/b?c=d&e=%20')).toMatch(/^f[0-9a-z]+_[0-9a-z]+\.png$/);
  });
});

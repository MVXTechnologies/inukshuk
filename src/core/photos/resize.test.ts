import {
  centerSquare,
  DISPLAY_MAX_PX,
  fitWithin,
  parseResizeReply,
  resizeJobScript,
  resizeWorkerHtml,
  SPRITE_PX,
  THUMB_PX,
} from './resize';

describe('fitWithin', () => {
  it('scales the long edge down to the limit', () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 });
  });
  it('never upscales and never returns zero', () => {
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10_000, 1, 2048)).toEqual({ width: 2048, height: 1 });
    expect(fitWithin(0, 5, 2048)).toEqual({ width: 0, height: 0 });
    expect(fitWithin(NaN, 5, 2048)).toEqual({ width: 0, height: 0 });
  });
});

describe('centerSquare', () => {
  it('crops the middle', () => {
    expect(centerSquare(2048, 1536)).toEqual({ sx: 256, sy: 0, size: 1536 });
    expect(centerSquare(100, 300)).toEqual({ sx: 0, sy: 100, size: 100 });
  });
});

describe('parseResizeReply', () => {
  const out = { base64: 'AAAA', width: 2, height: 1 };
  const ok = {
    type: 'resized',
    id: 'j1',
    display: out,
    thumb: out,
    sprite: out,
    sourceWidth: 4000,
    sourceHeight: 3000,
    decodeMs: 120,
    encodeMs: 340,
  };

  it('accepts the three replies', () => {
    expect(parseResizeReply(JSON.stringify(ok))).toEqual(ok);
    expect(parseResizeReply('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(parseResizeReply('{"type":"failed","id":"j1","message":"bad"}')).toEqual({
      type: 'failed',
      id: 'j1',
      message: 'bad',
    });
    expect(parseResizeReply('{"type":"failed","id":"j1"}')).toMatchObject({
      message: 'resize failed',
    });
  });

  it('defaults missing timings to 0', () => {
    const { decodeMs: _d, sourceWidth: _w, ...rest } = ok;
    expect(parseResizeReply(JSON.stringify(rest))).toMatchObject({ decodeMs: 0, sourceWidth: 0 });
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an object', '3'],
    ['null', 'null'],
    ['no id', JSON.stringify({ ...ok, id: 4 })],
    ['unknown type', JSON.stringify({ ...ok, type: 'other' })],
    ['an empty output', JSON.stringify({ ...ok, thumb: { base64: '', width: 1, height: 1 } })],
    ['a non-object output', JSON.stringify({ ...ok, sprite: 'x' })],
    ['a missing size', JSON.stringify({ ...ok, display: { base64: 'A' } })],
  ])('rejects %s', (_label, data) => {
    expect(parseResizeReply(data)).toBeNull();
  });
});

describe('worker page', () => {
  it('embeds the copy sizes and posts through ReactNativeWebView', () => {
    const html = resizeWorkerHtml();
    expect(html).toContain(`"displayMax":${DISPLAY_MAX_PX}`);
    expect(html).toContain(`"thumbPx":${THUMB_PX}`);
    expect(html).toContain(`"spritePx":${SPRITE_PX}`);
    expect(html).toContain('window.ReactNativeWebView.postMessage');
    expect(html).toContain('window.__inukshukResize');
    // Never fetches anything but the job's own src.
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('builds a job script that is safe to inject', () => {
    const script = resizeJobScript({ id: 'a"b', src: 'http://127.0.0.1:8080/.photo-inbox/x.jpg' });
    expect(script).toBe(
      'window.__inukshukResize && window.__inukshukResize({"id":"a\\"b","src":"http://127.0.0.1:8080/.photo-inbox/x.jpg"}); true;',
    );
  });
});

import { MAX_INLINE_PDF_BYTES, chooseRasterSource } from './rasterSource';

const origin = 'http://127.0.0.1:5555';

describe('chooseRasterSource', () => {
  it('serves a stored map over loopback whatever its size', () => {
    expect(
      chooseRasterSource({ origin, documentPath: 'maps/big.pdf', sizeBytes: 216 * 1024 * 1024 }),
    ).toEqual({ kind: 'url', url: `${origin}/maps/big.pdf` });
  });

  // Without the server a small file may still take the base64 bridge — that
  // is the path every map used before #269 and it works up to a point.
  it('falls back to the inline path for small files when there is no server', () => {
    expect(
      chooseRasterSource({ origin: null, documentPath: 'maps/a.pdf', sizeBytes: 3_600_000 }),
    ).toEqual({ kind: 'inline' });
    expect(
      chooseRasterSource({
        origin: null,
        documentPath: 'maps/a.pdf',
        sizeBytes: MAX_INLINE_PDF_BYTES,
      }),
    ).toEqual({ kind: 'inline' });
  });

  it.each([0, -1, NaN, Infinity])(
    'does not base64-read a PDF whose size is unknown (%s)',
    (sizeBytes) => {
      expect(
        chooseRasterSource({ origin: null, documentPath: 'maps/big.pdf', sizeBytes }).kind,
      ).toBe('unrenderable');
      // Unknown size does not block the streaming path when the server works.
      expect(chooseRasterSource({ origin, documentPath: 'maps/big.pdf', sizeBytes })).toEqual({
        kind: 'url',
        url: `${origin}/maps/big.pdf`,
      });
    },
  );

  // A file the server cannot address (not under Documents) is treated like
  // "no server": inline if small, refused if not.
  it('treats an unservable path like a missing server', () => {
    expect(chooseRasterSource({ origin, documentPath: 'content://x/1', sizeBytes: 1024 })).toEqual({
      kind: 'inline',
    });
    expect(
      chooseRasterSource({ origin, documentPath: 'content://x/1', sizeBytes: 52_500_000 }).kind,
    ).toBe('unrenderable');
  });

  it('fails fast, with the size in the reason, instead of hanging on a big file', () => {
    const choice = chooseRasterSource({
      origin: null,
      documentPath: 'maps/big.pdf',
      sizeBytes: 52_522_592,
    });
    expect(choice.kind).toBe('unrenderable');
    if (choice.kind === 'unrenderable') {
      expect(choice.reason).toBe(
        '50 MB PDF is too large to load without the in-app file server (limit 16 MB without it)',
      );
    }
  });
});

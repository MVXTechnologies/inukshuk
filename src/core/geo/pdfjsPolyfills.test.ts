import { createContext, runInContext } from 'node:vm';
import { PDFJS_POLYFILL_SOURCE, installPdfjsPolyfills } from './pdfjsPolyfills';

/**
 * A fresh JavaScript realm with the APIs iOS 16.4's WebKit lacks removed,
 * then the polyfill source run in it as the page runs it (a classic script).
 */
function oldRealm(): Record<string, unknown> {
  const context = createContext({ ReadableStream });
  runInContext(
    `delete Promise.withResolvers;
     delete ArrayBuffer.prototype.transfer;
     delete ArrayBuffer.prototype.transferToFixedLength;
     delete ReadableStream.prototype[Symbol.asyncIterator];
     delete ReadableStream.prototype.values;`,
    context,
  );
  runInContext(PDFJS_POLYFILL_SOURCE, context);
  return context;
}

describe('pdf.js polyfills', () => {
  it('adds Promise.withResolvers', async () => {
    const realm = oldRealm();
    const out = await runInContext(
      `(async () => {
        const a = Promise.withResolvers();
        const b = Promise.withResolvers();
        a.resolve(1);
        b.reject(new Error('no'));
        return [await a.promise, await b.promise.catch((e) => e.message), a.promise instanceof Promise];
      })()`,
      realm,
    );
    expect(out).toEqual([1, 'no', true]);
  });

  it('adds ArrayBuffer transfer/transferToFixedLength as a truncating or zero-padding copy', () => {
    const realm = oldRealm();
    const out = runInContext(
      `const src = new Uint8Array([1, 2, 3, 4]).buffer;
       [
         Array.from(new Uint8Array(src.transferToFixedLength(2))),
         Array.from(new Uint8Array(src.transferToFixedLength(6))),
         Array.from(new Uint8Array(src.transfer())),
         (() => { try { src.transfer(-1); return 'no throw'; } catch (e) { return e.name; } })(),
       ]`,
      realm,
    );
    expect(out).toEqual([[1, 2], [1, 2, 3, 4, 0, 0], [1, 2, 3, 4], 'RangeError']);
  });

  it('makes ReadableStream async-iterable, the way pdf.js reads DecompressionStream output', async () => {
    const realm = oldRealm();
    const chunks = await runInContext(
      `(async () => {
        const stream = new ReadableStream({
          start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); },
        });
        const seen = [];
        for await (const chunk of stream) seen.push(...chunk);
        return [seen, stream.locked];
      })()`,
      realm,
    );
    expect(chunks).toEqual([[1, 2, 3], false]);
  });

  it('cancels the stream when the loop exits early', async () => {
    const realm = oldRealm();
    const out = await runInContext(
      `(async () => {
        let cancelled = null;
        const stream = new ReadableStream({
          pull(c) { c.enqueue(1); },
          cancel(reason) { cancelled = reason === undefined ? 'cancelled' : String(reason); },
        });
        for await (const chunk of stream) { if (chunk === 1) break; }
        return [cancelled, stream.locked];
      })()`,
      realm,
    );
    expect(out).toEqual(['cancelled', false]);
  });

  it('never replaces a native implementation', () => {
    const native = {
      Promise: { withResolvers: () => 'native' },
      ArrayBuffer: Object.assign(function ArrayBuffer() {}, {
        prototype: { transfer: () => 'native', transferToFixedLength: () => 'native' },
      }),
    };
    installPdfjsPolyfills(native);
    expect(native.Promise.withResolvers()).toBe('native');
    expect(native.ArrayBuffer.prototype.transfer()).toBe('native');
    expect(native.ArrayBuffer.prototype.transferToFixedLength()).toBe('native');
  });

  it('runs on a bare global without throwing', () => {
    expect(() => installPdfjsPolyfills({})).not.toThrow();
  });
});

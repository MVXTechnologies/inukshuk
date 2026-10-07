/**
 * Runtime polyfills pdf.js 6 needs on the oldest WebViews the app supports.
 *
 * The app runs on iOS 16.4+ (WKWebView = that iOS's WebKit, never updated
 * separately) and Android 8+ (Android System WebView, updated through the
 * Play Store). pdf.js' legacy build is Babel-lowered and carries core-js for
 * most newer built-ins, but its own support table stops at Safari 18 and
 * Chrome 125. Measured on the shipped 6.4.299 legacy build (Babel's
 * usage-based core-js detection for `ios 16.4` / `chrome 110`, minus what the
 * build already polyfills, plus MDN compat data for the web APIs it calls),
 * it still calls, unguarded:
 *
 * - `Promise.withResolvers` (Safari 17.4, Chrome 119): everywhere, from the
 *   first `getDocument` (the worker's capability, the loading task). Without
 *   it nothing renders.
 * - `ArrayBuffer.prototype.transferToFixedLength` / `transfer` (Safari 17.4,
 *   Chrome 114): the worker packs every embedded font's info with it, so a
 *   page with text fails on iOS 16.4–17.3.
 * - `ReadableStream.prototype[Symbol.asyncIterator]` (Chrome 124; Safari has
 *   none before iOS 27): the worker reads `DecompressionStream` output with
 *   `for await`. pdf.js catches the TypeError and inflates the image again in
 *   JavaScript, so without it every Flate image is decoded twice over on iOS.
 *
 * Everything else pdf.js uses on our paths exists from iOS 16.4 and Chrome
 * 110 (or pdf.js checks for it first: `Float16Array`, `ImageDecoder`,
 * `crypto.randomUUID`). `AbortSignal.any` (Safari 17.4) is only called by the
 * annotation editor and touch manager, which the rasterizer never creates.
 * `Response.prototype.bytes` / `Blob.prototype.bytes` pdf.js polyfills
 * itself.
 *
 * Plain ES5 **source text**, like `pdfLayers.ts`: the page runs it as a
 * classic script before pdf.js loads, and the worker gets it prepended to
 * its module source. Each polyfill installs only when the engine lacks the
 * method, so on current engines this is a no-op.
 */
export const PDFJS_POLYFILL_SOURCE = String.raw`(function (root) {
  'use strict';
  function define(target, name, value) {
    if (!target || typeof target[name] === 'function') return;
    try {
      Object.defineProperty(target, name, { value: value, writable: true, configurable: true, enumerable: false });
    } catch (e) {}
  }
  var P = root.Promise;
  if (P) {
    define(P, 'withResolvers', function withResolvers() {
      var resolve, reject;
      var promise = new this(function (res, rej) { resolve = res; reject = rej; });
      return { promise: promise, resolve: resolve, reject: reject };
    });
  }
  var AB = root.ArrayBuffer;
  if (AB && AB.prototype) {
    // A copy, not a detaching move: pdf.js only reads the result (the
    // original is never touched again), and a copy is all ES5 can do.
    var transfer = function (newLength) {
      if (!(this instanceof AB)) throw new TypeError('not an ArrayBuffer');
      var length = newLength === undefined ? this.byteLength : Number(newLength);
      if (!(length >= 0) || length !== Math.floor(length)) throw new RangeError('invalid length');
      var out = new AB(length);
      new Uint8Array(out).set(new Uint8Array(this, 0, Math.min(length, this.byteLength)));
      return out;
    };
    define(AB.prototype, 'transfer', transfer);
    define(AB.prototype, 'transferToFixedLength', transfer);
  }
  var RS = root.ReadableStream;
  var ITERATOR = typeof Symbol === 'function' && Symbol.asyncIterator;
  if (RS && RS.prototype && ITERATOR && typeof RS.prototype[ITERATOR] !== 'function') {
    var values = function (options) {
      var reader = this.getReader();
      var preventCancel = !!(options && options.preventCancel);
      var iterator = {
        next: function () {
          return reader.read().then(function (result) {
            if (result.done) reader.releaseLock();
            return result;
          });
        },
        'return': function (value) {
          var settle = preventCancel ? Promise.resolve() : reader.cancel(value);
          return settle.then(function () {
            reader.releaseLock();
            return { done: true, value: value };
          });
        },
      };
      iterator[ITERATOR] = function () { return this; };
      return iterator;
    };
    define(RS.prototype, 'values', values);
    try {
      Object.defineProperty(RS.prototype, ITERATOR, { value: values, writable: true, configurable: true, enumerable: false });
    } catch (e) {}
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
`;

/**
 * Evaluate {@link PDFJS_POLYFILL_SOURCE} against `root` (tests). The app never
 * calls this: it ships the source text to the WebView.
 */
export function installPdfjsPolyfills(root: object): void {
  new Function('self', 'globalThis', PDFJS_POLYFILL_SOURCE)(root, root);
}

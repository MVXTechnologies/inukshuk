/**
 * Test-only: the SHIPPED pdf.js 6 (assets/pdfjs/*.pdfjs, ES modules) running
 * in a fresh JavaScript realm under Node, with its worker on the same thread
 * (pdf.js' "fake worker", the WebView page's main-thread fallback).
 *
 * Jest runs CommonJS; native ES modules in a vm need Node's
 * `--experimental-vm-modules`, which also makes Jest load every `"type":
 * "module"` dependency natively and breaks unrelated suites. So a module is
 * evaluated as a strict-mode function body instead, with the only two
 * module-only constructs the pdf.js builds use rewritten
 * ({@link moduleAsScript}): the single trailing `export {…}` (its bindings
 * are also published on `globalThis.pdfjsLib` / `pdfjsWorker`, which is what
 * the page uses), and `import.meta.url` (read only inside the wasm decoders'
 * factories, inside a try). Everything else is the exact shipped text.
 *
 * The realm is a browser-shaped global without `process`, so pdf.js takes
 * its browser code paths. It gets Node's web platform objects (Blob, URL,
 * streams…) and its own JavaScript built-ins.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

export const PDFJS_ASSET_DIR = join(__dirname, '../../../assets/pdfjs');

export function readPdfjsAsset(name: string): string {
  return readFileSync(join(PDFJS_ASSET_DIR, name), 'utf8');
}

export const PDFJS_MAIN_SOURCE = readPdfjsAsset('pdf.legacy.min.mjs.pdfjs');
export const PDFJS_WORKER_SOURCE = readPdfjsAsset('pdf.worker.legacy.min.mjs.pdfjs');

const EXPORT_STATEMENT = /\bexport\s*\{[^}]*\}\s*;?/g;

/**
 * An ES module's text as a classic script with the same scoping: a strict
 * function body (module scope, `this` undefined). Throws when the text uses
 * module syntax this does not handle, so a future build cannot slip past.
 */
export function moduleAsScript(source: string, identifier = 'inline.mjs'): string {
  const exports = source.match(EXPORT_STATEMENT) ?? [];
  if (exports.length > 1) throw new Error(`${identifier}: ${exports.length} export statements`);
  const body = source.replace(EXPORT_STATEMENT, '').replace(/\bimport\.meta\.url\b/g, 'undefined');
  if (
    /\bimport\.meta\b|^\s*import[\s{*]|\bexport\s+(default|const|let|var|function|class)\b/m.test(
      body,
    )
  ) {
    throw new Error(`${identifier}: module syntax the test realm cannot run`);
  }
  return `(function () {\n'use strict';\n${body}\n}).call(undefined);`;
}

/** Evaluate an ES module's text in `context` (see {@link moduleAsScript}). */
export function evaluateModule(
  source: string,
  context: vm.Context,
  identifier = 'inline.mjs',
): void {
  vm.runInContext(moduleAsScript(source, identifier), context, { filename: identifier });
}

/**
 * `structuredClone` for a vm realm, built from that realm's own constructors.
 * Node's is not usable: Jest's environment replaces it with a polyfill that
 * rejects `structuredClone(value, null)` (pdf.js' LoopbackPort passes that),
 * and a host-realm clone would hand pdf.js objects whose `instanceof` checks
 * fail. Covers what pdf.js posts between its main thread and worker: plain
 * objects and arrays, typed arrays and their buffers, Map, Set, Date and
 * cycles. Transfer lists are accepted and the data copied, as a clone would.
 */
const REALM_STRUCTURED_CLONE = String.raw`(function (root) {
  function clone(value, seen) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    var out;
    if (ArrayBuffer.isView(value)) {
      var buffer = clone(value.buffer, seen);
      out = value instanceof DataView
        ? new DataView(buffer, value.byteOffset, value.byteLength)
        : new value.constructor(buffer, value.byteOffset, value.length);
      seen.set(value, out);
      return out;
    }
    if (value instanceof ArrayBuffer) {
      out = value.slice(0);
      seen.set(value, out);
      return out;
    }
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof Map) {
      out = new Map();
      seen.set(value, out);
      value.forEach(function (v, k) { out.set(clone(k, seen), clone(v, seen)); });
      return out;
    }
    if (value instanceof Set) {
      out = new Set();
      seen.set(value, out);
      value.forEach(function (v) { out.add(clone(v, seen)); });
      return out;
    }
    if (typeof value === 'function') throw new DOMException('function could not be cloned', 'DataCloneError');
    out = Array.isArray(value) ? [] : {};
    seen.set(value, out);
    Object.keys(value).forEach(function (k) { out[k] = clone(value[k], seen); });
    return out;
  }
  root.structuredClone = function structuredClone(value) { return clone(value, new Map()); };
})(globalThis);`;

/** Web platform globals a WebView page has and a bare vm context lacks. */
export function webGlobals(): Record<string, unknown> {
  return {
    Blob,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    AbortController,
    AbortSignal,
    ReadableStream,
    WritableStream,
    TransformStream,
    CompressionStream,
    DecompressionStream,
    Response,
    Request,
    Headers,
    DOMException,
    Event,
    EventTarget,
    atob,
    btoa,
    performance,
    crypto,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
}

/** Give a vm realm its own `structuredClone` (see REALM_STRUCTURED_CLONE). */
export function installRealmStructuredClone(context: vm.Context): void {
  vm.runInContext(REALM_STRUCTURED_CLONE, context);
}

/** A silent console: pdf.js warns about fonts and canvas under Node. */
export const quietConsole = {
  log: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface PdfjsRealm {
  context: vm.Context;
  pdfjs: Record<string, unknown> & {
    getDocument(params: object): { promise: Promise<unknown>; destroy(): Promise<void> };
    OPS: Record<string, number>;
    version: string;
  };
}

/**
 * pdf.js main + worker in a new realm, the worker module evaluated first so
 * pdf.js finds `globalThis.pdfjsWorker` and runs it on this thread.
 */
export function loadPdfjsRealm(
  workerSource: string = PDFJS_WORKER_SOURCE,
  globals: Record<string, unknown> = {},
): Promise<PdfjsRealm> {
  const sandbox: Record<string, unknown> = { console: quietConsole, ...webGlobals(), ...globals };
  const context = vm.createContext(sandbox);
  vm.runInContext('globalThis.self = globalThis; globalThis.window = globalThis;', context);
  installRealmStructuredClone(context);
  evaluateModule(workerSource, context, 'pdf.worker.mjs');
  evaluateModule(PDFJS_MAIN_SOURCE, context, 'pdf.mjs');
  const pdfjs = (context as { pdfjsLib?: PdfjsRealm['pdfjs'] }).pdfjsLib;
  if (!pdfjs) return Promise.reject(new Error('pdf.mjs did not define globalThis.pdfjsLib'));
  return Promise.resolve({ context, pdfjs });
}

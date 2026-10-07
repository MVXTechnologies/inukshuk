/**
 * GHSA-wgrm-67xf-hhpq / CVE-2024-4367 ("PDF.js vulnerable to arbitrary
 * JavaScript execution upon opening a malicious PDF"): a font's FontMatrix
 * reached glyph code that pdf.js ≤ 4.1.392 compiled with `new Function`.
 *
 * The app now ships pdf.js 6 (fixed since 4.2.67, and with no eval path at
 * all; `scripts/pdfjs/assets.test.mjs` pins the version and the absence of
 * string-compiling sinks in every shipped file). Defence in depth stays:
 *
 * - every document the page opens still passes `isEvalSupported: false` (a
 *   no-op in 6.x, a guard should a future build bring an eval path back),
 *   asks the page for the wasm decoders instead of fetching anything
 *   (`useWorkerFetch: false`), and never enables scripting — on the served
 *   and inline paths and the watchdog's retry of each;
 * - the page's Content-Security-Policy has no `'unsafe-eval'`, so the engine
 *   itself refuses to compile a string as JavaScript, on the page and in its
 *   worker, and fetches stay on the page's own origin.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { writeServedText } from '@data/localServer';
import React from 'react';
import { renderHook } from '@testing-library/react-native';
import {
  PdfRasterizerProvider,
  RASTERIZER_PAGE_CSP,
  scriptSafe,
  usePdfRasterizer,
} from './PdfRasterizer';

jest.mock(
  '@data/pdfRenderRecovery',
  () => ({ beginPdfRender: () => 'token', finishPdfRender: jest.fn() }),
  { virtual: true },
);
jest.mock('@data/nativePdf', () => ({
  nativePdfAvailable: () => false,
  renderNativePdfCrop: jest.fn(),
  deleteNativePdfOutput: jest.fn(),
}));
jest.mock('react-native-webview', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    WebView: React.forwardRef(function MockWebView(_props, ref) {
      React.useImperativeHandle(ref, () => ({ injectJavaScript: jest.fn() }));
      return null;
    }),
  };
});
// The bundled pdf.js sources (see ./pdfjsAssets); these tests script pdf.js.
jest.mock('./pdfjsAssets', () => ({
  loadPdfjsSources: async () => ({ main: '', worker: '', wasm: {}, fallbacks: {} }),
  stagePdfjsFallbacks: async () => undefined,
}));
jest.mock('@data/localServer', () => ({
  acquireLocalServer: async () => ({
    value: 'http://127.0.0.1:8080',
    release: async () => undefined,
  }),
  probeLocalServer: async () => true,
  restartLocalServer: async (origin: string) => origin,
  writeServedText: jest.fn(),
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

const ASSETS = join(__dirname, '../../../assets/pdfjs');
// The page's load watchdog (LOAD_WATCHDOG_MS); fired at once here so each
// render also exercises the retry, which builds its own getDocument params.
const LOAD_WATCHDOG_MS = 12000;

type Posted = { id: string; ok: boolean; error?: string };

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <PdfRasterizerProvider>{children}</PdfRasterizerProvider>
);

/** Run the provider's real page script against a pdf.js that records getDocument params. */
async function loadPage() {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  const html = jest.mocked(writeServedText).mock.calls.at(-1)?.[1] ?? '';
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
  expect(script).toBeDefined();
  const opened: Record<string, unknown>[] = [];
  const posted: Posted[] = [];
  const window: Record<string, unknown> = {
    location: { href: 'http://127.0.0.1:8080/.rasterizer/index.html' },
    URL,
    Blob,
    atob: (b64: string) => Buffer.from(b64, 'base64').toString('binary'),
    document: { getElementById: () => null },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms === LOAD_WATCHDOG_MS ? 0 : ms),
    clearTimeout,
    ReactNativeWebView: {
      postMessage: (message: string) => posted.push(JSON.parse(message) as Posted),
    },
    // The main-thread worker (#554) counts as available, so the watchdog's
    // retry always reaches getDocument.
    pdfjsWorker: { WorkerMessageHandler: {} },
    pdfjsLib: {
      GlobalWorkerOptions: { workerSrc: '' },
      // A document that never opens: the watchdog stalls it, the page retries
      // once, stalls again and reports — two getDocument calls per render.
      getDocument: (params: Record<string, unknown>) => {
        opened.push(params);
        return {
          onProgress: null,
          promise: new Promise<never>(() => undefined),
          destroy: async () => undefined,
        };
      },
    },
  };
  window.window = window;
  runInNewContext(script!, window);
  return { view, window, opened, posted };
}

async function settled(posted: Posted[], id: string): Promise<Posted> {
  for (let i = 0; i < 100; i++) {
    const message = posted.find((m) => m.id === id);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no result posted for ${id}`);
}

it('opens every document without eval, worker fetches or scripting (served, inline, both retries)', async () => {
  const { view, window, opened, posted } = await loadPage();
  const page = window as unknown as {
    __pdfRender: (id: string, pageIndex: number, width: number, url: string | null) => void;
    __pdfReset: () => void;
    __pdfAppend: (chunk: string) => void;
  };

  page.__pdfRender('served', 0, 512, 'http://127.0.0.1:8080/maps/m.pdf');
  expect(await settled(posted, 'served')).toMatchObject({ ok: false });

  page.__pdfReset();
  page.__pdfAppend(Buffer.from('%PDF-1.7\n').toString('base64'));
  page.__pdfRender('inline', 0, 512, null);
  expect(await settled(posted, 'inline')).toMatchObject({ ok: false });

  // First attempt and watchdog retry, for each source kind.
  expect(opened.map((p) => ('url' in p ? 'url' : 'data'))).toEqual(['url', 'url', 'data', 'data']);
  for (const params of opened) {
    expect(params.isEvalSupported).toBe(false);
    expect(params.useWorkerFetch).toBe(false);
    expect(params.isImageDecoderSupported).toBe(false);
    expect(typeof params.BinaryDataFactory).toBe('function');
    expect(params.enableScripting).not.toBe(true);
  }
  await view.unmount();
});

describe('the page Content-Security-Policy', () => {
  it('is in the page and forbids compiling strings as JavaScript', async () => {
    const view = await renderHook(usePdfRasterizer, { wrapper });
    const html = jest.mocked(writeServedText).mock.calls.at(-1)?.[1] ?? '';
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
    expect(meta).toBe(RASTERIZER_PAGE_CSP);
    // The policy is the first thing in <head>, before any script.
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'));
    await view.unmount();
  });

  it('allows the inlined scripts, the Blob worker and wasm, and nothing that evaluates strings', () => {
    const directives = Object.fromEntries(
      RASTERIZER_PAGE_CSP.split(';').map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values];
      }),
    );
    expect(directives['script-src']).toEqual([
      "'self'",
      "'unsafe-inline'",
      'blob:',
      "'wasm-unsafe-eval'",
    ]);
    expect(RASTERIZER_PAGE_CSP).not.toContain("'unsafe-eval'");
    expect(directives['connect-src']).toEqual(["'self'", 'blob:', 'data:']);
    expect(directives['object-src']).toEqual(["'none'"]);
  });
});

describe('scriptSafe', () => {
  it('keeps an inlined script from closing its element', () => {
    expect(scriptSafe('a="</script><script>x</SCRIPT>"')).toBe(
      'a="<\\/script><script>x<\\/SCRIPT>"',
    );
  });

  it('leaves the shipped pdf.js unchanged (no sequence needs escaping)', () => {
    for (const asset of ['pdf.legacy.min.mjs.pdfjs', 'pdf.worker.legacy.min.mjs.pdfjs']) {
      const source = readFileSync(join(ASSETS, asset), 'utf8');
      expect(scriptSafe(source)).toBe(source);
      // An HTML comment opener would change how the parser reads the element.
      expect(source).not.toContain('<!--');
    }
  });
});

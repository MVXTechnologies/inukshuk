/**
 * Pins the mitigation for GHSA-wgrm-67xf-hhpq / CVE-2024-4367 ("PDF.js
 * vulnerable to arbitrary JavaScript execution upon opening a malicious PDF")
 * while the app still ships pdf.js 3.11.174.
 *
 * The bug: a font's FontMatrix is copied unchecked into glyph-drawing code
 * that pdf.js compiles with `new Function` — but only when `isEvalSupported`
 * is true (pdf.js' default). With `isEvalSupported: false` pdf.js draws glyphs
 * through a plain command loop and never evaluates PDF-derived text; the same
 * flag also stops the worker compiling PostScript (Type 4) functions. Every
 * document the page opens must therefore pass it: the served and inline
 * paths, and the watchdog's retry of each.
 *
 * The second half checks the shipped asset is still the build whose eval
 * sinks are gated on that flag. Replacing the asset (the pdf.js upgrade that
 * actually fixes the advisory) fails here on purpose: re-review, then update.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { writeServedText } from '@data/localServer';
import React from 'react';
import { renderHook } from '@testing-library/react-native';
import { PdfRasterizerProvider, usePdfRasterizer } from './PdfRasterizer';

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
jest.mock('../../../assets/pdfjs/pdf.legacy.min.js.pdfjs', () => 1);
jest.mock('../../../assets/pdfjs/pdf.worker.legacy.min.js.pdfjs', () => 2);
jest.mock('expo-asset', () => ({
  Asset: { fromModule: () => ({ downloadAsync: async () => ({ localUri: 'file://asset' }) }) },
}));
jest.mock('expo-file-system', () => ({
  File: class {
    async text() {
      return '';
    }
  },
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

it('opens every document with isEvalSupported: false (served, inline, and both retries)', async () => {
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
  for (const params of opened) expect(params.isEvalSupported).toBe(false);
  await view.unmount();
});

describe('shipped pdf.js 3.11 asset', () => {
  const main = readFileSync(join(ASSETS, 'pdf.legacy.min.js.pdfjs'), 'utf8');
  const worker = readFileSync(join(ASSETS, 'pdf.worker.legacy.min.js.pdfjs'), 'utf8');

  it('is the build this mitigation was reviewed against', () => {
    expect(main).toContain('const version="3.11.174"');
  });

  it('compiles glyphs with new Function only behind the isEvalSupported option', () => {
    // The CVE-2024-4367 sink. Its only other `new Function` is the
    // FeatureTest probe `new Function("")`.
    expect(main.match(/new Function\(/g)).toHaveLength(2);
    expect(main).toContain('new Function("")');
    expect(main).toMatch(
      /if\(this\.isEvalSupported&&\w+\.FeatureTest\.isEvalSupported\)\{[^]{0,200}?new Function\("c","size"/,
    );
    // ...and the option reaches FontFaceObject from getDocument's params.
    expect(main).toMatch(/_=!1!==t\.isEvalSupported/);
    expect(main).toMatch(
      /new _font_loader\.FontFaceObject\(\w+,\{isEvalSupported:\w+\.isEvalSupported/,
    );
  });

  it('compiles PostScript functions in the worker only behind the same option', () => {
    expect(worker.match(/new Function\(/g)).toHaveLength(2);
    expect(worker).toMatch(
      /if\(\w+&&\w+\.FeatureTest\.isEvalSupported\)\{const \w+=\(new PostScriptCompiler\)\.compile/,
    );
  });
});

/**
 * Main-thread worker setup must fail cleanly. If the page cannot register its
 * load listeners, it must not throw out of the page script or leave its
 * 10 s load timer armed. A leaked timer fired later, in whatever ran next,
 * and called a listener API the page had already found missing.
 */
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
jest.mock('react-native-webview', () => ({ WebView: () => null }));
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

it('leaves no timer behind when the page cannot listen for load errors', async () => {
  await renderHook(usePdfRasterizer, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <PdfRasterizerProvider>{children}</PdfRasterizerProvider>
    ),
  });
  const html = jest.mocked(writeServedText).mock.calls.at(-1)?.[1] ?? '';
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
  const armed = new Set<number>();
  let nextTimer = 1;
  const posted: string[] = [];
  // Inline mode (about:blank) loads the worker on the main thread at start.
  const window: Record<string, unknown> = {
    location: { href: 'about:blank', origin: 'null' },
    document: { getElementById: () => null, createElement: () => ({}) },
    setTimeout: () => {
      const id = nextTimer++;
      armed.add(id);
      return id;
    },
    clearTimeout: (id: number) => armed.delete(id),
    ReactNativeWebView: { postMessage: (m: string) => posted.push(m) },
    pdfjsLib: { GlobalWorkerOptions: { workerSrc: '' }, getDocument: jest.fn() },
  };
  window.window = window;
  expect(() => runInNewContext(script!, window)).not.toThrow();
  await new Promise((resolve) => setImmediate(resolve));
  expect(armed.size).toBe(0);
  expect(posted.some((m) => m.includes('__ready__'))).toBe(true);
});

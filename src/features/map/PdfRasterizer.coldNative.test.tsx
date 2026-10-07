import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { fnv1a32 } from '@core/encoding/fnv1a';
import { persistentNativeGeometryKey } from '@core/geo/nativePdfSupport';
import { PDF_LAYER_RUNTIME_SOURCE } from '@core/geo/pdfLayers';
import { renderNativePdfCrop } from '@data/nativePdf';
import { saveVerifiedNativePages } from '@data/nativePdfGeometry';
import { PdfRasterizerProvider, usePdfRasterizer } from './PdfRasterizer';

/**
 * A cold launch: the pdf.js page has not loaded yet, but an earlier launch
 * verified this page for the native renderer. Its crop must not wait.
 */
const mockInject = jest.fn();
let mockOnMessage: ((event: { nativeEvent: { data: string } }) => void) | null = null;
const mockLoad = jest.fn<string[], []>(() => []);
jest.mock('@data/nativePdfGeometry', () => ({
  loadVerifiedNativePages: () => mockLoad(),
  saveVerifiedNativePages: jest.fn(),
}));
jest.mock('@data/pdfRenderRecovery', () => ({
  beginPdfRender: () => 'token',
  finishPdfRender: () => undefined,
}));
jest.mock('react-native-webview', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    WebView: React.forwardRef(function MockWebView(
      props: { onMessage: (event: { nativeEvent: { data: string } }) => void },
      ref,
    ) {
      mockOnMessage = props.onMessage;
      React.useImperativeHandle(ref, () => ({ injectJavaScript: mockInject }));
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
jest.mock('@data/nativePdf', () => ({
  nativePdfAvailable: jest.fn(() => true),
  renderNativePdfCrop: jest.fn(),
  deleteNativePdfOutput: jest.fn(),
}));

const nativePage = {
  fileUri: 'file:///docs/maps/map.pdf',
  revision: 'v1',
  expectedPageWidthPt: 1000,
  expectedPageHeightPt: 800,
};
const request = {
  source: { url: 'http://127.0.0.1:8080/maps/map.pdf' },
  pageIndex: 0,
  crop: { x0: 0.25, y0: 0.25, x1: 0.5, y1: 0.5 },
  nativePage,
};
const persistedKey = persistentNativeGeometryKey(
  { fileUri: nativePage.fileUri, revision: 'v1', pageIndex: 0, widthPt: 1000, heightPt: 800 },
  fnv1a32(PDF_LAYER_RUNTIME_SOURCE),
);
const result = {
  fileUri: 'file:///detail.png',
  widthPx: 250,
  heightPx: 200,
  pageWidthPt: 1000,
  pageHeightPt: 800,
  pageCount: 1,
  loadMs: 1,
  renderMs: 2,
};
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <PdfRasterizerProvider>{children}</PdfRasterizerProvider>
);
const settle = () => act(async () => undefined);

beforeEach(() => {
  mockInject.mockReset();
  jest.mocked(renderNativePdfCrop).mockReset().mockResolvedValue(result);
});

it('draws a crop of a page verified in an earlier launch before the pdf.js page is ready', async () => {
  mockLoad.mockReturnValue([persistedKey]);
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await settle();
  await expect(view.result.current(request)).resolves.toEqual(result);
  expect(renderNativePdfCrop).toHaveBeenCalledTimes(1);
  // pdf.js was never asked to open the page.
  expect(mockInject.mock.calls.some(([s]) => String(s).includes('__pdfRender'))).toBe(false);
  await view.unmount();
});

it('waits for the pdf.js page to verify a page it has never seen', async () => {
  mockLoad.mockReturnValue([]);
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await settle();
  const pending = view.result.current(request).catch(() => undefined);
  await settle();
  expect(renderNativePdfCrop).not.toHaveBeenCalled();
  await view.unmount();
  await pending;
});

it('never skips the page for a see-through tile (keying needs it)', async () => {
  mockLoad.mockReturnValue([persistedKey]);
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await settle();
  const pending = view.result.current({ ...request, whiteKey: 2 }).catch(() => undefined);
  await settle();
  expect(renderNativePdfCrop).not.toHaveBeenCalled();
  expect(saveVerifiedNativePages).not.toHaveBeenCalled();
  await view.unmount();
  await pending;
});

it('skips the native renderer for a page it refused in an earlier launch', async () => {
  mockLoad.mockReturnValue([`U${persistedKey}`]);
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await settle();
  const pending = view.result.current(request).catch(() => undefined);
  await settle();
  await act(async () => {
    mockOnMessage?.({ nativeEvent: { data: JSON.stringify({ id: '__ready__', ok: true }) } });
  });
  // pdf.js draws the crop itself, without the native handoff.
  const renders = mockInject.mock.calls
    .map(([s]) => String(s))
    .filter((s) => s.includes('__pdfRender'));
  expect(renders).toHaveLength(1);
  expect(renders[0]).not.toContain('expectedPageWidthPt');
  expect(renderNativePdfCrop).not.toHaveBeenCalled();
  await view.unmount();
  await pending;
});

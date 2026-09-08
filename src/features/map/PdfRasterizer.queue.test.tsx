import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { PdfRasterizerProvider, usePdfRasterizer } from './PdfRasterizer';

const mockInject = jest.fn();
let mockProps: { onMessage: (event: { nativeEvent: { data: string } }) => void };
let mockMounts = 0;
jest.mock('react-native-webview', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    WebView: React.forwardRef(function MockWebView(props: typeof mockProps, ref) {
      mockProps = props;
      React.useImperativeHandle(ref, () => ({ injectJavaScript: mockInject }));
      React.useEffect(() => {
        mockMounts += 1;
      }, []);
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
  writeServedText: jest.fn(),
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

const request = { source: { base64: 'PDF' }, pageIndex: 0 };
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <PdfRasterizerProvider>{children}</PdfRasterizerProvider>
);
async function ready() {
  await act(async () => {
    mockProps.onMessage({ nativeEvent: { data: JSON.stringify({ id: '__ready__', ok: true }) } });
  });
}
const renders = () =>
  mockInject.mock.calls.filter(([script]) => String(script).includes('window.__pdfRender'));

beforeEach(() => {
  jest.useFakeTimers();
  mockMounts = 0;
});
afterEach(() => jest.useRealTimers());

it('removes a request that expires while the engine is still loading', async () => {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  const expired = view.result.current(request).catch((error: Error) => error);
  await act(async () => {
    jest.advanceTimersByTime(30_000);
  });
  const next = view.result.current(request).catch((error: Error) => error);
  await act(async () => {
    jest.advanceTimersByTime(15_000);
  });
  expect(await expired).toBeInstanceOf(Error);
  await ready();
  expect(renders()).toHaveLength(1);
  expect(renders()[0]?.[0]).toContain('req-2');
  await view.unmount();
  await next;
});

it('replaces a timed-out engine before starting another render', async () => {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const retiredMessage = mockProps.onMessage;
  const first = view.result.current(request).catch((error: Error) => error);
  await act(async () => {
    jest.advanceTimersByTime(30_000);
  });
  const next = view.result.current(request).catch((error: Error) => error);
  await act(async () => {
    jest.advanceTimersByTime(15_000);
  });
  expect(await first).toBeInstanceOf(Error);
  expect(mockMounts).toBe(2);
  expect(renders()).toHaveLength(1);
  await act(async () => {
    retiredMessage({
      nativeEvent: { data: JSON.stringify({ id: 'req-1', ok: false, error: 'late failure' }) },
    });
  });
  expect(renders()).toHaveLength(1);
  await ready();
  expect(renders()).toHaveLength(2);
  expect(renders()[1]?.[0]).toContain('req-2');
  const result = {
    pngDataUri: 'data:image/png;base64,PNG',
    widthPx: 2048,
    heightPx: 1024,
    pageWidthPt: 100,
    pageHeightPt: 50,
    pageCount: 1,
    loadMs: 1,
    renderMs: 2,
  };
  await act(async () => {
    mockProps.onMessage({
      nativeEvent: { data: JSON.stringify({ id: 'req-2', ok: true, ...result }) },
    });
  });
  expect(await next).toEqual(result);
  await view.unmount();
});

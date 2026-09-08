import { runInNewContext } from 'node:vm';
import { writeServedText } from '@data/localServer';
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

it.each([{ base64: 'PDF' }, { url: 'http://127.0.0.1:8080/maps/test.pdf' }])(
  'forwards a requested crop to the engine with source %j',
  async (source) => {
    const view = await renderHook(usePdfRasterizer, { wrapper });
    await ready();
    const crop = { x0: 0.25, y0: 0.5, x1: 0.5, y1: 0.75 };
    const pending = view.result.current({ ...request, source, crop }).catch(() => undefined);
    expect(renders()[0]?.[0]).toContain(JSON.stringify(crop));
    await view.unmount();
    await pending;
  },
);

it('gives a dispatched request a full render budget after engine startup', async () => {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  const rejected = jest.fn();
  const pending = view.result.current(request).catch(rejected);
  await act(async () => {
    jest.advanceTimersByTime(30_000);
  });
  await ready();
  await act(async () => {
    jest.advanceTimersByTime(16_000);
  });
  expect(rejected).not.toHaveBeenCalled();
  expect(mockMounts).toBe(1);
  await act(async () => {
    jest.advanceTimersByTime(29_000);
  });
  expect(rejected).toHaveBeenCalledTimes(1);
  await view.unmount();
  await pending;
});

it.each([false, true])(
  'waits for crop document destruction (cleanup failure: %s)',
  async (fail) => {
    const view = await renderHook(usePdfRasterizer, { wrapper });
    const html = jest.mocked(writeServedText).mock.calls.at(-1)?.[1] ?? '';
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
    expect(script).toBeDefined();
    const posted: Record<string, unknown>[] = [];
    const draws: Record<string, unknown>[] = [];
    const ctx = { fillStyle: '', fillRect: jest.fn() };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      toDataURL: () => 'data:image/png;base64,PNG',
    };
    const page = {
      getViewport: ({ scale, rotation }: { scale: number; rotation: number }) => {
        expect(rotation).toBe(0);
        return { width: 1000 * scale, height: 800 * scale };
      },
      render: (args: Record<string, unknown>) => {
        draws.push({ ...args, width: canvas.width, height: canvas.height });
        return { promise: Promise.resolve() };
      },
    };
    const doc = { numPages: 1, getPage: async () => page, cleanup: jest.fn() };
    let finishDestroy!: () => void;
    const destroyed = new Promise<void>((resolve, reject) => {
      finishDestroy = () => (fail ? reject(new Error('cleanup failed')) : resolve());
    });
    const window = {
      pdfjsLib: {
        GlobalWorkerOptions: { workerSrc: '' },
        getDocument: () => ({ promise: Promise.resolve(doc), destroy: () => destroyed }),
      },
      ReactNativeWebView: { postMessage: (message: string) => posted.push(JSON.parse(message)) },
      __pdfRender: undefined as
        undefined | ((id: string, page: number, width: number, url: string, crop: object) => void),
    };
    runInNewContext(script!, {
      window,
      document: { getElementById: () => canvas },
      setTimeout,
      clearTimeout,
    });
    await act(async () => {
      window.__pdfRender!('crop', 0, 1000, 'http://localhost/maps/a.pdf', {
        x0: 0.25,
        y0: 0.5,
        x1: 0.5,
        y1: 0.75,
      });
    });
    expect(draws[0]).toMatchObject({
      width: 1000,
      height: 800,
      transform: [1, 0, 0, 1, -1000, -1600],
    });
    expect(posted.some((message) => message.id === 'crop')).toBe(false);
    await act(async () => {
      finishDestroy();
    });
    expect(posted.at(-1)).toMatchObject(
      fail
        ? {
            id: 'crop',
            ok: false,
            resetEngine: true,
          }
        : {
            id: 'crop',
            ok: true,
            pageWidthPt: 1000,
            pageHeightPt: 800,
            widthPx: 1000,
            heightPx: 800,
          },
    );
    expect(canvas.width).toBe(1);
    await view.unmount();
  },
);

it('replaces the engine after cleanup failure before dispatching waiting work', async () => {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const first = view.result.current(request).catch(() => undefined);
  const next = view.result.current(request).catch(() => undefined);
  await act(async () => {
    mockProps.onMessage({
      nativeEvent: {
        data: JSON.stringify({
          id: 'req-1',
          ok: false,
          error: 'cleanup failed',
          resetEngine: true,
        }),
      },
    });
  });
  expect(mockMounts).toBe(2);
  expect(renders()).toHaveLength(1);
  await ready();
  expect(renders()).toHaveLength(2);
  await view.unmount();
  await Promise.all([first, next]);
});

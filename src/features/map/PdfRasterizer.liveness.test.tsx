/**
 * Loopback liveness in the rasterizer (iOS resume: #381, #385 and the
 * "Load failed [served fetch: 1 requests, 1 failed; … (0 B read)]" cluster).
 *
 * The field signature is a served render whose FIRST request is refused —
 * the page loaded from the server earlier, and the server stopped accepting
 * connections since. These tests drive that signature, a resume, a failed
 * page load and a long idle through the provider, with the server's probe and
 * restart scripted, and pin what must happen: a dead server is restarted and
 * the page reloaded from it; the request that hit it is retried once; a
 * served failure never becomes a page failure; and URL rendering is given up
 * only when the server cannot be brought back.
 */
import React from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import { addBreadcrumb, reportError } from '@lib/errorReporting';
import { PdfRasterizerProvider, usePdfRasterizer, usePdfRasterizerServer } from './PdfRasterizer';
import { PdfLoopbackUnavailableError, PdfRenderNotStartedError } from './pdfRenderFailure';

const mockInject = jest.fn();
let mockProps: {
  source: { uri?: string; html?: string };
  onMessage: (event: { nativeEvent: { data: string } }) => void;
  onError: (event: { nativeEvent: { url: string; description: string } }) => void;
};
let mockMounts = 0;
jest.mock('react-native-webview', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    WebView: React.forwardRef(function MockWebView(props: typeof mockProps, ref) {
      React.useEffect(() => {
        mockProps = props;
      });
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
jest.mock('@data/pdfRenderRecovery', () => ({
  beginPdfRender: () => 'token',
  finishPdfRender: () => undefined,
}));
jest.mock('@data/nativePdf', () => ({
  nativePdfAvailable: () => false,
  renderNativePdfCrop: jest.fn(),
  deleteNativePdfOutput: jest.fn(),
}));
const ORIGIN = 'http://127.0.0.1:8080';
const NEW_ORIGIN = 'http://127.0.0.1:9090';
let mockOrigin = ORIGIN;
const mockProbe = jest.fn<Promise<boolean>, [string]>();
const mockRestart = jest.fn<Promise<string>, [string]>();
jest.mock('@data/localServer', () => ({
  acquireLocalServer: async () => ({
    get value() {
      return mockOrigin;
    },
    release: async () => undefined,
  }),
  probeLocalServer: (origin: string) => mockProbe(origin),
  restartLocalServer: (origin: string) => mockRestart(origin),
  writeServedText: jest.fn(),
}));
jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

/** The field report's exact wording for a refused first request. */
const REFUSED =
  'Load failed [served fetch: 1 requests, 1 failed; GET /maps/a.pdf (0 B read) failed: Load failed]';
const RESULT = {
  pngDataUri: 'data:image/png;base64,PNG',
  widthPx: 10,
  heightPx: 10,
  pageWidthPt: 100,
  pageHeightPt: 100,
  pageCount: 1,
  loadMs: 1,
  renderMs: 1,
};
const served = (origin = ORIGIN) => ({
  source: { url: `${origin}/maps/a.pdf` },
  pageIndex: 0,
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <PdfRasterizerProvider>{children}</PdfRasterizerProvider>
);
const useBoth = () => ({ rasterize: usePdfRasterizer(), serverOrigin: usePdfRasterizerServer() });
const post = async (data: object) => {
  await act(async () => {
    mockProps.onMessage({ nativeEvent: { data: JSON.stringify(data) } });
  });
};
const ready = () => post({ id: '__ready__', ok: true });
const fail = (id: string, error = REFUSED) => post({ id, ok: false, error });
const succeed = (id: string) => post({ id, ok: true, ...RESULT });
const renders = () =>
  mockInject.mock.calls
    .map(([script]) => String(script))
    .filter((script) => script.includes('window.__pdfRender('));
const pageUri = () => mockProps.source.uri ?? '';
const restartTo = (origin: string) =>
  mockRestart.mockImplementationOnce(async () => {
    mockOrigin = origin;
    return origin;
  });

let appStateListener: (state: AppStateStatus) => void = () => undefined;
async function goBackgroundAndReturn() {
  await act(async () => {
    appStateListener('inactive');
    appStateListener('background');
    appStateListener('active');
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockMounts = 0;
  mockOrigin = ORIGIN;
  mockProbe.mockReset().mockResolvedValue(true);
  mockRestart.mockReset().mockImplementation(async (origin) => origin);
  jest.mocked(AppState.addEventListener).mockImplementation((type, handler) => {
    if (type === 'change') appStateListener = handler as (state: AppStateStatus) => void;
    return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
  });
});
afterEach(() => jest.useRealTimers());

describe('a served request refused by the server', () => {
  it('restarts a dead server, reloads the page from it and retries the request there', async () => {
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    const pending = view.result.current.rasterize(served());
    expect(renders()).toHaveLength(1);

    mockProbe.mockResolvedValueOnce(false);
    restartTo(NEW_ORIGIN);
    await fail('req-1');
    expect(mockProbe).toHaveBeenCalledWith(ORIGIN);
    expect(mockRestart).toHaveBeenCalledWith(ORIGIN);
    expect(pageUri()).toMatch(/^http:\/\/127\.0\.0\.1:9090\/\.rasterizer\/index\.html\?v=/);
    expect(mockMounts).toBe(2);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Loopback server was unreachable (transport); restarted on a new port',
      }),
      'pdf-rasterizer-server-restart',
    );
    expect(await view.result.current.serverOrigin()).toBe(NEW_ORIGIN);

    // Nothing dispatches into the new page until it is ready; then the same
    // request goes out again, on the new origin.
    expect(renders()).toHaveLength(1);
    await ready();
    expect(renders()).toHaveLength(2);
    expect(renders()[1]).toContain(JSON.stringify(`${NEW_ORIGIN}/maps/a.pdf`));
    expect(renders()[1]).toContain('"req-1"');
    await succeed('req-1');
    await expect(pending).resolves.toMatchObject({ widthPx: 10 });
    await view.unmount();
  });

  it('retries once on a live server, then fails as "not started" so the page is never paused', async () => {
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    const pending = view.result.current.rasterize(served()).catch((error: unknown) => error);
    await fail('req-1');
    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(renders()).toHaveLength(2);
    await fail('req-1');
    const error = await pending;
    expect(error).toBeInstanceOf(PdfLoopbackUnavailableError);
    expect(error).toBeInstanceOf(PdfRenderNotStartedError);
    expect((error as Error).message).toBe(REFUSED);
    expect(mockRestart).not.toHaveBeenCalled();
    // The engine and the queue carry on.
    const next = view.result.current.rasterize(served());
    expect(renders()).toHaveLength(3);
    await succeed('req-2');
    await expect(next).resolves.toMatchObject({ pageCount: 1 });
    await view.unmount();
  });

  it('leaves a page failure that is not a transport failure to its caller', async () => {
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    const pending = view.result.current.rasterize(served()).catch((error: unknown) => error);
    await fail('req-1', 'Invalid PDF structure');
    const error = await pending;
    expect(error).not.toBeInstanceOf(PdfRenderNotStartedError);
    expect(mockProbe).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('moves a URL built on the old origin before the restart to the new one', async () => {
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    const first = view.result.current.rasterize(served());
    mockProbe.mockResolvedValueOnce(false);
    restartTo(NEW_ORIGIN);
    await fail('req-1');
    await ready();
    await succeed('req-1');
    await first;
    // A caller that asked for the origin before the restart still holds it.
    const late = view.result.current.rasterize(served(ORIGIN));
    expect(renders()[2]).toContain(JSON.stringify(`${NEW_ORIGIN}/maps/a.pdf`));
    await succeed('req-2');
    await late;
    await view.unmount();
  });

  it('gives up URL rendering only when the server cannot be restarted', async () => {
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    const pending = view.result.current.rasterize(served()).catch((error: unknown) => error);
    mockProbe.mockResolvedValueOnce(false);
    mockRestart.mockRejectedValueOnce(new Error('Loopback server did not stop within 3000 ms'));
    await fail('req-1');
    const error = await pending;
    expect(error).toBeInstanceOf(PdfLoopbackUnavailableError);
    expect((error as Error).message).toContain('did not stop within 3000 ms');
    expect(mockProps.source.html).toBeDefined();
    expect(await view.result.current.serverOrigin()).toBeNull();
    expect(jest.mocked(reportError).mock.calls.map(([, context]) => context)).toEqual([
      'pdf-rasterizer-server',
    ]);
    await view.unmount();
  });
});

describe('return from the background', () => {
  // #582: on iOS a listener found dead on resume is the documented socket
  // reclaim (TN2277), recovered without the user noticing: no report.
  it('restarts a listener iOS reclaimed while suspended without filing a report', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    mockProbe.mockResolvedValueOnce(false);
    await goBackgroundAndReturn();
    expect(mockRestart).toHaveBeenCalledWith(ORIGIN);
    expect(reportError).not.toHaveBeenCalledWith(
      expect.anything(),
      'pdf-rasterizer-server-restart',
    );
    expect(addBreadcrumb).toHaveBeenCalledWith(
      'Loopback server was unreachable (resume); restarted on the same port',
    );
    await ready();
    const rendered = view.result.current.rasterize(served());
    await succeed('req-1');
    await expect(rendered).resolves.toMatchObject({ widthPx: 10 });
    await view.unmount();
    os.restore();
  });

  it('still reports a listener found dead on resume on Android, where it is unexplained', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    mockProbe.mockResolvedValueOnce(false);
    await goBackgroundAndReturn();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Loopback server was unreachable (resume); restarted on the same port',
      }),
      'pdf-rasterizer-server-restart',
    );
    await view.unmount();
    os.restore();
  });

  it('holds served work while it checks the server, and restarts a dead one', async () => {
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    let answer!: (alive: boolean) => void;
    mockProbe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    restartTo(NEW_ORIGIN);
    await goBackgroundAndReturn();
    expect(mockProbe).toHaveBeenCalledTimes(1);

    let origin: string | null | undefined;
    void view.result.current.serverOrigin().then((value) => {
      origin = value;
    });
    const queued = view.result.current.rasterize(served());
    await act(async () => {});
    expect(origin).toBeUndefined();
    expect(renders()).toHaveLength(0);

    await act(async () => answer(false));
    expect(origin).toBe(NEW_ORIGIN);
    await ready();
    expect(renders()).toHaveLength(1);
    expect(renders()[0]).toContain(JSON.stringify(`${NEW_ORIGIN}/maps/a.pdf`));
    await succeed('req-1');
    await queued;
    await view.unmount();
  });

  it('puts the render in flight back in the queue instead of failing it', async () => {
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    const inFlight = view.result.current.rasterize(served());
    expect(renders()).toHaveLength(1);
    mockProbe.mockResolvedValueOnce(false);
    restartTo(NEW_ORIGIN);
    await goBackgroundAndReturn();
    expect(mockMounts).toBe(2);
    await ready();
    expect(renders()).toHaveLength(2);
    expect(renders()[1]).toContain(JSON.stringify(`${NEW_ORIGIN}/maps/a.pdf`));
    await succeed('req-1');
    await expect(inFlight).resolves.toMatchObject({ widthPx: 10 });
    await view.unmount();
  });

  it('keeps the page when the server survived', async () => {
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    await goBackgroundAndReturn();
    expect(mockProbe).toHaveBeenCalledWith(ORIGIN);
    expect(mockRestart).not.toHaveBeenCalled();
    expect(mockMounts).toBe(1);
    expect(await view.result.current.serverOrigin()).toBe(ORIGIN);
    await view.unmount();
  });

  it('does not probe for a transition that never reached the background', async () => {
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    await act(async () => {
      appStateListener('inactive');
      appStateListener('active');
    });
    expect(mockProbe).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('stops restarting a server the OS keeps killing, and falls back to inline', async () => {
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    mockProbe.mockResolvedValue(false);
    for (let i = 0; i < 3; i++) {
      await goBackgroundAndReturn();
      await ready();
    }
    expect(mockRestart).toHaveBeenCalledTimes(3);
    await goBackgroundAndReturn();
    expect(mockRestart).toHaveBeenCalledTimes(3);
    expect(await view.result.current.serverOrigin()).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'loopback server unreachable, restart budget spent: resume',
      }),
      'pdf-rasterizer-server',
    );
    await view.unmount();
  });

  it('leaves inline mode again once the server answers', async () => {
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    // Two failed page loads: the pre-existing fallback to inline.
    mockProbe.mockResolvedValueOnce(true);
    await act(async () => {
      mockProps.onError({ nativeEvent: { url: '', description: 'load error' } });
    });
    await act(async () => {
      mockProps.onError({ nativeEvent: { url: '', description: 'load error' } });
    });
    expect(await view.result.current.serverOrigin()).toBeNull();
    await goBackgroundAndReturn();
    expect(await view.result.current.serverOrigin()).toBe(ORIGIN);
    expect(pageUri()).toMatch(/^http:\/\/127\.0\.0\.1:8080\//);
    await view.unmount();
  });
});

describe('the served page cannot connect (#381, #385)', () => {
  it('restarts the server and reloads the page before giving up on URL rendering', async () => {
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    mockProbe.mockResolvedValueOnce(false);
    restartTo(NEW_ORIGIN);
    await act(async () => {
      mockProps.onError({
        nativeEvent: { url: '', description: 'Could not connect to the server.' },
      });
    });
    expect(mockRestart).toHaveBeenCalledWith(ORIGIN);
    expect(mockMounts).toBe(2);
    expect(pageUri()).toMatch(/^http:\/\/127\.0\.0\.1:9090\//);
    expect(await view.result.current.serverOrigin()).toBe(NEW_ORIGIN);
    expect(reportError).not.toHaveBeenCalledWith(expect.anything(), 'pdf-rasterizer-server');
    await view.unmount();
  });

  it('rejects queued URL work as "not started" when it does fall back', async () => {
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    await act(async () => {
      mockProps.onError({ nativeEvent: { url: '', description: 'load error' } });
    });
    const queued = view.result.current.rasterize(served()).catch((error: unknown) => error);
    await act(async () => {
      mockProps.onError({ nativeEvent: { url: '', description: 'load error' } });
    });
    const error = await queued;
    expect(error).toBeInstanceOf(PdfLoopbackUnavailableError);
    expect((error as Error).message).toBe(
      'PdfRasterizer: loopback server unavailable (load error)',
    );
    await view.unmount();
  });
});

describe('served work after a long idle', () => {
  it('is preceded by a probe, and a success keeps the next one from probing', async () => {
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    const first = view.result.current.rasterize(served());
    expect(mockProbe).not.toHaveBeenCalled();
    await succeed('req-1');
    await first;

    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    let answer!: (alive: boolean) => void;
    mockProbe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const second = view.result.current.rasterize(served());
    await act(async () => {});
    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(renders()).toHaveLength(1);
    await act(async () => answer(true));
    expect(renders()).toHaveLength(2);
    await succeed('req-2');
    await second;

    const third = view.result.current.rasterize(served());
    expect(renders()).toHaveLength(3);
    expect(mockProbe).toHaveBeenCalledTimes(1);
    await succeed('req-3');
    await third;
    await view.unmount();
  });

  it('does not probe for inline work', async () => {
    const view = await renderHook(useBoth, { wrapper });
    await ready();
    await act(async () => {
      jest.advanceTimersByTime(120_000);
    });
    const inline = view.result.current.rasterize({ source: { base64: 'PDF' }, pageIndex: 0 });
    expect(renders()).toHaveLength(1);
    expect(mockProbe).not.toHaveBeenCalled();
    await succeed('req-1');
    await inline;
    await view.unmount();
  });
});

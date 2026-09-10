/**
 * The served path, end to end against a real loopback HTTP server (#331).
 *
 * The rasterizer page's own script (extracted from the HTML the provider
 * writes) runs in a `vm` context whose `fetch` is Node's, pointed at a local
 * `http` server that answers Range requests for a fake PDF the way lighttpd
 * does — 200 with Accept-Ranges for the probe, 206 with Content-Range for each
 * chunk. pdf.js itself is scripted: `getDocument` range-reads the file through
 * the page's `fetch` exactly as PDFFetchStream does (a probe GET aborted once
 * headers show Range support, then one GET per 1 MiB chunk read via
 * `body.getReader()`), so what is under test is the page's served-fetch trace:
 * when a request fails, the error RN receives names the request, its Range and
 * how far the transfer got, instead of WebKit's bare "Load failed".
 */
import { runInNewContext } from 'node:vm';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeServedText } from '@data/localServer';
import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { PdfRasterizerProvider, usePdfRasterizer } from './PdfRasterizer';

const mockInject = jest.fn();
jest.mock(
  '@data/pdfRenderRecovery',
  () => ({ beginPdfRender: () => 'token', finishPdfRender: jest.fn() }),
  {
    virtual: true,
  },
);
jest.mock('@data/nativePdf', () => ({
  nativePdfAvailable: () => false,
  renderNativePdfCrop: jest.fn(),
  deleteNativePdfOutput: jest.fn(),
}));
let mockProps: { onMessage: (event: { nativeEvent: { data: string } }) => void };
jest.mock('react-native-webview', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    WebView: React.forwardRef(function MockWebView(props: typeof mockProps, ref) {
      mockProps = props;
      React.useImperativeHandle(ref, () => ({ injectJavaScript: mockInject }));
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

const CHUNK = 1024 * 1024;
const FILE_BYTES = 3 * CHUNK + 512 * 1024;
const PDF_PATH = '/maps/big.pdf';

/**
 * lighttpd stand-in: static file with Range support. `failAt` makes the
 * server drop the connection mid-body for the range starting at that offset —
 * what a killed network process or a dead server looks like to `fetch`.
 */
async function serve(
  failAt: number | null,
): Promise<{ server: Server; origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url} ${req.headers.range ?? ''}`.trim());
    if (req.url !== PDF_PATH) {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (!range) {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(FILE_BYTES),
        'Accept-Ranges': 'bytes',
      });
      // The probe is aborted by the client after the headers; trickle so the
      // abort is what ends it.
      res.write(Buffer.alloc(16));
      return;
    }
    const begin = Number(range[1]);
    const end = Math.min(Number(range[2]), FILE_BYTES - 1);
    res.writeHead(206, {
      'Content-Type': 'application/pdf',
      'Content-Range': `bytes ${begin}-${end}/${FILE_BYTES}`,
      'Content-Length': String(end - begin + 1),
      'Accept-Ranges': 'bytes',
    });
    if (failAt !== null && begin === failAt) {
      res.write(Buffer.alloc(4096));
      setTimeout(() => res.destroy(), 5);
      return;
    }
    res.end(Buffer.alloc(end - begin + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}`, hits };
}

/** The subset of `Headers` the page and the scripted pdf.js use. */
class PlainHeaders {
  private readonly map = new Map<string, string>();
  append(name: string, value: string): void {
    this.map.set(name.toLowerCase(), value);
  }
  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }
}
type FetchLike = (
  input: string,
  init?: { headers?: PlainHeaders; signal?: AbortSignal; method?: string },
) => Promise<{
  status: number;
  headers: PlainHeaders;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } };
}>;

/**
 * WebKit's `fetch`, as far as pdf.js uses it, on top of `node:http` — the
 * Jest RN environment replaces the global fetch with a polyfill that never
 * reaches a socket. Failures surface the way WebKit reports them: a bare
 * TypeError "Load failed", whether the connection was refused or dropped
 * mid-body. That bareness is exactly what the page's trace compensates for.
 */
const httpFetch: FetchLike = (input, init) =>
  new Promise((resolve, reject) => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    const range = init?.headers?.get('Range');
    if (range) headers.Range = range;
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: init?.method ?? 'GET',
        headers,
      },
      (res) => {
        const responseHeaders = new PlainHeaders();
        for (const [name, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') responseHeaders.append(name, value);
        }
        const chunks: Uint8Array[] = [];
        const waiters: {
          resolve: (r: { done: boolean; value?: Uint8Array }) => void;
          reject: (e: Error) => void;
        }[] = [];
        let ended = false;
        let failed: Error | null = null;
        const pump = () => {
          while (waiters.length) {
            if (chunks.length) waiters.shift()!.resolve({ done: false, value: chunks.shift()! });
            else if (failed) waiters.shift()!.reject(failed);
            else if (ended) waiters.shift()!.resolve({ done: true });
            else break;
          }
        };
        res.on('data', (chunk: Buffer) => {
          chunks.push(new Uint8Array(chunk));
          pump();
        });
        res.on('end', () => {
          ended = true;
          pump();
        });
        res.on('aborted', () => {
          failed = new TypeError('Load failed');
          pump();
        });
        res.on('error', () => {
          failed = new TypeError('Load failed');
          pump();
        });
        resolve({
          status: res.statusCode ?? 0,
          headers: responseHeaders,
          body: {
            getReader: () => ({
              read: () =>
                new Promise((resolveRead, rejectRead) => {
                  waiters.push({ resolve: resolveRead, reject: rejectRead });
                  pump();
                }),
            }),
          },
        });
      },
    );
    req.on('error', () => reject(new TypeError('Load failed')));
    init?.signal?.addEventListener('abort', () => req.destroy());
    req.end();
  });

/**
 * A scripted pdf.js: opens the document the way PDFFetchStream does with
 * `disableStream` + `disableRange: false`, using the PAGE's `fetch` (the one
 * the served-fetch trace wraps), then renders a 1000×800 pt page.
 */
function scriptedPdfjs(window: { fetch: FetchLike }) {
  const page = {
    rotate: 0,
    userUnit: 1,
    view: [0, 0, 1000, 800],
    getViewport: ({ scale }: { scale: number }) => ({ width: 1000 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve() }),
  };
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: (params: { url: string; rangeChunkSize: number }) => {
      const task: {
        onProgress: null | (() => void);
        destroy: () => Promise<void>;
        promise: Promise<unknown>;
      } = { onProgress: null, destroy: async () => undefined, promise: Promise.resolve() };
      task.promise = (async () => {
        const controller = new AbortController();
        const probe = await window.fetch(params.url, { signal: controller.signal });
        const length = Number(probe.headers.get('Content-Length'));
        if (probe.headers.get('Accept-Ranges') !== 'bytes') throw new Error('no ranges');
        controller.abort();
        for (let begin = 0; begin < length; begin += params.rangeChunkSize) {
          const end = Math.min(begin + params.rangeChunkSize, length);
          const headers = new PlainHeaders();
          headers.append('Range', `bytes=${begin}-${end - 1}`);
          const response = await window.fetch(params.url, { headers, method: 'GET' });
          const reader = response.body.getReader();
          for (;;) {
            const { done } = await reader.read();
            task.onProgress?.();
            if (done) break;
          }
        }
        return { numPages: 1, getPage: async () => page, cleanup: () => undefined };
      })();
      return task;
    },
  };
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <PdfRasterizerProvider>{children}</PdfRasterizerProvider>
);

/** Mount the provider, load its page script into a VM whose fetch is Node's. */
async function loadPage(origin: string) {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  const html = jest.mocked(writeServedText).mock.calls.at(-1)?.[1] ?? '';
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
  expect(script).toBeDefined();
  const posted: { id: string; ok: boolean; error?: string }[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: '', fillRect: () => undefined }),
    toDataURL: () => 'data:image/png;base64,PNG',
  };
  // The sandbox IS the window, as in a browser: pdf.js's bare `fetch` and the
  // page's `window.fetch` are the same binding, so the trace wraps both.
  const window: Record<string, unknown> = {
    fetch: httpFetch,
    location: { href: `${origin}/.rasterizer/index.html` },
    URL,
    AbortController,
    document: { getElementById: () => canvas },
    setTimeout,
    clearTimeout,
    ReactNativeWebView: {
      postMessage: (message: string) => {
        posted.push(JSON.parse(message) as (typeof posted)[number]);
        // Relay to RN like the real WebView would.
        mockProps.onMessage({ nativeEvent: { data: message } });
      },
    },
  };
  window.window = window;
  window.pdfjsLib = scriptedPdfjs(window as unknown as { fetch: FetchLike });
  // Evaluating the page announces readiness through postMessage → RN.
  await act(async () => {
    runInNewContext(script!, window);
  });
  // RN dispatches renders through injectJavaScript; run them in the VM.
  mockInject.mockImplementation((code: string) => {
    runInNewContext(code, window);
  });
  return { view, posted, window };
}

let server: Server | undefined;
afterEach(async () => {
  mockInject.mockReset();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

it('range-fetches a served PDF through the page and renders it', async () => {
  const served = await serve(null);
  server = served.server;
  const { view, posted } = await loadPage(served.origin);
  const result = await act(() =>
    view.result.current({ source: { url: `${served.origin}${PDF_PATH}` }, pageIndex: 0 }),
  );
  expect(result).toMatchObject({ pageWidthPt: 1000, pageHeightPt: 800, pageCount: 1 });
  // One probe (200, aborted) then one 206 per 1 MiB chunk of the 3.5 MiB file.
  expect(served.hits).toEqual([
    `GET ${PDF_PATH}`,
    `GET ${PDF_PATH} bytes=0-1048575`,
    `GET ${PDF_PATH} bytes=1048576-2097151`,
    `GET ${PDF_PATH} bytes=2097152-3145727`,
    `GET ${PDF_PATH} bytes=3145728-3670015`,
  ]);
  // A clean render carries no fetch diagnostics.
  expect(posted.at(-1)).toMatchObject({ id: 'req-1', ok: true });
  await view.unmount();
});

it('names the request, its Range and the bytes read when a served fetch dies mid-body', async () => {
  const served = await serve(2 * CHUNK);
  server = served.server;
  const { view, posted } = await loadPage(served.origin);
  const failure = await act(() =>
    view.result
      .current({ source: { url: `${served.origin}${PDF_PATH}` }, pageIndex: 0 })
      .catch((error: Error) => error),
  );
  expect(failure).toBeInstanceOf(Error);
  const message = (failure as Error).message;
  // The bare network error is kept and the trace is appended after it: which
  // request, its Range, the status it got, how much of it arrived.
  expect(message).toMatch(
    /^Load failed \[served fetch: 4 requests, 1 failed; GET \/maps\/big\.pdf bytes=2097152-3145727 -> 206 \(4096 B read\) failed: Load failed\]$/,
  );
  expect(posted.at(-1)).toMatchObject({ id: 'req-1', ok: false, error: message });
  // The chunk before the dead one was fully read; nothing after it was asked for.
  expect(served.hits).toHaveLength(4);
  await view.unmount();
});

it('reports a refused connection as the first request failing with nothing read', async () => {
  const served = await serve(null);
  const { origin } = served;
  await new Promise<void>((resolve) => served.server.close(() => resolve()));
  const { view } = await loadPage(origin);
  const failure = await act(() =>
    view.result
      .current({ source: { url: `${origin}${PDF_PATH}` }, pageIndex: 0 })
      .catch((error: Error) => error),
  );
  expect((failure as Error).message).toBe(
    'Load failed [served fetch: 1 requests, 1 failed; GET /maps/big.pdf (0 B read) failed: Load failed]',
  );
  await view.unmount();
});

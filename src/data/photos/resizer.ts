import {
  parseResizeReply,
  resizeJobScript,
  type ResizeOutput,
  type ResizeReply,
} from '@core/photos/resize';
import { servedFileUrl } from '@core/storage/servedPaths';

/**
 * The photo resizer (#587): turns one picked photo into the three copies.
 *
 * {@link PhotoResizer} is the seam the import pipeline uses; v1 implements it
 * with a hidden WebView running `resizeWorkerHtml()` (OTA-able: everything is
 * already in the binary). The next store build can swap in
 * `expo-image-manipulator` behind the same interface.
 *
 * {@link createWebViewResizer} is the WebView-agnostic controller: the host
 * component (stage 2) mounts the WebView, forwards `onMessage` to
 * `handleMessage`, and gives it `inject` (`webView.injectJavaScript`). Jobs run
 * ONE AT A TIME — a 12 MP decode is ~48 MB of canvas memory, and two at once on
 * a mid-range Android is how the PDF rasterizer learned about OOM kills.
 */

export interface ResizedPhoto {
  display: ResizeOutput;
  thumb: ResizeOutput;
  sprite: ResizeOutput;
  sourceWidth: number;
  sourceHeight: number;
  /** Time inside the page, and end to end including staging and the bridge (ms). */
  decodeMs: number;
  encodeMs: number;
  totalMs: number;
}

export interface PhotoResizer {
  resize(sourceUri: string): Promise<ResizedPhoto>;
}

export class ResizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResizeError';
  }
}

export interface WebViewResizerDeps {
  /** Copy the source into the served inbox; resolves to its document path. */
  stage(sourceUri: string, jobId: string): Promise<string>;
  /** Delete a staged file. */
  unstage(documentPath: string): void;
  /** The loopback server's origin (holding a lease is the host's job). */
  origin(): Promise<string>;
  /** Run JavaScript in the worker page. */
  inject(script: string): void;
  newId(): string;
  now?: () => number;
  /** Per job, including the page load on the first one (ms). */
  timeoutMs?: number;
}

export interface WebViewResizer extends PhotoResizer {
  /** Forward the WebView's `onMessage` `nativeEvent.data` here. */
  handleMessage(data: string): void;
  /** The page reloaded (or the WebView remounted): wait for `ready` again. */
  reset(): void;
  /** Fail pending and queued jobs (the host unmounted). */
  dispose(): void;
}

export const DEFAULT_RESIZE_TIMEOUT_MS = 45_000;

export function createWebViewResizer(deps: WebViewResizerDeps): WebViewResizer {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_RESIZE_TIMEOUT_MS;
  let ready = false;
  let readyWaiters: (() => void)[] = [];
  let disposed = false;
  const pending = new Map<string, (reply: ResizeReply) => void>();
  let chain: Promise<unknown> = Promise.resolve();

  const whenReady = () =>
    ready ? Promise.resolve() : new Promise<void>((resolve) => readyWaiters.push(resolve));

  function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ResizeError(`${label} timed out`)), timeoutMs);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  async function runJob(sourceUri: string): Promise<ResizedPhoto> {
    if (disposed) throw new ResizeError('resizer was closed');
    const started = now();
    const jobId = deps.newId();
    const staged = await deps.stage(sourceUri, jobId);
    try {
      const src = servedFileUrl(await deps.origin(), staged);
      if (!src) throw new ResizeError(`cannot serve ${staged}`);
      const reply = await withTimeout(
        whenReady().then(
          () =>
            new Promise<ResizeReply>((resolve) => {
              pending.set(jobId, resolve);
              deps.inject(resizeJobScript({ id: jobId, src }));
            }),
        ),
        'photo resize',
      );
      if (reply.type === 'failed') throw new ResizeError(reply.message);
      if (reply.type !== 'resized') throw new ResizeError('unexpected reply');
      return {
        display: reply.display,
        thumb: reply.thumb,
        sprite: reply.sprite,
        sourceWidth: reply.sourceWidth,
        sourceHeight: reply.sourceHeight,
        decodeMs: reply.decodeMs,
        encodeMs: reply.encodeMs,
        totalMs: now() - started,
      };
    } finally {
      pending.delete(jobId);
      deps.unstage(staged);
    }
  }

  return {
    resize(sourceUri) {
      const job = chain.catch(() => undefined).then(() => runJob(sourceUri));
      chain = job;
      return job;
    },
    handleMessage(data) {
      const reply = parseResizeReply(data);
      if (!reply) return;
      if (reply.type === 'ready') {
        ready = true;
        const waiters = readyWaiters;
        readyWaiters = [];
        for (const w of waiters) w();
        return;
      }
      pending.get(reply.id)?.(reply);
    },
    reset() {
      ready = false;
    },
    dispose() {
      disposed = true;
      for (const [id, resolve] of pending) {
        resolve({ type: 'failed', id, message: 'resizer was closed' });
      }
      pending.clear();
    },
  };
}

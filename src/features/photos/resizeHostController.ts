import { fnv1a32 } from '@core/encoding/fnv1a';
import { inboxPath, PHOTO_INBOX } from '@core/photos/paths';
import { resizeWorkerHtml } from '@core/photos/resize';
import { servedFileUrl } from '@core/storage/servedPaths';
import { extensionOf, stageForResize, unstage } from '@data/photos/inbox';
import { createWebViewResizer, type WebViewResizer } from '@data/photos/resizer';
import {
  acquireLocalServer,
  probeLocalServer,
  restartLocalServer,
  writeServedText,
  type LocalServerLease,
} from '@data/localServer';
import { reportError } from '@lib/errorReporting';
import { uuid } from 'expo-modules-core';

/**
 * Everything behind `PhotoResizeHost` (#587) except the WebView element: the
 * served worker page, the loopback lease, and the resizer controller wired to
 * whatever WebView is attached. Plain closures (no React refs), so the
 * component only renders and the wiring is unit-tested.
 *
 * Security (October 2026 audit):
 * - staged files are named by a CSPRNG v4 uuid (`expo-modules-core`'s native
 *   `uuid.v4`), never by a counter or the picked file's name;
 * - a staged file is deleted whatever happens: by the resizer's `finally`
 *   once it owns it, and here when the copy itself fails half-way;
 * - served URLs only ever come from `servedFileUrl` over the lease's value
 *   (which carries the per-session secret once #609 lands), never by hand.
 */

export const RESIZER_PAGE_PATH = `${PHOTO_INBOX}/worker.html`;

/** The bits of a WebView the controller drives. */
export interface ResizerWebView {
  injectJavaScript(script: string): void;
  reload(): void;
}

export interface ResizeHostController {
  resizer: WebViewResizer;
  /** Acquire the server and serve the page; `onPageUrl` fires with its URL. */
  start(): Promise<void>;
  /** Release everything; pending jobs fail. */
  stop(): void;
  /** The mounted WebView (or null while none is). */
  attach(view: ResizerWebView | null): void;
  /** The page's process died: wait for a fresh page. */
  processGone(): void;
}

export function createResizeHostController(onPageUrl: (url: string) => void): ResizeHostController {
  const html = resizeWorkerHtml();
  const version = fnv1a32(html);
  let view: ResizerWebView | null = null;
  let lease: Promise<LocalServerLease> | null = null;
  let stopped = false;
  // The served base the page was loaded from. A server restarted on another
  // port is another origin: the page must be reloaded from it, or every image
  // it fetches would be cross-origin (and the canvas tainted).
  let pageBase: string | null = null;

  const servePage = (base: string) => {
    writeServedText(RESIZER_PAGE_PATH, html);
    const url = servedFileUrl(base, RESIZER_PAGE_PATH);
    if (url === null) throw new Error(`${RESIZER_PAGE_PATH} is not on the served allowlist`);
    pageBase = base;
    onPageUrl(`${url}?v=${version}`);
  };

  const resizer = createWebViewResizer({
    stage: async (sourceUri, jobId) => {
      try {
        return await stageForResize(sourceUri, jobId);
      } catch (err) {
        // A copy that failed half-way: the resizer never owned it.
        unstage(inboxPath(jobId, extensionOf(sourceUri)));
        throw err;
      }
    },
    unstage,
    origin: async () => {
      const held = await (lease ?? Promise.reject(new Error('no loopback server')));
      let base = held.value;
      if (!(await probeLocalServer(base))) base = await restartLocalServer(base);
      if (base !== pageBase) {
        // Hold jobs until the page reloaded from the live origin says ready.
        resizer.reset();
        servePage(base);
      }
      return base;
    },
    inject: (script) => view?.injectJavaScript(script),
    // A timed-out job may still be decoding: reload the page to kill it.
    reload: () => view?.reload(),
    newId: () => uuid.v4(),
  });

  return {
    resizer,
    start() {
      const acquiring = acquireLocalServer().then(async (held) => {
        if (stopped) {
          await held.release();
          throw new Error('photo resizer stopped');
        }
        servePage(held.value);
        return held;
      });
      lease = acquiring;
      return acquiring.then(
        () => undefined,
        (err: unknown) => {
          if (!stopped) reportError(err, 'photo-resizer-server');
        },
      );
    },
    stop() {
      stopped = true;
      resizer.dispose();
      const held = lease;
      lease = null;
      held?.then((l) => l.release()).catch(() => undefined);
    },
    attach(next) {
      view = next;
    },
    processGone() {
      resizer.reset();
    },
  };
}

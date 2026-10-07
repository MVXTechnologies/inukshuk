import { ResizeError, type PhotoResizer, type ResizedPhoto } from '@data/photos/resizer';

/**
 * The app's one photo resizer (#587), reachable from anywhere (the Add-photos
 * sheet, the recording's Photo button, a "Trail + photos" zip import) while
 * `PhotoResizeHost`, mounted once at the root, owns the hidden WebView behind
 * it. A job asked for before the host is up waits for it, up to a limit.
 */

let current: PhotoResizer | null = null;
let waiters: ((r: PhotoResizer) => void)[] = [];

/** The host registers its resizer on mount, and `null` on unmount. */
export function registerPhotoResizer(resizer: PhotoResizer | null): void {
  current = resizer;
  if (!resizer) return;
  const pending = waiters;
  waiters = [];
  for (const w of pending) w(resizer);
}

/** How long a job waits for the host to come up (ms). */
export const HOST_WAIT_MS = 20_000;

function whenAvailable(timeoutMs: number): Promise<PhotoResizer> {
  if (current) return Promise.resolve(current);
  return new Promise<PhotoResizer>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== done);
      reject(new ResizeError('the photo resizer is not available'));
    }, timeoutMs);
    const done = (r: PhotoResizer) => {
      clearTimeout(timer);
      resolve(r);
    };
    waiters.push(done);
  });
}

/** The resizer to hand to `commitPhotoImport` and friends. */
export const photoResizer: PhotoResizer = {
  async resize(sourceUri: string): Promise<ResizedPhoto> {
    const r = await whenAvailable(HOST_WAIT_MS);
    return r.resize(sourceUri);
  },
};

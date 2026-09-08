/**
 * A ref-counted async resource: `start` runs for the first lease, `stop` runs
 * once the last lease is released, and every start/stop is serialized so two
 * callers racing an acquire against a release can never leave the resource
 * half-started or stopped underneath a live lease.
 *
 * Written for the in-app loopback file server (#269): the native library
 * allows ONE server per app, and two subsystems need it — the PDF rasterizer
 * (for the app's lifetime) and the offline-map downloader (per download). A
 * download must never stop the server the rasterizer is still streaming from;
 * this pool is the one place that rule is enforced.
 *
 * `start` is invoked on EVERY acquire and must be idempotent — return the same
 * live value while running. That is what lets a resource that crashed between
 * two leases restart on the next acquire instead of handing out a dead value.
 */
export interface RefCountedLease<T> {
  readonly value: T;
  /** Release this lease. Idempotent; resolves once any resulting stop is done. */
  release(): Promise<void>;
}

export interface RefCounted<T> {
  acquire(): Promise<RefCountedLease<T>>;
  /** Outstanding leases (including acquires still starting). */
  readonly leases: number;
}

export function refCounted<T>(start: () => Promise<T>, stop: () => Promise<void>): RefCounted<T> {
  let leases = 0;
  // Every start/stop runs through this chain, in call order.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    get leases() {
      return leases;
    },
    acquire() {
      leases += 1;
      return enqueue(async () => {
        let value: T;
        try {
          value = await start();
        } catch (err) {
          leases -= 1;
          throw err;
        }
        let released = false;
        return {
          value,
          release: () => {
            if (released) return Promise.resolve();
            released = true;
            leases -= 1;
            return enqueue(async () => {
              // Someone may have acquired again while this stop was queued;
              // re-check under the serialized queue, not at call time.
              if (leases === 0) await stop();
            });
          },
        };
      });
    },
  };
}

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
 *
 * A resource can also die UNDER live leases — the loopback server's socket is
 * reclaimed while iOS suspends the app, and nothing releases. `restart`
 * replaces it in place, in the same serialized queue, and every lease's
 * `value` reads the replacement from then on.
 */
export interface RefCountedLease<T> {
  /** The resource's current value (it changes only through `restart`). */
  readonly value: T;
  /** Release this lease. Idempotent; resolves once any resulting stop is done. */
  release(): Promise<void>;
}

export interface RefCounted<T> {
  acquire(): Promise<RefCountedLease<T>>;
  /**
   * Replace the resource while leases are held, if its value is still
   * `stale` — a concurrent restart already replaced it, and this resolves to
   * that replacement instead of restarting twice. Rejects when no lease is
   * held (there is nothing live to replace) or the replacement fails.
   */
  restart(stale: T): Promise<T>;
  /** Outstanding leases (including acquires still starting). */
  readonly leases: number;
}

export function refCounted<T>(
  start: () => Promise<T>,
  stop: () => Promise<void>,
  replace: () => Promise<T> = async () => {
    await stop();
    return start();
  },
): RefCounted<T> {
  let leases = 0;
  // The one holder of the latest value: every lease reads it, so a restart
  // reaches them all.
  let current: { value: T } | null = null;
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
        const holder = current ?? { value };
        holder.value = value;
        current = holder;
        let released = false;
        return {
          get value() {
            return holder.value;
          },
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
    restart(stale) {
      return enqueue(async () => {
        const holder = current;
        if (leases === 0 || holder === null) {
          throw new Error('Nothing to restart: no lease is held');
        }
        if (holder.value !== stale) return holder.value;
        holder.value = await replace();
        return holder.value;
      });
    },
  };
}

/**
 * Deduplicate concurrent async work by key: while a call for `key` is in
 * flight, later callers receive the SAME promise instead of starting the work
 * again. Once settled (either way), the key is released so a later call runs
 * fresh.
 *
 * Written for the tile-download path (#126): the 3D terrain builder fires many
 * concurrent downloads, and two in-flight downloads of the same tile raced on
 * the same cache file — iOS's expo-file-system throws
 * `DestinationAlreadyExistsException` when the loser lands. With single-flight
 * the duplicate caller just awaits the first download.
 */
export function singleFlight<T>(
  inflight: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const job = run().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, job);
  return job;
}

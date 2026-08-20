/**
 * A ~40-line IndexedDB key-value store.
 *
 * localStorage was the obvious first choice and is the wrong one: a single
 * realistic Québec run is tens of thousands of points, and a handful of them
 * blows past the ~5 MB string quota — silently, with a QuotaExceededError on
 * write. IndexedDB has no such ceiling and stores structured objects, so the
 * track points survive a round-trip without a JSON re-parse.
 *
 * No wrapper library: the surface used here is four calls wide.
 */

const DB_NAME = 'inukshuk-playground';

/**
 * EVERY store this app uses, declared up front, and the version bumped
 * whenever the list grows.
 *
 * The first cut created stores lazily inside `onupgradeneeded` — which only
 * runs when the version changes. Adding the Library's two stores at the same
 * version therefore did nothing on any browser that had already opened v1: the
 * open succeeded, the transaction then threw `NotFoundError`, and the Library
 * came up permanently empty with no clue why. One version, one manifest.
 */
const DB_VERSION = 2;
const STORES = ['tracks', 'library', 'gpx'] as const;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) {
        if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  body: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = body(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
        tx.oncomplete = () => db.close();
      }),
  );
}

export const idb = {
  get: <T>(store: string, key: string): Promise<T | undefined> =>
    run<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
  getAll: <T>(store: string): Promise<T[]> =>
    run<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>),
  put: (store: string, key: string, value: unknown): Promise<IDBValidKey> =>
    run(store, 'readwrite', (s) => s.put(value, key)),
  remove: (store: string, key: string): Promise<undefined> =>
    run(store, 'readwrite', (s) => s.delete(key)),
  clear: (store: string): Promise<undefined> => run(store, 'readwrite', (s) => s.clear()),
};

/** Legacy weather-map GPX drop store (full points per track). */
export const TRACK_STORE = 'tracks';
/** The Library index — one JSON blob, mirroring the app's `library.json`. */
export const LIBRARY_STORE = 'library';
/** GPX text per trail id, mirroring the app's `tracks/<id>.gpx` files. */
export const GPX_STORE = 'gpx';

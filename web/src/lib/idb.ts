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
const DB_VERSION = 1;

function openDb(store: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
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
  return openDb(store).then(
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
  getAll: <T>(store: string): Promise<T[]> =>
    run<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>),
  put: (store: string, key: string, value: unknown): Promise<IDBValidKey> =>
    run(store, 'readwrite', (s) => s.put(value, key)),
  remove: (store: string, key: string): Promise<undefined> =>
    run(store, 'readwrite', (s) => s.delete(key)),
  clear: (store: string): Promise<undefined> => run(store, 'readwrite', (s) => s.clear()),
};

export const TRACK_STORE = 'tracks';

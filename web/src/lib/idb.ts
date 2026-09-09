/**
 * A small IndexedDB key-value store.
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
  store: string | string[],
  mode: IDBTransactionMode,
  body: (s: IDBObjectStore, tx: IDBTransaction) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction | undefined;
        let settled = false;
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          db.close();
          reject(error);
        };
        try {
          tx = db.transaction(store, mode);
          tx.onerror = () => fail(tx?.error ?? new Error('indexedDB transaction failed'));
          tx.onabort = () => fail(tx?.error ?? new Error('indexedDB transaction aborted'));
          const req = body(tx.objectStore(typeof store === 'string' ? store : store[0]!), tx);
          req.onerror = () => fail(req.error ?? new Error('indexedDB request failed'));
          // Request success is provisional: quota/storage failure can still
          // abort the transaction. Only completion confirms the write committed.
          tx.oncomplete = () => {
            if (settled) return;
            settled = true;
            db.close();
            resolve(req.result);
          };
        } catch (error) {
          // Missing stores and uncloneable values throw before request events.
          // Abort any transaction already opened, and always close its database.
          try {
            tx?.abort();
          } catch {
            // An already-finished transaction cannot be aborted.
          }
          fail(error);
        }
      }),
  );
}

export const idb = {
  /** Publish GPX changes and their index together, including replacement/deletion. */
  commitLibrary: (
    index: unknown,
    files: ReadonlyMap<string, string | null>,
    replace: boolean,
  ): Promise<void> =>
    run(['library', 'gpx'], 'readwrite', (library, tx) => {
      const gpx = tx.objectStore('gpx');
      if (replace) gpx.clear();
      for (const [id, xml] of files) {
        if (xml === null) gpx.delete(id);
        else gpx.put(xml, id);
      }
      return library.put(index, 'index');
    }).then(() => undefined),
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

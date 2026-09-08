import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { idb } from './idb';

const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
afterEach(() => {
  if (originalIndexedDb) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
  else Reflect.deleteProperty(globalThis, 'indexedDB');
});

/** Drive the browser event boundary without a second IndexedDB implementation. */
function browserTransaction(setupFailure?: 'transaction' | 'store' | 'body') {
  const setupError = new Error(`setup failed: ${setupFailure}`);
  const request: Pick<IDBRequest<string>, 'onsuccess' | 'onerror' | 'result' | 'error'> = {
    onsuccess: null,
    onerror: null,
    result: 'saved-key',
    error: null,
  };
  const writes: unknown[][] = [];
  const transaction: Pick<
    IDBTransaction,
    'oncomplete' | 'onerror' | 'onabort' | 'error' | 'abort' | 'objectStore'
  > = {
    oncomplete: null,
    onerror: null,
    onabort: null,
    error: null,
    abort: jest.fn(),
    objectStore: (store: string) => {
      if (setupFailure === 'store') throw setupError;
      return {
        put: (value: unknown, key: string) => {
          writes.push([store, key, value]);
          if (setupFailure === 'body') throw setupError;
          return request;
        },
      } as unknown as IDBObjectStore;
    },
  };
  const database = {
    close: jest.fn(),
    transaction: jest.fn(() => {
      if (setupFailure === 'transaction') throw setupError;
      return transaction;
    }),
  };
  const openRequest: Pick<
    IDBOpenDBRequest,
    'onupgradeneeded' | 'onsuccess' | 'onerror' | 'result' | 'error'
  > = {
    onupgradeneeded: null,
    onsuccess: null,
    onerror: null,
    result: database as unknown as IDBDatabase,
    error: null,
  };
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: { open: () => openRequest },
  });
  return {
    database,
    writes,
    transaction,
    request,
    setupError,
    async open() {
      openRequest.onsuccess?.call(openRequest as IDBOpenDBRequest, new Event('success'));
      await Promise.resolve();
    },
    requestSucceeded() {
      request.onsuccess?.call(request as IDBRequest<string>, new Event('success'));
    },
    transactionEvent(type: 'complete' | 'error' | 'abort', error: DOMException | null = null) {
      Object.defineProperty(transaction, 'error', { value: error, configurable: true });
      transaction[`on${type}`]?.call(transaction as IDBTransaction, new Event(type));
    },
  };
}

describe('IndexedDB transaction durability', () => {
  it('commits library metadata and GPX edits in the same transaction', async () => {
    const browser = browserTransaction();
    const pending = idb.commitLibrary({ tracks: ['new'] }, new Map([['new', '<gpx/>']]), false);
    await browser.open();
    browser.requestSucceeded();
    const outcome = pending.catch((error: unknown) => error);
    browser.transactionEvent('abort', new DOMException('quota', 'QuotaExceededError'));
    expect(await outcome).toBeInstanceOf(Error);
    expect(browser.database.transaction).toHaveBeenCalledWith(['library', 'gpx'], 'readwrite');
    expect(browser.writes).toEqual([
      ['gpx', 'new', '<gpx/>'],
      ['library', 'index', { tracks: ['new'] }],
    ]);
  });
  it('waits for commit after the write request succeeds, then returns its key and closes', async () => {
    const browser = browserTransaction();
    const settled = jest.fn();
    const pending = idb.put('library', 'key', { name: 'Hike' });
    void pending.then(settled);
    await browser.open();
    browser.requestSucceeded();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).not.toHaveBeenCalled();
    expect(browser.database.close).not.toHaveBeenCalled();
    browser.transactionEvent('complete');
    await expect(pending).resolves.toBe('saved-key');
    expect(browser.database.close).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'abort'] as const)(
    'rejects a late transaction %s after request success and closes once',
    async (event) => {
      const browser = browserTransaction();
      const pending = idb.put('library', 'key', 'value');
      const outcome = pending.catch((error: unknown) => error);
      await browser.open();
      browser.requestSucceeded();
      const error = new DOMException('Could not commit', 'QuotaExceededError');
      browser.transactionEvent(event, error);
      browser.transactionEvent('abort', error);
      expect(await outcome).toBe(error);
      expect(browser.database.close).toHaveBeenCalledTimes(1);
    },
  );

  it('reports an explicit abort even without a browser error object', async () => {
    const browser = browserTransaction();
    const pending = idb.put('library', 'key', 'value');
    const outcomes: unknown[] = [];
    void pending.then(
      (value) => outcomes.push(value),
      (error: unknown) => outcomes.push(error),
    );
    await browser.open();
    browser.transactionEvent('abort');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcomes[0]).toBeInstanceOf(Error);
    expect(browser.database.close).toHaveBeenCalledTimes(1);
  });

  it.each(['transaction', 'store', 'body'] as const)(
    'closes when synchronous %s setup throws',
    async (stage) => {
      const browser = browserTransaction(stage);
      const pending = idb.put('library', 'key', 'value');
      const outcome = pending.catch((error: unknown) => error);
      await browser.open();
      expect(await outcome).toBe(browser.setupError);
      expect(browser.database.close).toHaveBeenCalledTimes(1);
      if (stage !== 'transaction') expect(browser.transaction.abort).toHaveBeenCalledTimes(1);
    },
  );
});

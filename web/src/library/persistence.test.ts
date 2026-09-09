import { describe, expect, it } from '@jest/globals';
import { LibraryPersistence, type LibraryWrite } from './persistence';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('recoverable library writes', () => {
  it('retains failed import XML and retries the same coherent index and files', async () => {
    const writes: LibraryWrite<number>[] = [];
    let fail = true;
    const persistence = new LibraryPersistence<number>(async (write) => {
      if (fail) throw new Error('quota');
      writes.push(write);
    });
    persistence.stage(1, new Map([['import', '<gpx/>']]));
    expect(await persistence.save()).toBe(false);
    expect(persistence.status.state).toBe('error');
    expect(persistence.read('import')).toBe('<gpx/>');
    fail = false;
    expect(await persistence.save()).toBe(true);
    expect(writes[0]?.index).toBe(1);
    expect(writes[0]?.files.get('import')).toBe('<gpx/>');
    expect(persistence.status.state).toBe('saved');
  });

  it('commits edits arriving during a save and does not acknowledge them early', async () => {
    const first = deferred();
    const second = deferred();
    const writes: LibraryWrite<number>[] = [];
    const persistence = new LibraryPersistence<number>((write) => {
      writes.push(write);
      return writes.length === 1 ? first.promise : second.promise;
    });
    persistence.stage(1, new Map([['track', 'original']]));
    const saving = persistence.save();
    persistence.stage(2, new Map([['track', 'trimmed']]));
    first.resolve();
    await Promise.resolve();
    expect(persistence.status.state).toBe('saving');
    expect(writes[1]?.index).toBe(2);
    expect(writes[1]?.files.get('track')).toBe('trimmed');
    second.resolve();
    expect(await saving).toBe(true);
    expect(persistence.status.state).toBe('saved');
  });

  it('retains a failed replacement plus later deletion for a complete retry', async () => {
    const first = deferred();
    const writes: LibraryWrite<number>[] = [];
    const persistence = new LibraryPersistence<number>((write) => {
      writes.push(write);
      return writes.length === 1 ? first.promise : Promise.resolve();
    });
    persistence.stage(1, new Map([['demo', 'demo xml']]), true);
    const saving = persistence.save();
    persistence.stage(
      2,
      new Map([
        ['demo', null],
        ['new', 'new xml'],
      ]),
    );
    first.reject(new Error('offline'));
    expect(await saving).toBe(false);
    expect(await persistence.save()).toBe(true);
    expect(writes[1]?.replace).toBe(true);
    expect(writes[1]?.files.get('demo')).toBe(null);
    expect(writes[1]?.files.get('new')).toBe('new xml');
    expect(writes[1]?.index).toBe(2);
  });
});

it.each([false, true])(
  'drains edits arriving between flush and finalization, including failure=%s',
  async (failLatest) => {
    const first = deferred();
    const writes: number[] = [];
    const persistence = new LibraryPersistence<number>(async (write) => {
      writes.push(write.index);
      if (writes.length === 1) await first.promise;
      else if (failLatest) throw new Error('quota');
    });
    persistence.stage(1);
    const saving = persistence.save();
    first.resolve();
    // The async commit resolves first, then flush observes its completion.
    await Promise.resolve();
    await Promise.resolve();
    persistence.stage(2, new Map([['latest', 'new XML']]));
    const latest = persistence.save();
    expect(await latest).toBe(!failLatest);
    expect(await saving).toBe(!failLatest);
    expect(writes).toEqual([1, 2]);
    expect(persistence.status.state).toBe(failLatest ? 'error' : 'saved');
    expect(persistence.read('latest')).toBe('new XML');
    if (failLatest) {
      failLatest = false;
      expect(await persistence.save()).toBe(true);
      expect(writes).toEqual([1, 2, 2]);
    }
  },
);

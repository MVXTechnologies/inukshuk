import { latestWins } from './latestWins';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('latestWins', () => {
  it('runs one job at a time and only the newest waiting request next', async () => {
    const started: number[] = [];
    const gates = new Map<number, ReturnType<typeof deferred<string>>>();
    const run = latestWins((n: number) => {
      started.push(n);
      const d = deferred<string>();
      gates.set(n, d);
      return d.promise;
    });
    const p1 = run(1);
    const p2 = run(2);
    const p3 = run(3);
    const p4 = run(4);
    expect(started).toEqual([1]); // the rest wait
    await expect(p2).resolves.toBeNull(); // superseded before starting
    await expect(p3).resolves.toBeNull();
    gates.get(1)!.resolve('one');
    await expect(p1).resolves.toBe('one'); // a started job still finishes
    await Promise.resolve();
    expect(started).toEqual([1, 4]);
    gates.get(4)!.resolve('four');
    await expect(p4).resolves.toBe('four');
  });

  it('propagates a failure and keeps serving later requests', async () => {
    let fail = true;
    const run = latestWins(async (n: number) => {
      if (fail) throw new Error(`boom ${n}`);
      return n * 2;
    });
    await expect(run(1)).rejects.toThrow('boom 1');
    fail = false;
    await expect(run(5)).resolves.toBe(10);
  });
});

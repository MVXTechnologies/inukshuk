import { singleFlight } from './singleFlight';

describe('singleFlight', () => {
  it('returns the same promise for concurrent calls with the same key', async () => {
    const inflight = new Map<string, Promise<number>>();
    let runs = 0;
    let release!: (n: number) => void;
    const run = () => {
      runs += 1;
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    };

    const a = singleFlight(inflight, 'tile-1', run);
    const b = singleFlight(inflight, 'tile-1', run);
    expect(a).toBe(b);
    expect(runs).toBe(1);

    release(42);
    await expect(a).resolves.toBe(42);
    await expect(b).resolves.toBe(42);
  });

  it('runs different keys independently and concurrently', async () => {
    const inflight = new Map<string, Promise<string>>();
    const a = singleFlight(inflight, 'a', () => Promise.resolve('A'));
    const b = singleFlight(inflight, 'b', () => Promise.resolve('B'));
    expect(a).not.toBe(b);
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
  });

  it('releases the key after success so a later call runs fresh', async () => {
    const inflight = new Map<string, Promise<number>>();
    let runs = 0;
    const run = () => {
      runs += 1;
      return Promise.resolve(runs);
    };
    await singleFlight(inflight, 'k', run);
    expect(inflight.size).toBe(0);
    await expect(singleFlight(inflight, 'k', run)).resolves.toBe(2);
    expect(runs).toBe(2);
  });

  it('releases the key after failure and propagates the rejection to all waiters', async () => {
    const inflight = new Map<string, Promise<number>>();
    let release!: (err: Error) => void;
    const failing = () =>
      new Promise<number>((_resolve, reject) => {
        release = reject;
      });

    const a = singleFlight(inflight, 'k', failing);
    const b = singleFlight(inflight, 'k', failing);
    release(new Error('boom'));
    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
    expect(inflight.size).toBe(0);

    // Next call after the failure starts fresh work.
    await expect(singleFlight(inflight, 'k', () => Promise.resolve(7))).resolves.toBe(7);
  });

  it('does not cache a synchronous throw from run()', () => {
    const inflight = new Map<string, Promise<number>>();
    expect(() =>
      singleFlight(inflight, 'k', () => {
        throw new Error('sync');
      }),
    ).toThrow('sync');
    expect(inflight.size).toBe(0);
  });
});

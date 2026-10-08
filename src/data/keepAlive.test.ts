import { keepAlive, keptAliveCount } from './keepAlive';

describe('keepAlive', () => {
  it('holds the object until the call resolves, then lets it go', async () => {
    let resolve: (v: string) => void = () => undefined;
    const work = new Promise<string>((r) => {
      resolve = r;
    });
    const read = keepAlive({}, work);
    expect(keptAliveCount()).toBe(1);
    resolve('text');
    await expect(read).resolves.toBe('text');
    expect(keptAliveCount()).toBe(0);
  });

  it('lets it go after a rejection too, and passes the error on', async () => {
    await expect(keepAlive({}, Promise.reject(new Error('gone')))).rejects.toThrow('gone');
    expect(keptAliveCount()).toBe(0);
  });

  it('pins the same object once per call in flight', async () => {
    const file = {};
    const a = keepAlive(file, Promise.resolve(1));
    const b = keepAlive(file, Promise.resolve(2));
    expect(keptAliveCount()).toBe(2);
    await Promise.all([a, b]);
    expect(keptAliveCount()).toBe(0);
  });
});

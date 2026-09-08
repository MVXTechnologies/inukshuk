import { refCounted } from './refCounted';

function makePool() {
  const log: string[] = [];
  let running = false;
  const pool = refCounted<string>(
    async () => {
      log.push(running ? 'start(idempotent)' : 'start');
      running = true;
      return 'http://127.0.0.1:1';
    },
    async () => {
      log.push('stop');
      running = false;
    },
  );
  return { pool, log };
}

describe('refCounted', () => {
  it('starts on acquire and stops only when the last lease is released', async () => {
    const { pool, log } = makePool();
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(a.value).toBe('http://127.0.0.1:1');
    expect(pool.leases).toBe(2);

    await a.release();
    expect(log).not.toContain('stop');
    await b.release();
    expect(log).toEqual(['start', 'start(idempotent)', 'stop']);
    expect(pool.leases).toBe(0);
  });

  it('releasing twice is a no-op', async () => {
    const { pool, log } = makePool();
    const a = await pool.acquire();
    const b = await pool.acquire();
    await a.release();
    await a.release();
    expect(pool.leases).toBe(1);
    expect(log.filter((l) => l === 'stop')).toHaveLength(0);
    await b.release();
    expect(log.filter((l) => l === 'stop')).toHaveLength(1);
  });

  it('does not stop when a new acquire lands before a queued stop runs', async () => {
    const { pool, log } = makePool();
    const a = await pool.acquire();
    // Release and immediately re-acquire without awaiting the release: the
    // stop is queued, but by the time it runs the count is back to one.
    const releasing = a.release();
    const b = await pool.acquire();
    await releasing;
    expect(log).not.toContain('stop');
    await b.release();
    expect(log).toContain('stop');
  });

  it('a failed start drops its lease and surfaces the error', async () => {
    const pool = refCounted<string>(
      async () => {
        throw new Error('port in use');
      },
      async () => undefined,
    );
    await expect(pool.acquire()).rejects.toThrow('port in use');
    expect(pool.leases).toBe(0);
  });

  it('restarts on the next acquire after a full stop', async () => {
    const { pool, log } = makePool();
    const a = await pool.acquire();
    await a.release();
    const b = await pool.acquire();
    await b.release();
    expect(log).toEqual(['start', 'stop', 'start', 'stop']);
  });
});

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

  describe('restart (a resource that died under live leases)', () => {
    function makeRestartable() {
      const log: string[] = [];
      let port = 1;
      const pool = refCounted<string>(
        async () => {
          log.push('start');
          return `http://127.0.0.1:${port}`;
        },
        async () => {
          log.push('stop');
        },
        async () => {
          log.push('replace');
          port += 1;
          return `http://127.0.0.1:${port}`;
        },
      );
      return { pool, log };
    }

    it('replaces the value every live lease reads', async () => {
      const { pool, log } = makeRestartable();
      const a = await pool.acquire();
      const b = await pool.acquire();
      await expect(pool.restart('http://127.0.0.1:1')).resolves.toBe('http://127.0.0.1:2');
      expect(a.value).toBe('http://127.0.0.1:2');
      expect(b.value).toBe('http://127.0.0.1:2');
      expect(log).toEqual(['start', 'start', 'replace']);
      await a.release();
      await b.release();
    });

    it('restarts once when two callers notice the same death', async () => {
      const { pool, log } = makeRestartable();
      const lease = await pool.acquire();
      const [x, y] = await Promise.all([
        pool.restart('http://127.0.0.1:1'),
        pool.restart('http://127.0.0.1:1'),
      ]);
      expect(x).toBe('http://127.0.0.1:2');
      expect(y).toBe('http://127.0.0.1:2');
      expect(log.filter((l) => l === 'replace')).toHaveLength(1);
      await lease.release();
    });

    it('refuses when nothing is leased', async () => {
      const { pool, log } = makeRestartable();
      await expect(pool.restart('http://127.0.0.1:1')).rejects.toThrow(/no lease is held/);
      expect(log).toEqual([]);
    });

    it('keeps the old value when the replacement fails, and a later restart can succeed', async () => {
      let fail = true;
      const pool = refCounted<string>(
        async () => 'old',
        async () => undefined,
        async () => {
          if (fail) throw new Error('bind failed');
          return 'new';
        },
      );
      const lease = await pool.acquire();
      await expect(pool.restart('old')).rejects.toThrow('bind failed');
      expect(lease.value).toBe('old');
      fail = false;
      await expect(pool.restart('old')).resolves.toBe('new');
      expect(lease.value).toBe('new');
      await lease.release();
    });

    it('defaults to stop-then-start, serialized with the other operations', async () => {
      const { pool, log } = makePool();
      const lease = await pool.acquire();
      await expect(pool.restart('http://127.0.0.1:1')).resolves.toBe('http://127.0.0.1:1');
      expect(log).toEqual(['start', 'stop', 'start']);
      await lease.release();
      expect(log).toEqual(['start', 'stop', 'start', 'stop']);
    });
  });
});

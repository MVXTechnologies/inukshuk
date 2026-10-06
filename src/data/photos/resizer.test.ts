import { createWebViewResizer, ResizeError, type WebViewResizerDeps } from './resizer';

const out = (base64: string) => ({ base64, width: 2, height: 1 });

function harness(overrides: Partial<WebViewResizerDeps> = {}) {
  const injected: string[] = [];
  let id = 0;
  const staged: string[] = [];
  const unstaged: string[] = [];
  const deps: WebViewResizerDeps = {
    stage: jest.fn(async (_src: string, jobId: string) => {
      staged.push(jobId);
      return `.photo-inbox/${jobId}.jpg`;
    }),
    unstage: jest.fn((p: string) => unstaged.push(p)),
    origin: async () => 'http://127.0.0.1:8123',
    inject: (script: string) => injected.push(script),
    newId: () => `j${++id}`,
    now: () => 1000,
    ...overrides,
  };
  const resizer = createWebViewResizer(deps);
  const reply = (jobId: string, extra: object = {}) =>
    resizer.handleMessage(
      JSON.stringify({
        type: 'resized',
        id: jobId,
        display: out('D'),
        thumb: out('T'),
        sprite: out('S'),
        sourceWidth: 4000,
        sourceHeight: 3000,
        decodeMs: 100,
        encodeMs: 200,
        ...extra,
      }),
    );
  return { resizer, injected, staged, unstaged, reply, deps };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createWebViewResizer', () => {
  it('waits for the page, serves the staged file, and resolves with the copies', async () => {
    const h = harness();
    const job = h.resizer.resize('file:///cache/a.jpg');
    await flush();
    expect(h.injected).toEqual([]); // page not ready yet
    h.resizer.handleMessage('{"type":"ready"}');
    await flush();
    expect(h.injected[0]).toContain('"src":"http://127.0.0.1:8123/.photo-inbox/j1.jpg"');
    h.reply('j1');
    await expect(job).resolves.toMatchObject({
      display: out('D'),
      sourceWidth: 4000,
      decodeMs: 100,
      encodeMs: 200,
      totalMs: 0,
    });
    expect(h.unstaged).toEqual(['.photo-inbox/j1.jpg']);
  });

  it('runs jobs one at a time, in order', async () => {
    const h = harness();
    h.resizer.handleMessage('{"type":"ready"}');
    const a = h.resizer.resize('a');
    const b = h.resizer.resize('b');
    await flush();
    expect(h.injected).toHaveLength(1);
    h.reply('j1');
    await a;
    await flush();
    expect(h.injected).toHaveLength(2);
    h.reply('j2');
    await expect(b).resolves.toBeTruthy();
  });

  it('rejects a failed job, cleans up, and keeps going', async () => {
    const h = harness();
    h.resizer.handleMessage('{"type":"ready"}');
    const bad = h.resizer.resize('bad');
    const good = h.resizer.resize('good');
    await flush();
    h.resizer.handleMessage('{"type":"failed","id":"j1","message":"could not decode the image"}');
    await expect(bad).rejects.toThrow('could not decode the image');
    await flush();
    h.reply('j2');
    await expect(good).resolves.toBeTruthy();
    expect(h.unstaged).toHaveLength(2);
  });

  it('times out a job the page never answers', async () => {
    jest.useFakeTimers();
    try {
      const h = harness({ timeoutMs: 1000 });
      h.resizer.handleMessage('{"type":"ready"}');
      const job = h.resizer.resize('slow');
      const assertion = expect(job).rejects.toThrow(ResizeError);
      await jest.advanceTimersByTimeAsync(1001);
      await assertion;
      expect(h.unstaged).toEqual(['.photo-inbox/j1.jpg']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses a staged path the server would not serve', async () => {
    const h = harness({ stage: async () => 'photos/t1/secret.jpg' });
    h.resizer.handleMessage('{"type":"ready"}');
    await expect(h.resizer.resize('x')).rejects.toThrow(/cannot serve/);
  });

  it('ignores junk, stray ids and replies after reset; waits for ready again after reset', async () => {
    const h = harness();
    h.resizer.handleMessage('not json');
    h.resizer.handleMessage('{"type":"resized","id":"nobody"}');
    h.resizer.handleMessage('{"type":"ready"}');
    h.resizer.reset();
    const job = h.resizer.resize('x');
    await flush();
    expect(h.injected).toEqual([]);
    h.resizer.handleMessage('{"type":"ready"}');
    await flush();
    h.reply('j1', { decodeMs: 'x' });
    await expect(job).resolves.toMatchObject({ decodeMs: 0 });
  });

  it('dispose fails the pending job and refuses new ones', async () => {
    const h = harness();
    h.resizer.handleMessage('{"type":"ready"}');
    const job = h.resizer.resize('x');
    await flush();
    h.resizer.dispose();
    await expect(job).rejects.toThrow('resizer was closed');
    await expect(h.resizer.resize('y')).rejects.toThrow('resizer was closed');
  });

  it('defaults the clock and timeout', async () => {
    const h = harness({ now: undefined, timeoutMs: undefined });
    h.resizer.handleMessage('{"type":"ready"}');
    const job = h.resizer.resize('x');
    await flush();
    h.reply('j1');
    const r = await job;
    expect(r.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('surfaces a non-Error rejection from staging as an Error', async () => {
    const h = harness({
      stage: () => Promise.reject(new Error('copy failed')),
    });
    await expect(h.resizer.resize('x')).rejects.toThrow('copy failed');
  });
});

import { acquireLocalServer, localServerLeases, writeServedText } from './localServer';

jest.mock('@dr.pogodin/react-native-static-server', () => {
  const instances: { options: unknown; start: jest.Mock; stop: jest.Mock }[] = [];
  // Scripted outcomes for the next constructed instances' start() (#290 tests).
  const startPlan: (() => Promise<string>)[] = [];
  class FakeStaticServer {
    readonly options: unknown;
    start = jest.fn(startPlan.shift() ?? (async () => 'http://127.0.0.1:8080'));
    stop = jest.fn(async () => undefined);
    constructor(options: unknown) {
      this.options = options;
      instances.push(this);
    }
  }
  return {
    __esModule: true,
    default: FakeStaticServer,
    ERROR_LOG_FILE: '/tmp/__rn-static-server__/errorlog.txt',
    __instances: instances,
    __startPlan: startPlan,
  };
});

jest.mock('./storage', () => ({ documentDirUri: () => 'file:///doc/' }));

jest.mock('expo-file-system', () => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  type MockPathLike = string | { path: string };
  const join = (parts: MockPathLike[]): string =>
    parts
      .map((p) => (typeof p === 'string' ? p.replace(/^file:\/\//, '') : p.path))
      .join('/')
      .replace(/\/+/g, '/');
  class File {
    readonly path: string;
    constructor(...parts: MockPathLike[]) {
      this.path = join(parts);
    }
    get uri(): string {
      return `file://${this.path}`;
    }
    get exists(): boolean {
      return files.has(this.path);
    }
    create(): void {
      files.set(this.path, '');
    }
    delete(): void {
      files.delete(this.path);
    }
    write(data: string): void {
      files.set(this.path, data);
    }
    async text(): Promise<string> {
      const data = files.get(this.path);
      if (data === undefined) throw new Error(`ENOENT ${this.path}`);
      return data;
    }
  }
  class Directory {
    readonly path: string;
    constructor(...parts: MockPathLike[]) {
      this.path = join(parts);
    }
    get exists(): boolean {
      return dirs.has(this.path);
    }
    create(): void {
      dirs.add(this.path);
    }
  }
  return {
    File,
    Directory,
    Paths: { document: '/doc', cache: '/cache' },
    __files: files,
    __dirs: dirs,
  };
});

const serverMock = jest.requireMock('@dr.pogodin/react-native-static-server') as {
  __instances: {
    options: { fileDir: string; port: number; hostname: string; extraConfig: string };
    start: jest.Mock;
    stop: jest.Mock;
  }[];
  __startPlan: (() => Promise<string>)[];
};
const fsMock = jest.requireMock('expo-file-system') as {
  __files: Map<string, string>;
  __dirs: Set<string>;
};

describe('acquireLocalServer', () => {
  it('builds exactly one server, rooted at Documents on loopback with the allowlist', async () => {
    const [a, b] = await Promise.all([acquireLocalServer(), acquireLocalServer()]);
    expect(serverMock.__instances).toHaveLength(1);
    const instance = serverMock.__instances[0];
    expect(instance?.options).toMatchObject({ fileDir: '/doc/', port: 0, hostname: '127.0.0.1' });
    expect(instance?.options.extraConfig).toContain('url.access-deny');
    expect(a.value).toBe('http://127.0.0.1:8080');
    expect(b.value).toBe(a.value);
    expect(localServerLeases()).toBe(2);

    await a.release();
    expect(instance?.stop).not.toHaveBeenCalled();
    await b.release();
    expect(instance?.stop).toHaveBeenCalledTimes(1);
    expect(localServerLeases()).toBe(0);
  });

  // The invariant the lib enforces natively ("another server instance is
  // active"): a second object must never be constructed, even after a stop.
  it('reuses the same instance for a later lease', async () => {
    const lease = await acquireLocalServer();
    expect(serverMock.__instances).toHaveLength(1);
    expect(serverMock.__instances[0]?.start).toHaveBeenCalled();
    await lease.release();
  });
});

describe('writeServedText', () => {
  it('writes under Documents, creating the folder, and overwrites a previous copy', () => {
    const uri = writeServedText('.rasterizer/index.html', '<html>1</html>');
    expect(uri).toBe('file:///doc/.rasterizer/index.html');
    expect(fsMock.__dirs.has('/doc/.rasterizer')).toBe(true);
    expect(fsMock.__files.get('/doc/.rasterizer/index.html')).toBe('<html>1</html>');
    writeServedText('.rasterizer/index.html', '<html>2</html>');
    expect(fsMock.__files.get('/doc/.rasterizer/index.html')).toBe('<html>2</html>');
  });
});

// #290 — the Android 11 phone whose lighttpd exits -1: retry on a fresh
// instance, and if that fails too, say why with lighttpd's own log.
describe('start failures (#290)', () => {
  type Mod = typeof import('./localServer');
  const crash = () =>
    Promise.reject(new Error('Server #1 crashed: Native server exited with status -1'));
  const LOG = '/tmp/__rn-static-server__/errorlog.txt';

  function freshModule(): Mod {
    let mod: Mod | undefined;
    jest.isolateModules(() => {
      mod = jest.requireActual<Mod>('./localServer');
    });
    if (!mod) throw new Error('module did not load');
    return mod;
  }

  beforeEach(() => {
    serverMock.__instances.length = 0;
    serverMock.__startPlan.length = 0;
    fsMock.__files.delete(LOG);
  });

  it('retries once on a FRESH instance and serves from the second', async () => {
    serverMock.__startPlan.push(crash, async () => 'http://127.0.0.1:9090');
    const mod = freshModule();
    const lease = await mod.acquireLocalServer();
    expect(lease.value).toBe('http://127.0.0.1:9090');
    expect(serverMock.__instances).toHaveLength(2);
    expect(serverMock.__instances[0]?.start).toHaveBeenCalledTimes(1);
    expect(serverMock.__instances[1]?.start).toHaveBeenCalledTimes(1);
    await lease.release();
    // The crashed instance is never stopped; the live one is.
    expect(serverMock.__instances[0]?.stop).not.toHaveBeenCalled();
    expect(serverMock.__instances[1]?.stop).toHaveBeenCalledTimes(1);
  });

  it('gives up after two attempts with the tail of the lighttpd error log', async () => {
    serverMock.__startPlan.push(crash, crash);
    fsMock.__files.set(
      LOG,
      '2026-09-08 22:57:12: (configfile.c.1900) unknown config-key: url.access-deny (ignored)\n' +
        "2026-09-08 22:57:12: (server.c.1500) can't bind to socket: 127.0.0.1:41234: Permission denied\n",
    );
    const mod = freshModule();
    await expect(mod.acquireLocalServer()).rejects.toThrow(
      /failed to start after 2 attempts[\s\S]*exited with status -1[\s\S]*lighttpd error log:[\s\S]*Permission denied/,
    );
    expect(serverMock.__instances).toHaveLength(2);
    expect(mod.localServerLeases()).toBe(0);
  });

  it('reports the failure even when there is no error log to read', async () => {
    serverMock.__startPlan.push(crash, crash);
    const mod = freshModule();
    await expect(mod.acquireLocalServer()).rejects.toThrow(/no lighttpd error log/);
  });

  it('a later lease after a total failure starts over on a new instance', async () => {
    serverMock.__startPlan.push(crash, crash, async () => 'http://127.0.0.1:7070');
    const mod = freshModule();
    await expect(mod.acquireLocalServer()).rejects.toThrow();
    const lease = await mod.acquireLocalServer();
    expect(lease.value).toBe('http://127.0.0.1:7070');
    expect(serverMock.__instances).toHaveLength(3);
    await lease.release();
  });
});

// iOS resume (#381, #385): the listener died under a live lease.
describe('restartLocalServer', () => {
  type Mod = typeof import('./localServer');
  function freshModule(): Mod {
    let mod: Mod | undefined;
    jest.isolateModules(() => {
      mod = jest.requireActual<Mod>('./localServer');
    });
    if (!mod) throw new Error('module did not load');
    return mod;
  }

  beforeEach(() => {
    serverMock.__instances.length = 0;
    serverMock.__startPlan.length = 0;
  });

  it('stops the dead instance and starts a fresh one on the same port', async () => {
    serverMock.__startPlan.push(
      async () => 'http://127.0.0.1:41234',
      async () => 'http://127.0.0.1:41234',
    );
    const mod = freshModule();
    const lease = await mod.acquireLocalServer();
    await expect(mod.restartLocalServer('http://127.0.0.1:41234')).resolves.toBe(
      'http://127.0.0.1:41234',
    );
    expect(serverMock.__instances).toHaveLength(2);
    expect(serverMock.__instances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(serverMock.__instances[1]?.options.port).toBe(41234);
    expect(lease.value).toBe('http://127.0.0.1:41234');
    await lease.release();
    // The replacement is the one a last release stops.
    expect(serverMock.__instances[1]?.stop).toHaveBeenCalledTimes(1);
  });

  it('takes any free port when the old one cannot be bound again, and leases see it', async () => {
    serverMock.__startPlan.push(
      async () => 'http://127.0.0.1:41234',
      () => Promise.reject(new Error('Server #2 crashed: bind: Address already in use')),
      async () => 'http://127.0.0.1:50000',
    );
    const mod = freshModule();
    const lease = await mod.acquireLocalServer();
    await expect(mod.restartLocalServer('http://127.0.0.1:41234')).resolves.toBe(
      'http://127.0.0.1:50000',
    );
    expect(serverMock.__instances.map((i) => i.options.port)).toEqual([0, 41234, 0]);
    expect(lease.value).toBe('http://127.0.0.1:50000');
    await lease.release();
  });

  it('does not start a second server while the first will not stop', async () => {
    jest.useFakeTimers();
    try {
      const mod = freshModule();
      const lease = await mod.acquireLocalServer();
      serverMock.__instances[0]?.stop.mockImplementationOnce(() => new Promise(() => undefined));
      const restarting = mod.restartLocalServer('http://127.0.0.1:8080');
      const settled = expect(restarting).rejects.toThrow(/did not stop within 3000 ms/);
      await jest.advanceTimersByTimeAsync(mod.STOP_TIMEOUT_MS);
      await settled;
      expect(serverMock.__instances).toHaveLength(1);
      // The next acquire starts over rather than handing out the dead value.
      const next = await mod.acquireLocalServer();
      expect(serverMock.__instances).toHaveLength(2);
      await next.release();
      await lease.release();
    } finally {
      jest.useRealTimers();
    }
  });

  it('restarts when the old instance fails to stop cleanly', async () => {
    const mod = freshModule();
    const lease = await mod.acquireLocalServer();
    serverMock.__instances[0]?.stop.mockRejectedValueOnce(new Error('crashed'));
    await expect(mod.restartLocalServer('http://127.0.0.1:8080')).resolves.toBe(
      'http://127.0.0.1:8080',
    );
    expect(serverMock.__instances).toHaveLength(2);
    await lease.release();
  });

  it('refuses without a lease', async () => {
    const mod = freshModule();
    await expect(mod.restartLocalServer('http://127.0.0.1:8080')).rejects.toThrow(
      /no lease is held/,
    );
    expect(serverMock.__instances).toHaveLength(0);
  });
});

describe('probeLocalServer', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('counts any HTTP answer as alive and asks for the unserved root', async () => {
    const fetchMock = jest.fn(async () => ({ status: 403 }) as Response);
    global.fetch = fetchMock as unknown as typeof fetch;
    const { probeLocalServer } =
      jest.requireActual<typeof import('./localServer')>('./localServer');
    await expect(probeLocalServer('http://127.0.0.1:8080/')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/',
      expect.objectContaining({ method: 'HEAD', cache: 'no-store' }),
    );
  });

  it('is dead when the connection is refused', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('Could not connect to the server.');
    }) as unknown as typeof fetch;
    const { probeLocalServer } =
      jest.requireActual<typeof import('./localServer')>('./localServer');
    await expect(probeLocalServer('http://127.0.0.1:8080')).resolves.toBe(false);
  });

  it('is dead when nothing answers in time', async () => {
    jest.useFakeTimers();
    try {
      global.fetch = jest.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
          }),
      ) as unknown as typeof fetch;
      const { probeLocalServer } =
        jest.requireActual<typeof import('./localServer')>('./localServer');
      const probe = probeLocalServer('http://127.0.0.1:8080', 1_500);
      await jest.advanceTimersByTimeAsync(1_500);
      await expect(probe).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

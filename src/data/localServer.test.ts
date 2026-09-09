import { acquireLocalServer, localServerLeases, writeServedText } from './localServer';

jest.mock('@dr.pogodin/react-native-static-server', () => {
  const instances: { options: unknown; start: jest.Mock; stop: jest.Mock }[] = [];
  class FakeStaticServer {
    readonly options: unknown;
    start = jest.fn(async () => 'http://127.0.0.1:8080');
    stop = jest.fn(async () => undefined);
    constructor(options: unknown) {
      this.options = options;
      instances.push(this);
    }
  }
  return { __esModule: true, default: FakeStaticServer, __instances: instances };
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

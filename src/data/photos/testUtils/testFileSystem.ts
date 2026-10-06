/**
 * Test-only (never imported by the app): an in-memory stand-in for the SDK 56
 * `expo-file-system` File/Directory/Paths API, covering what `@data/storage`
 * and `@data/photos` touch. Use it as
 *
 *   jest.mock('expo-file-system', () => require('./testUtils/testFileSystem').createFakeFileSystem());
 *
 * then reach the store with `fakeFs()` for seeding and assertions.
 */

type Data = Uint8Array;

interface Store {
  files: Map<string, Data>;
  dirs: Set<string>;
  freeBytes: number | null;
  /** Make the next write whose path matches throw this message. */
  failWrite: { match: RegExp; message: string } | null;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const SCHEME = 'file://';

function pathOf(part: unknown): string {
  if (typeof part === 'string') return part.startsWith(SCHEME) ? part.slice(SCHEME.length) : part;
  if (part && typeof part === 'object' && 'path' in part)
    return String((part as { path: string }).path);
  return String(part);
}

function join(parts: unknown[]): string {
  return parts.map(pathOf).join('/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function md5ish(bytes: Data): string {
  // Not MD5 — a stable FNV-1a digest is all the tests need.
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export function createFakeFileSystem() {
  const store: Store = { files: new Map(), dirs: new Set(), freeBytes: null, failWrite: null };

  const parentsOf = (p: string) => {
    const out: string[] = [];
    const segs = p.split('/');
    for (let i = 2; i < segs.length; i++) out.push(segs.slice(0, i).join('/'));
    return out;
  };

  class File {
    path: string;
    constructor(...parts: unknown[]) {
      this.path = join(parts);
    }
    get uri() {
      return SCHEME + this.path;
    }
    get name() {
      return this.path.split('/').pop() ?? '';
    }
    get exists() {
      return store.files.has(this.path);
    }
    get size() {
      return store.files.get(this.path)?.length ?? 0;
    }
    create() {
      store.files.set(this.path, new Uint8Array(0));
    }
    delete() {
      if (!store.files.delete(this.path)) throw new Error(`delete: ${this.path} missing`);
    }
    write(data: string | Data, options?: { encoding?: string }) {
      if (store.failWrite && store.failWrite.match.test(this.path)) {
        const { message } = store.failWrite;
        store.failWrite = null;
        throw new Error(message);
      }
      const bytes =
        typeof data === 'string'
          ? options?.encoding === 'base64'
            ? new Uint8Array(Buffer.from(data, 'base64'))
            : enc.encode(data)
          : data;
      store.files.set(this.path, bytes);
    }
    moveSync(dest: File, _opts?: { overwrite?: boolean }) {
      const data = store.files.get(this.path);
      if (!data) throw new Error(`move: ${this.path} missing`);
      store.files.set(dest.path, data);
      store.files.delete(this.path);
      this.path = dest.path;
    }
    async copy(dest: File) {
      const data = store.files.get(this.path);
      if (!data) throw new Error(`copy: ${this.path} missing`);
      store.files.set(dest.path, data);
    }
    async bytes() {
      const data = store.files.get(this.path);
      if (!data) throw new Error(`bytes: ${this.path} missing`);
      return data;
    }
    async text() {
      return this.textSync();
    }
    textSync() {
      const data = store.files.get(this.path);
      if (!data) throw new Error(`text: ${this.path} missing`);
      return dec.decode(data);
    }
    info(opts?: { md5?: boolean }) {
      const data = store.files.get(this.path);
      return data
        ? { exists: true, size: data.length, ...(opts?.md5 ? { md5: md5ish(data) } : {}) }
        : { exists: false };
    }
    open(mode?: string) {
      const path = this.path;
      const data = store.files.get(path);
      if (!data) throw new Error(`open: ${path} missing`);
      let offset = 0;
      return {
        size: data.length,
        readBytes(n: number) {
          const out = data.slice(offset, offset + n);
          offset += out.length;
          return out;
        },
        writeBytes(chunk: Data) {
          if (mode !== 'a') throw new Error('opened read-only');
          const prev = store.files.get(path) ?? new Uint8Array(0);
          const next = new Uint8Array(prev.length + chunk.length);
          next.set(prev);
          next.set(chunk, prev.length);
          store.files.set(path, next);
        },
        close() {},
      };
    }
  }

  class Directory {
    path: string;
    constructor(...parts: unknown[]) {
      this.path = join(parts);
    }
    get uri() {
      return SCHEME + this.path;
    }
    get name() {
      return this.path.split('/').pop() ?? '';
    }
    get exists() {
      return (
        store.dirs.has(this.path) ||
        [...store.files.keys()].some((f) => f.startsWith(`${this.path}/`))
      );
    }
    create() {
      store.dirs.add(this.path);
      for (const p of parentsOf(this.path)) store.dirs.add(p);
    }
    delete() {
      for (const f of [...store.files.keys()])
        if (f.startsWith(`${this.path}/`)) store.files.delete(f);
      for (const d of [...store.dirs])
        if (d === this.path || d.startsWith(`${this.path}/`)) store.dirs.delete(d);
    }
    list(): (File | Directory)[] {
      const prefix = `${this.path}/`;
      const children = new Map<string, File | Directory>();
      for (const f of store.files.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const head = rest.split('/')[0]!;
        if (rest.includes('/')) children.set(head, new Directory(prefix + head));
        else children.set(head, new File(f));
      }
      for (const d of store.dirs) {
        if (!d.startsWith(prefix)) continue;
        const rest = d.slice(prefix.length);
        if (rest !== '' && !rest.includes('/')) children.set(rest, new Directory(d));
      }
      return [...children.values()];
    }
  }

  return {
    File,
    Directory,
    Paths: {
      document: '/doc',
      cache: '/cache',
      get availableDiskSpace() {
        if (store.freeBytes === null) throw new Error('unavailable');
        return store.freeBytes;
      },
    },
    FileMode: { ReadOnly: 'r', Append: 'a' },
    __store: store,
  };
}

export interface FakeFs {
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
  freeBytes: number | null;
  failWrite: { match: RegExp; message: string } | null;
}

/** The store behind the mocked module (call after `jest.mock`). */
export function fakeFs(): FakeFs & {
  reset(): void;
  seed(path: string, data: string | Uint8Array): void;
  text(path: string): string | undefined;
  list(prefix: string): string[];
} {
  const store = (jest.requireMock('expo-file-system') as { __store: Store }).__store;
  return Object.assign(store, {
    reset() {
      store.files.clear();
      store.dirs.clear();
      store.freeBytes = null;
      store.failWrite = null;
    },
    seed(path: string, data: string | Uint8Array) {
      store.files.set(path, typeof data === 'string' ? enc.encode(data) : data);
    },
    text(path: string) {
      const d = store.files.get(path);
      return d ? dec.decode(d) : undefined;
    },
    list(prefix: string) {
      return [...store.files.keys()].filter((f) => f.startsWith(prefix)).sort();
    },
  });
}

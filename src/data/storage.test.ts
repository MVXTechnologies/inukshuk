import {
  downloadBytes,
  OfflineOnlyError,
  pickEvictions,
  readJson,
  setNetworkAllowed,
  writeJson,
  type CacheEntry,
} from './storage';

// In-memory fake of the SDK 56 expo-file-system File/Directory/Paths API,
// modelling exactly the surface storage.ts touches. Files live in a Map keyed
// by absolute path; a monotonic clock stamps modification times.
jest.mock('expo-file-system', () => {
  const files = new Map<string, { data: string | Uint8Array; mtime: number }>();
  const dirs = new Set<string>();
  let clock = 1;
  type MockPathLike = string | { path: string };
  const joinPath = (parts: MockPathLike[]): string =>
    parts.map((p) => (typeof p === 'string' ? p.replace(/^file:\/\//, '') : p.path)).join('/');

  class File {
    readonly path: string;
    static downloadFileAsync = jest.fn();
    constructor(...parts: MockPathLike[]) {
      this.path = joinPath(parts);
    }
    get uri(): string {
      return `file://${this.path}`;
    }
    get name(): string {
      return this.path.split('/').pop() ?? '';
    }
    get exists(): boolean {
      return files.has(this.path);
    }
    get size(): number {
      return files.get(this.path)?.data.length ?? 0;
    }
    get modificationTime(): number {
      return files.get(this.path)?.mtime ?? 0;
    }
    create(): void {
      files.set(this.path, { data: '', mtime: clock++ });
    }
    delete(): void {
      if (!files.delete(this.path)) throw new Error(`delete: ${this.path} does not exist`);
    }
    write(data: string | Uint8Array): void {
      files.set(this.path, { data, mtime: clock++ });
    }
    async text(): Promise<string> {
      const entry = files.get(this.path);
      if (!entry || typeof entry.data !== 'string') throw new Error(`text: ${this.path}`);
      return entry.data;
    }
    async bytes(): Promise<Uint8Array> {
      const entry = files.get(this.path);
      if (!entry) throw new Error(`bytes: ${this.path} does not exist`);
      return typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data;
    }
    copy(dest: File): void {
      const entry = files.get(this.path);
      if (!entry) throw new Error(`copy: ${this.path} does not exist`);
      files.set(dest.path, { data: entry.data, mtime: clock++ });
    }
    move(dest: File): void {
      this.copy(dest);
      files.delete(this.path);
    }
  }

  class Directory {
    readonly path: string;
    constructor(...parts: MockPathLike[]) {
      this.path = joinPath(parts);
    }
    get uri(): string {
      return `file://${this.path}`;
    }
    get exists(): boolean {
      return dirs.has(this.path);
    }
    create(): void {
      dirs.add(this.path);
    }
    list(): File[] {
      return [...files.keys()]
        .filter(
          (p) => p.startsWith(`${this.path}/`) && !p.slice(this.path.length + 1).includes('/'),
        )
        .map((p) => new File(p));
    }
  }

  return {
    File,
    Directory,
    Paths: { document: '/doc', cache: '/cache' },
    __reset: (): void => {
      files.clear();
      dirs.clear();
      clock = 1;
    },
    __seed: (path: string, data: string | Uint8Array): void => {
      files.set(path, { data, mtime: clock++ });
    },
    __has: (path: string): boolean => files.has(path),
    __read: (path: string): string | Uint8Array | undefined => files.get(path)?.data,
    __download: File.downloadFileAsync,
  };
});

const fsMock = jest.requireMock('expo-file-system') as {
  __reset: () => void;
  __seed: (path: string, data: string | Uint8Array) => void;
  __has: (path: string) => boolean;
  __read: (path: string) => string | Uint8Array | undefined;
  __download: jest.Mock;
};

/** Point the fake downloader at a canned payload written into the destination file. */
function serveDownload(bytes: number[]): void {
  fsMock.__download.mockImplementation(
    async (_url: string, dest: { write: (data: Uint8Array) => void }) => {
      dest.write(new Uint8Array(bytes));
    },
  );
}

beforeEach(() => {
  fsMock.__reset();
  setNetworkAllowed(true);
});

describe('writeJson / readJson atomicity', () => {
  it('writeJson lands the payload at the target and removes the staging file', async () => {
    writeJson('library.json', { maps: ['a'] });
    expect(fsMock.__has('/doc/library.json')).toBe(true);
    expect(fsMock.__has('/doc/library.json.tmp')).toBe(false);
    await expect(readJson('library.json')).resolves.toEqual({ maps: ['a'] });

    // Rewriting replaces the previous version and still leaves no staging file.
    writeJson('library.json', { maps: ['a', 'b'] });
    expect(fsMock.__has('/doc/library.json.tmp')).toBe(false);
    await expect(readJson('library.json')).resolves.toEqual({ maps: ['a', 'b'] });
  });

  it('readJson recovers the staged .tmp when a crash interrupted the swap', async () => {
    // Simulate a kill between writeJson's delete and move: only the fully
    // written staging file exists.
    fsMock.__seed('/doc/library.json.tmp', JSON.stringify({ maps: ['staged'] }));
    await expect(readJson('library.json')).resolves.toEqual({ maps: ['staged'] });
  });

  it('readJson prefers the target over a stale .tmp', async () => {
    fsMock.__seed('/doc/library.json', JSON.stringify({ v: 'target' }));
    fsMock.__seed('/doc/library.json.tmp', JSON.stringify({ v: 'stale' }));
    await expect(readJson('library.json')).resolves.toEqual({ v: 'target' });
  });

  it('preserves a corrupt target as .corrupt and recovers the staged .tmp', async () => {
    const torn = '{"maps": [tru';
    fsMock.__seed('/doc/library.json', torn);
    fsMock.__seed('/doc/library.json.tmp', JSON.stringify({ v: 'recovered' }));

    await expect(readJson('library.json')).resolves.toEqual({ v: 'recovered' });
    // The unparseable payload is kept for forensics rather than silently dropped.
    expect(fsMock.__read('/doc/library.json.corrupt')).toBe(torn);
    expect(fsMock.__read('/doc/library.json')).toBe(torn);
  });

  it('returns null when the document is missing or corrupt with no recoverable .tmp', async () => {
    await expect(readJson('missing.json')).resolves.toBeNull();

    fsMock.__seed('/doc/library.json', 'not json');
    fsMock.__seed('/doc/library.json.tmp', 'also not json');
    await expect(readJson('library.json')).resolves.toBeNull();
    expect(fsMock.__read('/doc/library.json.corrupt')).toBe('not json');
  });
});

describe('pickEvictions', () => {
  const entry = (name: string, size: number, mtime: number): CacheEntry => ({ name, size, mtime });

  it('returns [] when the total size is within the cap', () => {
    expect(pickEvictions([entry('a', 50, 1), entry('b', 50, 2)], 100)).toEqual([]);
  });

  it('returns [] for an empty cache', () => {
    expect(pickEvictions([], 100)).toEqual([]);
  });

  it('evicts oldest-modified first, down to 75% of the cap', () => {
    // Total 120 > cap 100; target 75. Evicting the two oldest (unsorted input)
    // brings the total to 40 ≤ 75; the newest survives.
    const entries = [entry('new', 40, 3), entry('oldest', 40, 1), entry('older', 40, 2)];
    expect(pickEvictions(entries, 100)).toEqual(['oldest', 'older']);
    // The input array itself is not reordered.
    expect(entries.map((e) => e.name)).toEqual(['new', 'oldest', 'older']);
  });

  it('evicts a single file that alone exceeds the cap', () => {
    expect(pickEvictions([entry('big', 200, 1)], 100)).toEqual(['big']);
  });
});

describe('downloadBytes', () => {
  it('downloads on a cache miss and serves the cached bytes afterwards', async () => {
    serveDownload([1, 2, 3]);
    const first = await downloadBytes('https://tiles/1.bin', 'tile-1.bin');
    expect(Array.from(first)).toEqual([1, 2, 3]);
    expect(fsMock.__download).toHaveBeenCalledTimes(1);

    // Tiles are immutable: the second call is served from disk, no re-fetch.
    const second = await downloadBytes('https://tiles/1.bin', 'tile-1.bin');
    expect(Array.from(second)).toEqual([1, 2, 3]);
    expect(fsMock.__download).toHaveBeenCalledTimes(1);
  });

  it('re-downloads when the cached entry is empty', async () => {
    fsMock.__seed('/cache/dem/tile-2.bin', new Uint8Array(0));
    serveDownload([7]);
    const bytes = await downloadBytes('https://tiles/2.bin', 'tile-2.bin');
    expect(Array.from(bytes)).toEqual([7]);
    expect(fsMock.__download).toHaveBeenCalledTimes(1);
  });

  it('passes headers through to the downloader', async () => {
    serveDownload([1]);
    await downloadBytes('https://tiles/3.bin', 'tile-3.bin', { Authorization: 'token' });
    expect(fsMock.__download).toHaveBeenCalledWith('https://tiles/3.bin', expect.anything(), {
      headers: { Authorization: 'token' },
    });
  });

  it('offline-only: a cache miss throws OfflineOnlyError, a cache hit still serves', async () => {
    setNetworkAllowed(false);

    await expect(downloadBytes('https://tiles/4.bin', 'tile-4.bin')).rejects.toBeInstanceOf(
      OfflineOnlyError,
    );
    await expect(downloadBytes('https://tiles/4.bin', 'tile-4.bin')).rejects.toThrow(
      'offline-only: tile-4.bin not cached',
    );
    expect(fsMock.__download).not.toHaveBeenCalled();

    fsMock.__seed('/cache/dem/tile-5.bin', new Uint8Array([5]));
    const cached = await downloadBytes('https://tiles/5.bin', 'tile-5.bin');
    expect(Array.from(cached)).toEqual([5]);
    expect(fsMock.__download).not.toHaveBeenCalled();
  });

  it('setNetworkAllowed(true) restores fetching', async () => {
    setNetworkAllowed(false);
    await expect(downloadBytes('https://tiles/6.bin', 'tile-6.bin')).rejects.toThrow(
      'offline-only: tile-6.bin not cached',
    );

    setNetworkAllowed(true);
    serveDownload([9]);
    const bytes = await downloadBytes('https://tiles/6.bin', 'tile-6.bin');
    expect(Array.from(bytes)).toEqual([9]);
  });
});

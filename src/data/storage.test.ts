import { File } from 'expo-file-system';

import {
  adoptOverlayPng,
  existingOverlayPng,
  clearPdfDetailPngs,
  deleteFileAt,
  documentDirUri,
  downloadBytes,
  fileExists,
  OfflineOnlyError,
  pickEvictions,
  readFileText,
  readJson,
  resolveDocumentPath,
  setNetworkAllowed,
  toDocumentPath,
  writeJson,
  writeTrackGpx,
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
    path: string;
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
      return this.textSync();
    }
    textSync(): string {
      const entry = files.get(this.path);
      if (!entry || typeof entry.data !== 'string') throw new Error(`text: ${this.path}`);
      return entry.data;
    }
    async bytes(): Promise<Uint8Array> {
      const entry = files.get(this.path);
      if (!entry) throw new Error(`bytes: ${this.path} does not exist`);
      return typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data;
    }
    async copy(dest: File): Promise<void> {
      await Promise.resolve();
      this.copySync(dest);
    }
    copySync(dest: File): void {
      const entry = files.get(this.path);
      if (!entry) throw new Error(`copy: ${this.path} does not exist`);
      files.set(dest.path, { data: entry.data, mtime: clock++ });
    }
    async move(dest: File): Promise<void> {
      await Promise.resolve();
      this.moveSync(dest);
    }
    moveSync(dest: File): void {
      this.copySync(dest);
      files.delete(this.path);
      this.path = dest.path;
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
  jest.restoreAllMocks();
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

  it('surfaces a promotion failure synchronously and retains the recoverable stage', async () => {
    fsMock.__seed('/doc/library.json', '{"v":"old"}');
    jest.spyOn(File.prototype, 'move').mockImplementation(() => new Promise(() => {}));
    jest.spyOn(File.prototype, 'moveSync').mockImplementationOnce(() => {
      throw new Error('Move denied');
    });
    expect(() => writeJson('library.json', { v: 'new' })).toThrow('Move denied');
    expect(fsMock.__has('/doc/library.json')).toBe(false);
    await expect(readJson('library.json')).resolves.toEqual({ v: 'new' });
  });

  it.each(['create', 'write'] as const)(
    'preserves the sole staged index when a retry fails during %s after promotion failure',
    async (operation) => {
      fsMock.__seed('/doc/library.json', '{"v":"old"}');
      jest.spyOn(File.prototype, 'moveSync').mockImplementationOnce(() => {
        throw new Error('Move denied');
      });
      expect(() => writeJson('library.json', { v: 'saved' })).toThrow('Move denied');
      await expect(readJson('library.json')).resolves.toEqual({ v: 'saved' });
      jest.spyOn(File.prototype, operation).mockImplementationOnce(() => {
        throw new Error('ENOSPC');
      });
      expect(() => writeJson('library.json', { v: 'retry' })).toThrow();
      await expect(readJson('library.json')).resolves.toEqual({ v: 'saved' });
    },
  );

  it('preserves a valid stage behind a corrupt target when the next write fails', async () => {
    fsMock.__seed('/doc/library.json', 'broken');
    fsMock.__seed('/doc/library.json.tmp', '{"v":"saved"}');
    jest.spyOn(File.prototype, 'write').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() => writeJson('library.json', { v: 'retry' })).toThrow();
    await expect(readJson('library.json')).resolves.toEqual({ v: 'saved' });
  });

  it('retains the sole staged index if recovery promotion itself fails', async () => {
    fsMock.__seed('/doc/library.json.tmp', '{"v":"saved"}');
    jest.spyOn(File.prototype, 'moveSync').mockImplementationOnce(() => {
      throw new Error('Move denied');
    });
    expect(() => writeJson('library.json', { v: 'retry' })).toThrow('Move denied');
    await expect(readJson('library.json')).resolves.toEqual({ v: 'saved' });
  });

  it('waits for the forensic copy before completing corrupt-file recovery', async () => {
    fsMock.__seed('/doc/library.json', 'broken');
    fsMock.__seed('/doc/library.json.tmp', '{"v":"recovered"}');
    let finishCopy: () => void = () => {};
    const copy = new Promise<void>((resolve) => {
      finishCopy = resolve;
    });
    jest.spyOn(File.prototype, 'copy').mockReturnValueOnce(copy);
    let completed = false;
    const result = readJson('library.json').then((value) => {
      completed = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);
    finishCopy();
    await expect(result).resolves.toEqual({ v: 'recovered' });
  });

  it('recovers staged JSON when the asynchronous forensic copy fails', async () => {
    fsMock.__seed('/doc/library.json', 'broken');
    fsMock.__seed('/doc/library.json.tmp', '{"v":"recovered"}');
    jest.spyOn(File.prototype, 'copy').mockRejectedValueOnce(new Error('Copy denied'));
    await expect(readJson('library.json')).resolves.toEqual({ v: 'recovered' });
    expect(fsMock.__read('/doc/library.json')).toBe('broken');
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

  it('passes headers through and always downloads idempotently (iOS overwrite, #126)', async () => {
    serveDownload([1]);
    await downloadBytes('https://tiles/3.bin', 'tile-3.bin', { Authorization: 'token' });
    expect(fsMock.__download).toHaveBeenCalledWith('https://tiles/3.bin', expect.anything(), {
      idempotent: true,
      headers: { Authorization: 'token' },
    });

    serveDownload([2]);
    await downloadBytes('https://tiles/3b.bin', 'tile-3b.bin');
    expect(fsMock.__download).toHaveBeenLastCalledWith('https://tiles/3b.bin', expect.anything(), {
      idempotent: true,
    });
  });

  it('deduplicates concurrent downloads of the same tile (#126 cold-cache race)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fsMock.__download.mockImplementation(
      async (_url: string, dest: { write: (data: Uint8Array) => void }) => {
        await gate;
        dest.write(new Uint8Array([1, 2]));
      },
    );

    // Two callers race for the same cache file while nothing is on disk yet —
    // exactly the DestinationAlreadyExistsException scenario on iOS. They must
    // share ONE download.
    const a = downloadBytes('https://tiles/7.bin', 'tile-7.bin');
    const b = downloadBytes('https://tiles/7.bin', 'tile-7.bin');
    release();
    expect(Array.from(await a)).toEqual([1, 2]);
    expect(Array.from(await b)).toEqual([1, 2]);
    expect(fsMock.__download).toHaveBeenCalledTimes(1);

    // Once settled the key is released: a later call is a plain cache hit.
    const later = await downloadBytes('https://tiles/7.bin', 'tile-7.bin');
    expect(Array.from(later)).toEqual([1, 2]);
    expect(fsMock.__download).toHaveBeenCalledTimes(1);
  });

  it('rejects and deletes a downloaded payload that fails validation (#129)', async () => {
    serveDownload([9, 9]);
    const rejectNines = (b: Uint8Array) => b[0] !== 9;
    await expect(
      downloadBytes('https://tiles/8.bin', 'tile-8.bin', undefined, rejectNines),
    ).rejects.toThrow('invalid tile response: tile-8.bin');
    // The bad payload must not stay behind as a poisoned cache entry.
    expect(fsMock.__has('/cache/dem/tile-8.bin')).toBe(false);
  });

  it('re-downloads when a cached entry fails validation (busts a poisoned cache)', async () => {
    fsMock.__seed('/cache/dem/tile-9.bin', new Uint8Array([9]));
    serveDownload([1]);
    const rejectNines = (b: Uint8Array) => b[0] !== 9;
    const bytes = await downloadBytes('https://tiles/9.bin', 'tile-9.bin', undefined, rejectNines);
    expect(Array.from(bytes)).toEqual([1]);
    expect(fsMock.__download).toHaveBeenCalledTimes(1);
    expect(fsMock.__read('/cache/dem/tile-9.bin')).toEqual(new Uint8Array([1]));
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

// --- #247: document-relative paths -----------------------------------------
//
// The mock's document directory is `/doc`, so `documentDirUri()` is
// `file:///doc` — the stand-in for the container UUID iOS rotates on updates.

describe('document-relative paths', () => {
  const OLD_CONTAINER =
    'file:///var/mobile/Containers/Data/Application/DEAD-BEEF-0000-1111/Documents';

  it('documentDirUri reports the current document directory', () => {
    expect(documentDirUri()).toBe('file:///doc');
  });

  it('resolveDocumentPath builds an absolute uri against the current directory', () => {
    expect(resolveDocumentPath('tracks/a.gpx')).toBe('file:///doc/tracks/a.gpx');
  });

  it('resolveDocumentPath passes absolute input through untouched', () => {
    // content:// intent uris, cache files and foreign paths must survive: read
    // helpers resolve unconditionally, so this is the escape hatch.
    expect(resolveDocumentPath('content://downloads/7')).toBe('content://downloads/7');
    expect(resolveDocumentPath('file:///cache/overlays/x.png')).toBe(
      'file:///cache/overlays/x.png',
    );
  });

  it('toDocumentPath strips the current directory, and a rotated container', () => {
    expect(toDocumentPath('file:///doc/tracks/a.gpx')).toBe('tracks/a.gpx');
    expect(toDocumentPath(`${OLD_CONTAINER}/tracks/a.gpx`)).toBe('tracks/a.gpx');
  });

  it('toDocumentPath is idempotent and leaves foreign absolutes alone', () => {
    expect(toDocumentPath('tracks/a.gpx')).toBe('tracks/a.gpx');
    expect(toDocumentPath('file:///cache/overlays/x.png')).toBe('file:///cache/overlays/x.png');
  });

  it('round-trips: resolve(toDocumentPath(uri)) is the uri again', () => {
    const uri = 'file:///doc/photos/p1.jpg';
    expect(resolveDocumentPath(toDocumentPath(uri))).toBe(uri);
  });

  it('rehomes a path stranded by a rotated container onto the current one', () => {
    // The whole point of #247: what 1.5.0 wrote, read back after the update.
    expect(resolveDocumentPath(toDocumentPath(`${OLD_CONTAINER}/tracks/a.gpx`))).toBe(
      'file:///doc/tracks/a.gpx',
    );
  });

  it('readers and stats accept a relative path as readily as an absolute one', async () => {
    const uri = writeTrackGpx('t1', '<gpx/>');
    expect(uri).toBe('file:///doc/tracks/t1.gpx');

    // Both forms name the same file — that is what lets every existing call
    // site keep passing whatever it holds.
    expect(fileExists('tracks/t1.gpx')).toBe(true);
    expect(fileExists(uri)).toBe(true);
    await expect(readFileText('tracks/t1.gpx')).resolves.toBe('<gpx/>');
    await expect(readFileText(uri)).resolves.toBe('<gpx/>');

    deleteFileAt('tracks/t1.gpx');
    expect(fileExists(uri)).toBe(false);
  });

  it('a reader given a path stranded under an old container still finds the file', async () => {
    writeTrackGpx('t2', '<gpx>2</gpx>');
    // deleteFileAt/readFileText do NOT relativise (they only resolve), so a
    // stale absolute path is still a miss here — healing is the migration's
    // job, on hydrate. Assert that boundary rather than pretend otherwise.
    expect(fileExists(`${OLD_CONTAINER}/tracks/t2.gpx`)).toBe(false);
    expect(fileExists(toDocumentPath(`${OLD_CONTAINER}/tracks/t2.gpx`))).toBe(true);
  });
});

describe('GPX replacement durability', () => {
  it.each(['create', 'write'] as const)(
    'preserves the saved GPX when staging %s fails',
    async (operation) => {
      writeTrackGpx('t1', '<gpx>original</gpx>');
      jest.spyOn(File.prototype, operation).mockImplementationOnce(() => {
        throw new Error('ENOSPC');
      });
      expect(() => writeTrackGpx('t1', '<gpx>replacement</gpx>')).toThrow();
      expect(fsMock.__read('/doc/tracks/t1.gpx')).toBe('<gpx>original</gpx>');
      await expect(readFileText('tracks/t1.gpx')).resolves.toBe('<gpx>original</gpx>');
    },
  );

  it('restores the saved GPX when promotion fails', async () => {
    writeTrackGpx('t1', '<gpx>original</gpx>');
    const move = File.prototype.moveSync;
    jest.spyOn(File.prototype, 'moveSync').mockImplementation(function (
      this: File,
      destination,
      options,
    ) {
      if (this.uri.endsWith('.tmp')) throw new Error('Move denied');
      move.call(this, destination, options);
    });
    expect(() => writeTrackGpx('t1', '<gpx>replacement</gpx>')).toThrow('Move denied');
    expect(fsMock.__read('/doc/tracks/t1.gpx')).toBe('<gpx>original</gpx>');
    await expect(readFileText('tracks/t1.gpx')).resolves.toBe('<gpx>original</gpx>');
  });

  it('keeps the GPX readable if rollback fails and recovers it before retrying', async () => {
    writeTrackGpx('t1', '<gpx>original</gpx>');
    const move = File.prototype.moveSync;
    jest.spyOn(File.prototype, 'moveSync').mockImplementation(function (
      this: File,
      destination,
      options,
    ) {
      if (this.uri.endsWith('.tmp') || this.uri.endsWith('.bak')) throw new Error('Move denied');
      move.call(this, destination, options);
    });
    expect(() => writeTrackGpx('t1', '<gpx>replacement</gpx>')).toThrow('Move denied');
    await expect(readFileText('tracks/t1.gpx')).resolves.toBe('<gpx>original</gpx>');
    jest.restoreAllMocks();
    expect(writeTrackGpx('t1', '<gpx>retry</gpx>')).toBe('file:///doc/tracks/t1.gpx');
    await expect(readFileText('tracks/t1.gpx')).resolves.toBe('<gpx>retry</gpx>');
    expect(fsMock.__has('/doc/tracks/t1.gpx.bak')).toBe(false);
    expect(fsMock.__has('/doc/tracks/t1.gpx.tmp')).toBe(false);
  });
});

it('finds an interrupted GPX backup and removes its recovery files on deletion', async () => {
  fsMock.__seed('/doc/tracks/recovered.gpx.bak', '<gpx>saved</gpx>');
  fsMock.__seed('/doc/tracks/recovered.gpx.tmp', '<partial');
  expect(fileExists('tracks/recovered.gpx')).toBe(true);
  await expect(readFileText('tracks/recovered.gpx')).resolves.toBe('<gpx>saved</gpx>');
  deleteFileAt('tracks/recovered.gpx');
  expect(fileExists('tracks/recovered.gpx')).toBe(false);
  expect(fsMock.__has('/doc/tracks/recovered.gpx.tmp')).toBe(false);
});

describe('native overview ownership', () => {
  it('moves the native PNG into the persistent overview name without reading its bytes', () => {
    fsMock.__seed('/cache/overlays/pdf-detail-native-one.png', 'PNG');
    const uri = adoptOverlayPng(
      'sheet_revision_0_2048',
      'file:///cache/overlays/pdf-detail-native-one.png',
    );
    expect(uri).toBe('file:///cache/overlays/sheet_revision_0_2048.png');
    expect(fsMock.__has('/cache/overlays/pdf-detail-native-one.png')).toBe(false);
    expect(fsMock.__read('/cache/overlays/sheet_revision_0_2048.png')).toBe('PNG');
    clearPdfDetailPngs();
    expect(existingOverlayPng('sheet_revision_0_2048')).toBe(uri);
  });

  it('keeps the completed immutable overview and discards a redundant native output', () => {
    fsMock.__seed('/cache/overlays/same.png', 'SAVED');
    fsMock.__seed('/cache/overlays/pdf-detail-native-duplicate.png', 'DUPLICATE');
    expect(adoptOverlayPng('same', 'file:///cache/overlays/pdf-detail-native-duplicate.png')).toBe(
      'file:///cache/overlays/same.png',
    );
    expect(fsMock.__read('/cache/overlays/same.png')).toBe('SAVED');
    expect(fsMock.__has('/cache/overlays/pdf-detail-native-duplicate.png')).toBe(false);
  });

  it('does not delete an output already stored at its final name', () => {
    fsMock.__seed('/cache/overlays/same.png', 'SAVED');
    expect(adoptOverlayPng('same', 'file:///cache/overlays/same.png')).toBe(
      'file:///cache/overlays/same.png',
    );
    expect(fsMock.__read('/cache/overlays/same.png')).toBe('SAVED');
  });

  it('cleans the unowned native PNG when promotion fails', () => {
    fsMock.__seed('/cache/overlays/pdf-detail-native-failed.png', 'PNG');
    jest.spyOn(File.prototype, 'moveSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() =>
      adoptOverlayPng('failed', 'file:///cache/overlays/pdf-detail-native-failed.png'),
    ).toThrow('Not enough free space');
    expect(fsMock.__has('/cache/overlays/pdf-detail-native-failed.png')).toBe(false);
    expect(existingOverlayPng('failed')).toBeNull();
  });
});

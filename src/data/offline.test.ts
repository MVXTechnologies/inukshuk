import { NetworkManager, OfflineManager } from '@maplibre/maplibre-react-native';

import { createRegionPack, setOfflineOnly } from './offline';
import * as storage from './storage';

jest.mock('./storage', () => ({
  setNetworkAllowed: jest.fn(),
}));

jest.mock('@maplibre/maplibre-react-native', () => ({
  OfflineManager: {
    createPack: jest.fn(),
    deletePack: jest.fn(async () => undefined),
    getPacks: jest.fn(async () => []),
    setTileCountLimit: jest.fn(),
  },
  NetworkManager: {
    setConnected: jest.fn(),
  },
}));

jest.mock('@dr.pogodin/react-native-static-server', () => {
  const instances: { start: jest.Mock; stop: jest.Mock }[] = [];
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

// Minimal in-memory fake of the expo-file-system surface offline.ts touches
// (the serialized style file and its directory).
jest.mock('expo-file-system', () => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  type MockPathLike = string | { path: string };
  const joinPath = (parts: MockPathLike[]): string =>
    parts.map((p) => (typeof p === 'string' ? p.replace(/^file:\/\//, '') : p.path)).join('/');
  class File {
    readonly path: string;
    constructor(...parts: MockPathLike[]) {
      this.path = joinPath(parts);
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
  }
  return {
    File,
    Directory,
    Paths: { document: '/doc', cache: '/cache' },
    __has: (path: string): boolean => files.has(path),
    __reset: (): void => {
      files.clear();
      dirs.clear();
    },
  };
});

const fsMock = jest.requireMock('expo-file-system') as {
  __has: (path: string) => boolean;
  __reset: () => void;
};
const serverMock = jest.requireMock('@dr.pogodin/react-native-static-server') as {
  __instances: { start: jest.Mock; stop: jest.Mock }[];
};

type Pack = { id: string };
type Status = { percentage: number; completedTileSize: number };
type ProgressCb = (pack: Pack, status: Status) => void;
type ErrorCb = (pack: Pack, err: { message: string }) => void;

// Listener hooks captured from the createPack mock so tests can drive the
// native downloader's progress/error events.
let emitProgress: ProgressCb = () => {};
let emitError: ErrorCb = () => {};

function mockCreatePack(): void {
  (OfflineManager.createPack as jest.Mock).mockImplementation(
    (_options: unknown, onProgress: ProgressCb, onError: ErrorCb) => {
      emitProgress = onProgress;
      emitError = onError;
      return Promise.resolve({ id: 'native-1' });
    },
  );
}

const packArgs = {
  id: 'r1',
  label: 'Home range',
  basemap: 'map' as const,
  styleJSON: '{"version":8,"sources":{},"layers":[]}',
  bounds: { minLng: -72, minLat: 46, maxLng: -71, maxLat: 47 },
  minZoom: 10,
  maxZoom: 14,
};

/** Drain the microtask queue so createRegionPack's awaits reach createPack. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function lastServer(): { start: jest.Mock; stop: jest.Mock } | undefined {
  return serverMock.__instances[serverMock.__instances.length - 1];
}

beforeEach(() => {
  fsMock.__reset();
  serverMock.__instances.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('createRegionPack', () => {
  it('serves the style over loopback http and resolves when progress reaches 100%', async () => {
    mockCreatePack();
    const onProgress = jest.fn();
    const pending = createRegionPack(packArgs, onProgress);
    await flushMicrotasks();

    const options = (OfflineManager.createPack as jest.Mock).mock.calls[0]?.[0] as {
      mapStyle: string;
      bounds: number[];
      minZoom: number;
      maxZoom: number;
      metadata: Record<string, unknown>;
    };
    expect(options.mapStyle).toBe('http://127.0.0.1:8080/r1.json');
    expect(options.bounds).toEqual([-72, 46, -71, 47]); // [west, south, east, north]
    expect(options.metadata).toMatchObject({ appId: 'r1', label: 'Home range', basemap: 'map' });

    emitProgress({ id: 'native-1' }, { percentage: 40, completedTileSize: 1_000 });
    emitProgress({ id: 'native-1' }, { percentage: 100, completedTileSize: 4_000 });
    await pending;

    expect(onProgress).toHaveBeenCalledWith(40, 1_000);
    expect(onProgress).toHaveBeenCalledWith(100, 4_000);
    // A completed pack keeps its style file (its bookkeeping stays stable) …
    expect(fsMock.__has('/doc/offline-styles/r1.json')).toBe(true);
    expect(OfflineManager.deletePack).not.toHaveBeenCalled();
    // … but the transient loopback server is torn down.
    expect(lastServer()?.stop).toHaveBeenCalled();
  });

  it('rejects via the stall watchdog when progress stops, and deletes the partial pack', async () => {
    jest.useFakeTimers();
    mockCreatePack();
    const pending = createRegionPack(packArgs, jest.fn());
    let rejected = false;
    pending.catch(() => {
      rejected = true;
    });
    await flushMicrotasks();

    // A progress event 80 s in re-arms the watchdog …
    await jest.advanceTimersByTimeAsync(80_000);
    emitProgress({ id: 'native-1' }, { percentage: 10, completedTileSize: 100 });
    await jest.advanceTimersByTimeAsync(89_000);
    expect(rejected).toBe(false);

    // … but 90 s of silence rejects, naming the zoom range that stalled.
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(pending).rejects.toThrow('no tiles arrived for 90 s at z10–z14');

    // The partially-created native pack and its orphaned style file are removed.
    expect(OfflineManager.deletePack).toHaveBeenCalledWith('native-1');
    expect(fsMock.__has('/doc/offline-styles/r1.json')).toBe(false);
    expect(lastServer()?.stop).toHaveBeenCalled();
  });

  it('rejects when the native downloader reports an error, and cleans up', async () => {
    mockCreatePack();
    const pending = createRegionPack(packArgs, jest.fn());
    await flushMicrotasks();

    emitError({ id: 'native-1' }, { message: 'connection lost' });
    // The reason survives, with the zoom range that failed appended.
    await expect(pending).rejects.toThrow('connection lost');

    expect(OfflineManager.deletePack).toHaveBeenCalledWith('native-1');
    expect(fsMock.__has('/doc/offline-styles/r1.json')).toBe(false);
    expect(lastServer()?.stop).toHaveBeenCalled();
  });

  it('gives an empty native error a specific reason', async () => {
    mockCreatePack();
    const pending = createRegionPack(packArgs, jest.fn());
    await flushMicrotasks();

    emitError({ id: 'native-1' }, { message: '' });
    await expect(pending).rejects.toThrow('the tile server rejected the request (z10–z14)');
  });

  it('clamps the pack to the basemap native max zoom (relief tops out at z15)', async () => {
    mockCreatePack();
    const pending = createRegionPack(
      { ...packArgs, id: 'r2', basemap: 'relief', minZoom: 11, maxZoom: 17 },
      jest.fn(),
    );
    await flushMicrotasks();

    const options = (OfflineManager.createPack as jest.Mock).mock.calls[0]?.[0] as {
      minZoom: number;
      maxZoom: number;
      metadata: Record<string, unknown>;
    };
    // Requesting z16/z17 from a source that only serves z15 is what made the
    // relief layer fail to download.
    expect(options.minZoom).toBe(11);
    expect(options.maxZoom).toBe(15);
    // The metadata records what the pack REALLY holds, so the live map overzooms
    // from z15 instead of asking for tiles that were never stored.
    expect(options.metadata).toMatchObject({ basemap: 'relief', maxZoom: 15 });

    emitProgress({ id: 'native-1' }, { percentage: 100, completedTileSize: 10 });
    await pending;
  });
});

describe('setOfflineOnly', () => {
  it('flips both the native network gate and the storage fetch gate', () => {
    setOfflineOnly(true);
    expect(NetworkManager.setConnected).toHaveBeenCalledWith(false);
    expect(storage.setNetworkAllowed).toHaveBeenCalledWith(false);

    setOfflineOnly(false);
    expect(NetworkManager.setConnected).toHaveBeenLastCalledWith(true);
    expect(storage.setNetworkAllowed).toHaveBeenLastCalledWith(true);
  });
});

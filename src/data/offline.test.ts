import { NetworkManager, OfflineManager } from '@maplibre/maplibre-react-native';

import {
  createRegionPack,
  listRegionPacks,
  OfflineConnectivityError,
  readPackStyleTemplates,
  replaceRegionPack,
  setOfflineOnly,
} from './offline';
import * as storage from './storage';

jest.mock('./storage', () => ({
  setNetworkAllowed: jest.fn(),
  documentDirUri: () => 'file:///doc/',
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
    async text(): Promise<string> {
      return files.get(this.path) ?? '';
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

// The app has ONE loopback server (./localServer), constructed on the first
// download and reused after — so this is the same object in every test, and
// the assertions below read its per-test call counts.
function lastServer(): { start: jest.Mock; stop: jest.Mock } | undefined {
  return serverMock.__instances[serverMock.__instances.length - 1];
}

beforeEach(() => {
  fsMock.__reset();
  for (const s of serverMock.__instances) {
    s.start.mockClear();
    s.stop.mockClear();
  }
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
    expect(options.mapStyle).toBe('http://127.0.0.1:8080/offline-styles/r1.json');
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
    // A stall is connectivity: told to the user, never reported as an app error.
    await expect(pending).rejects.toBeInstanceOf(OfflineConnectivityError);

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

  it.each([
    'Error Domain=MLNErrorDomain Code=3 "The Internet connection appears to be offline."',
    'Error Domain=MLNErrorDomain Code=3 "The request timed out."',
    'Error Domain=MLNErrorDomain Code=3 "Could not connect to the server."',
  ])('classes a connectivity failure as such: %s', async (message) => {
    mockCreatePack();
    const pending = createRegionPack(packArgs, jest.fn());
    await flushMicrotasks();
    emitError({ id: 'native-1' }, { message });
    await expect(pending).rejects.toBeInstanceOf(OfflineConnectivityError);
    await expect(pending).rejects.toThrow(/^network error at z10–z14/);
  });

  it.each(['Error Domain=MLNErrorDomain Code=2 "HTTP status code 503"', 'cannot parse response'])(
    'keeps a server or data failure an ordinary error: %s',
    async (message) => {
      mockCreatePack();
      const pending = createRegionPack(packArgs, jest.fn());
      await flushMicrotasks();
      emitError({ id: 'native-1' }, { message });
      await expect(pending).rejects.not.toBeInstanceOf(OfflineConnectivityError);
    },
  );

  it('gives an empty native error a specific reason', async () => {
    mockCreatePack();
    const pending = createRegionPack(packArgs, jest.fn());
    await flushMicrotasks();

    emitError({ id: 'native-1' }, { message: '' });
    await expect(pending).rejects.toThrow('the tile server rejected the request (z10–z14)');
  });

  it('clamps the pack to the basemap native max zoom (satellite tops out at z17)', async () => {
    mockCreatePack();
    const pending = createRegionPack(
      { ...packArgs, id: 'r2', basemap: 'satellite', minZoom: 11, maxZoom: 19 },
      jest.fn(),
    );
    await flushMicrotasks();

    const options = (OfflineManager.createPack as jest.Mock).mock.calls[0]?.[0] as {
      minZoom: number;
      maxZoom: number;
      metadata: Record<string, unknown>;
    };
    // Requesting zooms past what the source serves is what made the (since
    // retired) relief layer fail to download.
    expect(options.minZoom).toBe(11);
    expect(options.maxZoom).toBe(17);
    // The metadata records what the pack REALLY holds, so the live map overzooms
    // from z17 instead of asking for tiles that were never stored.
    expect(options.metadata).toMatchObject({ basemap: 'satellite', maxZoom: 17 });

    emitProgress({ id: 'native-1' }, { percentage: 100, completedTileSize: 10 });
    await pending;
  });
});

describe('pack format', () => {
  it('records a vector map pack and clamps it to the vector max zoom', async () => {
    mockCreatePack();
    const pending = createRegionPack({ ...packArgs, format: 'vector', maxZoom: 17 }, jest.fn());
    await flushMicrotasks();
    const options = (OfflineManager.createPack as jest.Mock).mock.calls.at(-1)?.[0] as {
      maxZoom: number;
      metadata: Record<string, unknown>;
    };
    expect(options.maxZoom).toBe(15);
    expect(options.metadata).toMatchObject({ format: 'vector', maxZoom: 15 });
    emitProgress({ id: 'native-1' }, { percentage: 100, completedTileSize: 10 });
    await pending;
  });

  it('defaults to raster, and reads packs without a format as raster', async () => {
    mockCreatePack();
    const pending = createRegionPack(packArgs, jest.fn());
    await flushMicrotasks();
    const options = (OfflineManager.createPack as jest.Mock).mock.calls.at(-1)?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(options.metadata).toMatchObject({ format: 'raster' });
    emitProgress({ id: 'native-1' }, { percentage: 100, completedTileSize: 10 });
    await pending;

    const legacy = {
      id: 'native-old',
      bounds: [-72, 46, -71, 47],
      metadata: { appId: 'old', label: 'Before vector', basemap: 'map' },
      status: jest.fn(async () => ({
        percentage: 100,
        completedTileSize: 5,
        completedResourceSize: 5,
      })),
    };
    (OfflineManager.getPacks as jest.Mock).mockResolvedValueOnce([legacy]);
    const [region] = await listRegionPacks();
    expect(region?.format).toBe('raster');
  });

  it('still lists a relief pack from before #484, and reads junk as map', async () => {
    const pack = (appId: string, basemap: unknown) => ({
      id: `native-${appId}`,
      bounds: [-72, 46, -71, 47],
      metadata: { appId, label: appId, basemap },
      status: jest.fn(async () => ({
        percentage: 100,
        completedTileSize: 5,
        completedResourceSize: 5,
      })),
    });
    (OfflineManager.getPacks as jest.Mock).mockResolvedValueOnce([
      pack('old-relief', 'relief'),
      pack('junk', 'terrain'),
    ]);
    const regions = await listRegionPacks();
    expect(regions.map((r) => r.basemap)).toEqual(['relief', 'map']);
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

describe('tile URL templates (P1-2)', () => {
  const TILES = 'https://tiles.example/basemap/{z}/{x}/{y}.mvt?v=1';
  const styled = {
    ...packArgs,
    styleJSON: JSON.stringify({
      version: 8,
      glyphs: 'https://tiles.example/fonts/{fontstack}/{range}.pbf',
      sources: { base: { type: 'vector', tiles: [TILES] } },
      layers: [],
    }),
  };
  const templates = {
    glyphs: 'https://tiles.example/fonts/{fontstack}/{range}.pbf',
    'source:base': TILES,
  };

  beforeEach(() => {
    (OfflineManager.createPack as jest.Mock).mockClear();
    (OfflineManager.deletePack as jest.Mock).mockClear();
  });

  it('records the templates a pack is built with in its metadata', async () => {
    mockCreatePack();
    const pending = createRegionPack(styled, jest.fn());
    await flushMicrotasks();
    const options = (OfflineManager.createPack as jest.Mock).mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(options.metadata.urls).toEqual(templates);
    emitProgress({ id: 'native-1' }, { percentage: 100, completedTileSize: 1 });
    await pending;
  });

  it('lists the native id and the recorded templates, and ignores a malformed record', async () => {
    const pack = (appId: string, urls: unknown) => ({
      id: `native-${appId}`,
      bounds: [-72, 46, -71, 47],
      metadata: { appId, label: appId, basemap: 'map', format: 'vector', urls },
      status: jest.fn(async () => ({
        percentage: 100,
        completedTileSize: 5,
        completedResourceSize: 5,
      })),
    });
    (OfflineManager.getPacks as jest.Mock).mockResolvedValueOnce([
      pack('a', templates),
      pack('b', { glyphs: 7 }),
      pack('c', undefined),
    ]);
    const regions = await listRegionPacks();
    expect(regions.map((r) => r.packId)).toEqual(['native-a', 'native-b', 'native-c']);
    expect(regions.map((r) => r.urls)).toEqual([templates, undefined, undefined]);
  });

  it('replaces a pack: the old one goes only once the new one is complete', async () => {
    mockCreatePack();
    const pending = replaceRegionPack('native-old', styled, jest.fn());
    await flushMicrotasks();
    expect(OfflineManager.deletePack).not.toHaveBeenCalled();
    emitProgress({ id: 'native-1' }, { percentage: 100, completedTileSize: 1 });
    await pending;
    expect(OfflineManager.deletePack).toHaveBeenCalledTimes(1);
    expect(OfflineManager.deletePack).toHaveBeenCalledWith('native-old');
  });

  it('keeps the old pack and its style file when the replacement fails', async () => {
    mockCreatePack();
    const pending = replaceRegionPack('native-old', styled, jest.fn());
    await flushMicrotasks();
    emitError({ id: 'native-1' }, { message: 'boom' });
    await expect(pending).rejects.toThrow('boom');
    expect(OfflineManager.deletePack).toHaveBeenCalledWith('native-1'); // the partial new one
    expect(OfflineManager.deletePack).not.toHaveBeenCalledWith('native-old');
    expect(fsMock.__has('/doc/offline-styles/r1.json')).toBe(true);
  });

  it("reads a legacy pack's templates from its saved style, or null without one", async () => {
    mockCreatePack();
    const pending = createRegionPack(styled, jest.fn());
    await flushMicrotasks();
    emitProgress({ id: 'native-1' }, { percentage: 100, completedTileSize: 1 });
    await pending;
    expect(await readPackStyleTemplates('r1')).toEqual(templates);
    expect(await readPackStyleTemplates('nope')).toBeNull();
  });
});

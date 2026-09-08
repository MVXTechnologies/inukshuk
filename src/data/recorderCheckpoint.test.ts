import * as storage from '@data/storage';

import {
  acknowledgeBackgroundPoints,
  appendBackgroundPoints,
  CHECKPOINT_EVERY_MS,
  CHECKPOINT_EVERY_N_POINTS,
  clearBackgroundPoints,
  clearCheckpoint,
  maybeWriteCheckpoint,
  readBackgroundPoints,
  readCheckpoint,
  writeCheckpoint,
  type RecorderCheckpoint,
} from './recorderCheckpoint';

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

// clearCheckpoint touches the filesystem directly (it must remove the .tmp
// staging file too); fake just the File existence surface it uses.
jest.mock('expo-file-system', () => {
  const files = new Set<string>();
  type MockPathLike = string | { path: string };
  class File {
    readonly path: string;
    constructor(...parts: MockPathLike[]) {
      this.path = parts.map((p) => (typeof p === 'string' ? p : p.path)).join('/');
    }
    get exists(): boolean {
      return files.has(this.path);
    }
    delete(): void {
      files.delete(this.path);
    }
  }
  return { File, Paths: { document: '/doc' }, __files: files };
});

const fsMock = jest.requireMock('expo-file-system') as { __files: Set<string> };

const cp: RecorderCheckpoint = {
  status: 'recording',
  name: 'Morning hike',
  startedAt: 1,
  pausedMs: 0,
  points: [{ latitude: 46.8, longitude: -71.2, time: 1_000 }],
  waypoints: [],
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_000);
  fsMock.__files.clear();
  clearCheckpoint(); // reset the module's throttle counters between tests
});

afterEach(() => {
  jest.useRealTimers();
});

describe('write throttling', () => {
  it('persists on the Nth point when the time cadence has not elapsed', () => {
    for (let i = 0; i < CHECKPOINT_EVERY_N_POINTS - 1; i++) maybeWriteCheckpoint(cp);
    expect(storage.writeJson).not.toHaveBeenCalled();

    maybeWriteCheckpoint(cp);
    expect(storage.writeJson).toHaveBeenCalledTimes(1);
    expect(storage.writeJson).toHaveBeenCalledWith('recorder-checkpoint.json', cp);
  });

  it('persists on the time cadence even with few points', () => {
    writeCheckpoint(cp); // arms lastWriteAt at t=1000
    (storage.writeJson as jest.Mock).mockClear();

    jest.setSystemTime(1_000 + CHECKPOINT_EVERY_MS - 1);
    maybeWriteCheckpoint(cp);
    expect(storage.writeJson).not.toHaveBeenCalled();

    jest.setSystemTime(1_000 + CHECKPOINT_EVERY_MS);
    maybeWriteCheckpoint(cp);
    expect(storage.writeJson).toHaveBeenCalledTimes(1);
  });

  it('a successful write resets the point counter', () => {
    for (let i = 0; i < CHECKPOINT_EVERY_N_POINTS; i++) maybeWriteCheckpoint(cp);
    expect(storage.writeJson).toHaveBeenCalledTimes(1);

    for (let i = 0; i < CHECKPOINT_EVERY_N_POINTS - 1; i++) maybeWriteCheckpoint(cp);
    expect(storage.writeJson).toHaveBeenCalledTimes(1);

    maybeWriteCheckpoint(cp);
    expect(storage.writeJson).toHaveBeenCalledTimes(2);
  });
});

describe('failure handling', () => {
  it('reports whether the checkpoint is durably written', () => {
    jest.mocked(storage.writeJson).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(writeCheckpoint(cp)).toBe(false);
    expect(writeCheckpoint(cp)).toBe(true);
  });
  it('swallows write errors and retries on the next point', () => {
    (storage.writeJson as jest.Mock).mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => writeCheckpoint(cp)).not.toThrow();

    // The failed write did not reset the cadence: the counter keeps growing …
    for (let i = 0; i < CHECKPOINT_EVERY_N_POINTS; i++) {
      expect(() => maybeWriteCheckpoint(cp)).not.toThrow();
    }
    // … so once the disk recovers, the very next point persists a snapshot.
    (storage.writeJson as jest.Mock).mockClear();
    (storage.writeJson as jest.Mock).mockImplementation(() => undefined);
    maybeWriteCheckpoint(cp);
    expect(storage.writeJson).toHaveBeenCalledTimes(1);
  });

  it('readCheckpoint returns the stored snapshot', async () => {
    (storage.readJson as jest.Mock).mockResolvedValue(cp);
    await expect(readCheckpoint()).resolves.toEqual(cp);
    expect(storage.readJson).toHaveBeenCalledWith('recorder-checkpoint.json');
  });

  it('readCheckpoint returns null when the read throws', async () => {
    (storage.readJson as jest.Mock).mockRejectedValue(new Error('unreadable'));
    await expect(readCheckpoint()).resolves.toBeNull();
  });
});

describe('clearCheckpoint', () => {
  it('removes both the checkpoint file and its .tmp staging file', () => {
    // A stale .tmp would otherwise be resurrected by readJson's crash recovery.
    fsMock.__files.add('/doc/recorder-checkpoint.json');
    fsMock.__files.add('/doc/recorder-checkpoint.json.tmp');

    clearCheckpoint();
    expect(fsMock.__files.has('/doc/recorder-checkpoint.json')).toBe(false);
    expect(fsMock.__files.has('/doc/recorder-checkpoint.json.tmp')).toBe(false);
  });

  it('resets the write cadence', () => {
    for (let i = 0; i < CHECKPOINT_EVERY_N_POINTS - 1; i++) maybeWriteCheckpoint(cp);
    clearCheckpoint();

    maybeWriteCheckpoint(cp); // 1 point since the reset — no write yet
    expect(storage.writeJson).not.toHaveBeenCalled();
  });
});

describe('background points journal', () => {
  const p = (time: number) => ({ latitude: 46.8, longitude: -71.2, time });

  it('preserves both batches when initial appends overlap', async () => {
    let finish!: (points: unknown) => void;
    jest.mocked(storage.readJson).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = appendBackgroundPoints([p(2)]);
    const second = appendBackgroundPoints([p(3)]);
    finish([p(1)]);
    await Promise.all([first, second]);
    await expect(readBackgroundPoints()).resolves.toEqual([p(1), p(2), p(3)]);
  });

  it('does not resurrect an old append after the session journal is cleared', async () => {
    let finish!: (points: unknown) => void;
    jest.mocked(storage.readJson).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = appendBackgroundPoints([p(2)]);
    clearBackgroundPoints();
    finish([p(1)]);
    await pending;
    await expect(readBackgroundPoints()).resolves.toEqual([]);
  });

  it('acknowledges only the merged snapshot, retaining later fixes', async () => {
    await appendBackgroundPoints([p(1)]);
    const snapshot = await readBackgroundPoints();
    await appendBackgroundPoints([p(2)]);
    acknowledgeBackgroundPoints(snapshot);
    await expect(readBackgroundPoints()).resolves.toEqual([p(2)]);
  });

  it('retains the whole journal when acknowledgement persistence fails', async () => {
    await appendBackgroundPoints([p(1)]);
    const snapshot = await readBackgroundPoints();
    await appendBackgroundPoints([p(2)]);
    jest.mocked(storage.writeJson).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    acknowledgeBackgroundPoints(snapshot);
    await expect(readBackgroundPoints()).resolves.toEqual([p(1), p(2)]);
  });

  it('flushes the very first append immediately, then throttles by point count', async () => {
    await appendBackgroundPoints([p(1)]);
    expect(storage.writeJson).toHaveBeenCalledTimes(1);
    expect(storage.writeJson).toHaveBeenCalledWith('recorder-bgpoints.json', [p(1)]);

    (storage.writeJson as jest.Mock).mockClear();
    for (let t = 2; t <= CHECKPOINT_EVERY_N_POINTS; t++) await appendBackgroundPoints([p(t)]);
    expect(storage.writeJson).not.toHaveBeenCalled(); // N-1 pending — below the cadence

    await appendBackgroundPoints([p(CHECKPOINT_EVERY_N_POINTS + 1)]); // Nth pending point
    expect(storage.writeJson).toHaveBeenCalledTimes(1);
    const written = (storage.writeJson as jest.Mock).mock.calls[0]?.[1] as { time: number }[];
    expect(written).toHaveLength(CHECKPOINT_EVERY_N_POINTS + 1); // full journal, not just the tail
  });

  it('flushes on the time cadence even with few pending points', async () => {
    await appendBackgroundPoints([p(1)]); // immediate first flush at t=1000
    (storage.writeJson as jest.Mock).mockClear();

    jest.setSystemTime(1_000 + CHECKPOINT_EVERY_MS - 1);
    await appendBackgroundPoints([p(2)]);
    expect(storage.writeJson).not.toHaveBeenCalled();

    jest.setSystemTime(1_000 + CHECKPOINT_EVERY_MS);
    await appendBackgroundPoints([p(3)]);
    expect(storage.writeJson).toHaveBeenCalledTimes(1);
  });

  it('readBackgroundPoints includes the unflushed in-memory tail', async () => {
    await appendBackgroundPoints([p(1)]); // flushed
    await appendBackgroundPoints([p(2)]); // still pending
    await expect(readBackgroundPoints()).resolves.toEqual([p(1), p(2)]);
  });

  it('reads the journal from disk in a fresh JS context, dropping junk entries', async () => {
    (storage.readJson as jest.Mock).mockResolvedValue([
      p(1),
      { latitude: 'oops', longitude: -71.2, time: 2 }, // corrupt entry
      null,
      p(3),
    ]);
    await expect(readBackgroundPoints()).resolves.toEqual([p(1), p(3)]);
  });

  it('returns [] when the journal file is unreadable', async () => {
    (storage.readJson as jest.Mock).mockRejectedValue(new Error('unreadable'));
    await expect(readBackgroundPoints()).resolves.toEqual([]);
  });

  it('appendBackgroundPoints swallows write errors', async () => {
    (storage.writeJson as jest.Mock).mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(appendBackgroundPoints([p(1)])).resolves.toBeUndefined();
  });

  it('clearBackgroundPoints removes the journal file, its .tmp, and the buffer', async () => {
    // Earlier tests leave throwing/rejecting implementations behind — restore.
    (storage.writeJson as jest.Mock).mockImplementation(() => undefined);
    (storage.readJson as jest.Mock).mockImplementation(async () => null);
    await appendBackgroundPoints([p(1)]);
    fsMock.__files.add('/doc/recorder-bgpoints.json');
    fsMock.__files.add('/doc/recorder-bgpoints.json.tmp');

    clearBackgroundPoints();
    expect(fsMock.__files.has('/doc/recorder-bgpoints.json')).toBe(false);
    expect(fsMock.__files.has('/doc/recorder-bgpoints.json.tmp')).toBe(false);
    await expect(readBackgroundPoints()).resolves.toEqual([]);
  });

  it('clearCheckpoint clears the background journal too (same session)', async () => {
    (storage.writeJson as jest.Mock).mockImplementation(() => undefined);
    (storage.readJson as jest.Mock).mockImplementation(async () => null);
    await appendBackgroundPoints([p(1)]);
    clearCheckpoint();
    await expect(readBackgroundPoints()).resolves.toEqual([]);
  });
});

// --- #247: the checkpoint's one stored path ---------------------------------
//
// A live waypoint's photo is the only file path a checkpoint carries. A
// recording interrupted by the app update that rotates iOS's container UUID is
// recovered on the next launch — with dead photo paths, unless the checkpoint
// stores them document-relative and resolves them on the way back.

describe('waypoint photo paths', () => {
  const OLD_CONTAINER =
    'file:///var/mobile/Containers/Data/Application/AAAA-1111-2222-3333/Documents';

  const withPhoto = (photoUri: string): RecorderCheckpoint => ({
    ...cp,
    waypoints: [
      { id: 'w1', latitude: 46.8, longitude: -71.2, distanceM: 12, label: 'Spring', photoUri },
      { id: 'w2', latitude: 46.9, longitude: -71.3, distanceM: 40, label: 'Fork' },
    ],
  });

  it('persists a photo path document-relative, never absolute', () => {
    writeCheckpoint(withPhoto('file:///doc/photos/p1.jpg'));

    const written = (storage.writeJson as jest.Mock).mock.calls[0]?.[1] as RecorderCheckpoint;
    expect(written.waypoints[0]?.photoUri).toBe('photos/p1.jpg');
    // A waypoint with no photo gains no photoUri key.
    expect(written.waypoints[1]).not.toHaveProperty('photoUri');
    expect(JSON.stringify(written)).not.toContain('file://');
  });

  it('resolves a stored path back to the current container on read', async () => {
    (storage.readJson as jest.Mock).mockResolvedValueOnce(withPhoto('photos/p1.jpg'));
    const restored = await readCheckpoint();
    expect(restored?.waypoints[0]?.photoUri).toBe('file:///doc/photos/p1.jpg');
  });

  it('heals a checkpoint left absolute under a container iOS has rotated away', async () => {
    (storage.readJson as jest.Mock).mockResolvedValueOnce(
      withPhoto(`${OLD_CONTAINER}/photos/p1.jpg`),
    );
    const restored = await readCheckpoint();
    expect(restored?.waypoints[0]?.photoUri).toBe('file:///doc/photos/p1.jpg');
  });

  it('round-trips a photo path unchanged', async () => {
    const absolute = 'file:///doc/photos/p1.jpg';
    writeCheckpoint(withPhoto(absolute));
    const written = (storage.writeJson as jest.Mock).mock.calls[0]?.[1] as RecorderCheckpoint;

    (storage.readJson as jest.Mock).mockResolvedValueOnce(written);
    const restored = await readCheckpoint();
    expect(restored?.waypoints[0]?.photoUri).toBe(absolute);
  });
});

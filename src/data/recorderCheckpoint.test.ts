import * as storage from '@data/storage';

import {
  CHECKPOINT_EVERY_MS,
  CHECKPOINT_EVERY_N_POINTS,
  clearCheckpoint,
  maybeWriteCheckpoint,
  readCheckpoint,
  writeCheckpoint,
  type RecorderCheckpoint,
} from './recorderCheckpoint';

jest.mock('@data/storage', () => ({
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

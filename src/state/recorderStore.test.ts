import type { TrackPoint } from '@core/models';
import * as checkpoint from '@data/recorderCheckpoint';
import {
  initRecorderRecovery,
  resetRecorderRecoveryForTests,
  useRecorderStore,
} from './recorderStore';

jest.mock('@data/storage', () => ({
  newId: () => 'id_' + Math.random().toString(36).slice(2, 8),
  deleteFileAt: jest.fn(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
  writeTrackGpx: jest.fn(() => 'file://tracks/test.gpx'),
}));

// In-memory checkpoint journal: the store's persistence boundary, mocked so the
// checkpoint→restore round-trip is testable without a filesystem. The throttled
// writer persists unconditionally here (throttling itself is the data module's
// concern, not the store's).
jest.mock('@data/recorderCheckpoint', () => {
  let stored: unknown = null;
  return {
    writeCheckpoint: jest.fn((cp: unknown) => {
      stored = cp;
    }),
    maybeWriteCheckpoint: jest.fn((cp: unknown) => {
      stored = cp;
    }),
    readCheckpoint: jest.fn(async () => stored),
    clearCheckpoint: jest.fn(() => {
      stored = null;
    }),
  };
});

const pt = (over: Partial<TrackPoint> = {}): TrackPoint => ({
  latitude: 46.8,
  longitude: -71.2,
  time: 1_000_000,
  accuracy: 8,
  ...over,
});

/** Simulate process death: wipe the in-memory store, keep the journal file. */
function simulateCrash() {
  useRecorderStore.setState({
    status: 'idle',
    name: '',
    startedAt: null,
    pausedMs: 0,
    pausedAt: null,
    points: [],
    stats: {
      distanceM: 0,
      ascentM: 0,
      descentM: 0,
      durationS: 0,
      movingTimeS: 0,
      avgSpeedMps: 0,
      maxSpeedMps: 0,
      pointCount: 0,
    },
    waypoints: [],
  });
  resetRecorderRecoveryForTests();
}

beforeEach(() => {
  useRecorderStore.getState().discard(); // resets state AND clears the mock journal
  resetRecorderRecoveryForTests();
});

describe('GPS fix gating in addPoint', () => {
  it('appends normal fixes and rejects bad-accuracy / teleport outliers', () => {
    const s = useRecorderStore.getState();
    s.start('Gated');
    s.addPoint(pt({ time: 1_000_000 }));
    s.addPoint(pt({ time: 1_002_000, latitude: 46.800025 })); // walking pace
    s.addPoint(pt({ time: 1_002_100, latitude: 46.800025 })); // duplicate delivery (<250 ms after prev)
    s.addPoint(pt({ time: 1_004_000, latitude: 46.80005, accuracy: 120 })); // parking-lot fix
    s.addPoint(pt({ time: 1_006_000, latitude: 46.9 })); // ~11 km teleport
    expect(useRecorderStore.getState().points).toHaveLength(2);
  });

  it('accepts fixes without accuracy', () => {
    const s = useRecorderStore.getState();
    s.start();
    s.addPoint({ latitude: 46.8, longitude: -71.2, time: 1_000_000 });
    expect(useRecorderStore.getState().points).toHaveLength(1);
  });
});

describe('checkpoint + recovery round-trip', () => {
  it('restores an interrupted recording as paused, with points and waypoints', async () => {
    const s = useRecorderStore.getState();
    s.start('Crashy hike');
    s.addPoint(pt({ time: 1_000_000 }));
    s.addPoint(pt({ time: 1_002_000, latitude: 46.800025 }));
    useRecorderStore.getState().addWaypoint();

    simulateCrash();
    expect(useRecorderStore.getState().status).toBe('idle');

    const recovered = await initRecorderRecovery();
    expect(recovered).toBe(true);

    const after = useRecorderStore.getState();
    expect(after.status).toBe('paused'); // never auto-'recording'
    expect(after.name).toBe('Crashy hike');
    expect(after.points).toHaveLength(2);
    expect(after.waypoints).toHaveLength(1);
    expect(after.waypoints[0]?.label).toBe('Waypoint 1');
    expect(after.startedAt).not.toBeNull();
    // Stats are recomputed from the restored points, not trusted from disk.
    expect(after.stats.pointCount).toBe(2);
    expect(after.stats.distanceM).toBeGreaterThan(0);
  });

  it('recovery is one-shot and reports false when nothing was recovered', async () => {
    expect(await initRecorderRecovery()).toBe(false);
    expect(useRecorderStore.getState().status).toBe('idle');
  });

  it('ignores a checkpoint with no points', async () => {
    useRecorderStore.getState().start('Empty');
    // start() checkpoints nothing (no points yet) — pause() force-writes one.
    useRecorderStore.getState().pause();
    simulateCrash();
    expect(await initRecorderRecovery()).toBe(false);
    expect(useRecorderStore.getState().status).toBe('idle');
  });

  it('does not clobber a session that is already live', async () => {
    const s = useRecorderStore.getState();
    s.start('First');
    s.addPoint(pt());
    simulateCrash();
    useRecorderStore.getState().start('Second');
    expect(await initRecorderRecovery()).toBe(false);
    expect(useRecorderStore.getState().name).toBe('Second');
  });
});

describe('checkpoint lifecycle', () => {
  it('stop() clears the checkpoint after a successful save', async () => {
    const s = useRecorderStore.getState();
    s.start('Done hike');
    s.addPoint(pt({ time: 1_000_000 }));
    s.addPoint(pt({ time: 1_002_000, latitude: 46.800025 }));
    const track = await useRecorderStore.getState().stop();
    expect(track).not.toBeNull();
    expect(checkpoint.clearCheckpoint).toHaveBeenCalled();

    simulateCrash();
    expect(await initRecorderRecovery()).toBe(false);
  });

  it('discard() clears the checkpoint', async () => {
    const s = useRecorderStore.getState();
    s.start('Oops');
    s.addPoint(pt());
    useRecorderStore.getState().discard();

    simulateCrash();
    expect(await initRecorderRecovery()).toBe(false);
  });

  it('pause() force-writes a checkpoint with folded pause time', () => {
    const s = useRecorderStore.getState();
    s.start('Pausy');
    s.addPoint(pt());
    (checkpoint.writeCheckpoint as jest.Mock).mockClear();
    useRecorderStore.getState().pause();
    expect(checkpoint.writeCheckpoint).toHaveBeenCalledTimes(1);
    const cp = (checkpoint.writeCheckpoint as jest.Mock).mock
      .calls[0]?.[0] as checkpoint.RecorderCheckpoint;
    expect(cp.status).toBe('paused');
    expect(cp.points).toHaveLength(1);
  });
});

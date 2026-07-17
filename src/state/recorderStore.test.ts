import type { TrackPoint } from '@core/models';
import * as checkpoint from '@data/recorderCheckpoint';
import { useLibraryStore } from './libraryStore';
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
// concern, not the store's). The background points journal mirrors the real
// module's contract: clearCheckpoint drops it too (same session).
jest.mock('@data/recorderCheckpoint', () => {
  let stored: unknown = null;
  let bgStored: unknown[] = [];
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
      bgStored = [];
    }),
    appendBackgroundPoints: jest.fn(async (points: unknown[]) => {
      bgStored.push(...points);
    }),
    readBackgroundPoints: jest.fn(async () => bgStored.slice()),
    clearBackgroundPoints: jest.fn(() => {
      bgStored = [];
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
    category: null,
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

  it('tracks the last ACCEPTED fix time/accuracy for the GPS-quality HUD', () => {
    const s = useRecorderStore.getState();
    s.start('Freshness');
    expect(useRecorderStore.getState().lastFixAt).toBeNull();

    s.addPoint(pt({ time: 1_000_000, accuracy: 8 }));
    expect(useRecorderStore.getState().lastFixAt).toBe(1_000_000);
    expect(useRecorderStore.getState().lastAccuracyM).toBe(8);

    // A REJECTED fix (teleport) must not advance freshness — that's exactly the
    // stall the HUD needs to surface.
    s.addPoint(pt({ time: 1_002_000, latitude: 46.9 }));
    expect(useRecorderStore.getState().lastFixAt).toBe(1_000_000);

    // An accepted fix without accuracy records null accuracy.
    s.addPoint({ latitude: 46.800025, longitude: -71.2, time: 1_002_000 });
    expect(useRecorderStore.getState().lastFixAt).toBe(1_002_000);
    expect(useRecorderStore.getState().lastAccuracyM).toBeNull();
  });

  it('resets fix freshness on start', () => {
    const s = useRecorderStore.getState();
    s.start('First');
    s.addPoint(pt({ time: 1_000_000 }));
    expect(useRecorderStore.getState().lastFixAt).toBe(1_000_000);
    s.start('Second');
    expect(useRecorderStore.getState().lastFixAt).toBeNull();
    expect(useRecorderStore.getState().lastAccuracyM).toBeNull();
  });
});

describe('pause / resume feed gating', () => {
  it('ignores addPoint while paused and accepts again after resume', () => {
    // Regression guard for the auto-pause interplay (#116): once the location
    // watch pauses the recording, arriving fixes must be dropped — and a
    // resume must restore the feed with no residue from the pause.
    const s = useRecorderStore.getState();
    s.start('Pausable');
    s.addPoint(pt({ time: 1_000_000 }));

    useRecorderStore.getState().pause();
    useRecorderStore.getState().addPoint(pt({ time: 1_002_000, latitude: 46.800025 }));
    expect(useRecorderStore.getState().points).toHaveLength(1);

    useRecorderStore.getState().resume();
    useRecorderStore.getState().addPoint(pt({ time: 1_004_000, latitude: 46.80005 }));
    const after = useRecorderStore.getState();
    expect(after.status).toBe('recording');
    expect(after.points.map((p) => p.time)).toEqual([1_000_000, 1_004_000]);
  });

  it('pause and resume are no-ops in the wrong state (double auto-pause is safe)', () => {
    const s = useRecorderStore.getState();
    s.resume(); // idle — nothing to resume
    expect(useRecorderStore.getState().status).toBe('idle');

    s.start('Steady');
    useRecorderStore.getState().pause();
    useRecorderStore.getState().pause(); // repeated auto-pause must not corrupt pausedAt
    const paused = useRecorderStore.getState();
    expect(paused.status).toBe('paused');
    expect(paused.pausedAt).not.toBeNull();

    useRecorderStore.getState().resume();
    expect(useRecorderStore.getState().status).toBe('recording');
    expect(useRecorderStore.getState().pausedAt).toBeNull();
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

  it('folds background-journaled points in, deduped by timestamp and sorted', async () => {
    const s = useRecorderStore.getState();
    s.start('Screen-off hike');
    s.addPoint(pt({ time: 1_000_000 }));
    s.addPoint(pt({ time: 1_002_000, latitude: 46.800025 }));
    simulateCrash();

    // Fixes the background task journaled while the JS process was dead: one
    // duplicate delivery of the last checkpointed fix, plus two new ones
    // (delivered out of order).
    await checkpoint.appendBackgroundPoints([
      pt({ time: 1_006_000, latitude: 46.800075 }),
      pt({ time: 1_002_000, latitude: 46.800025 }),
      pt({ time: 1_004_000, latitude: 46.80005 }),
    ]);

    expect(await initRecorderRecovery()).toBe(true);
    const after = useRecorderStore.getState();
    expect(after.points.map((p) => p.time)).toEqual([1_000_000, 1_002_000, 1_004_000, 1_006_000]);
    expect(after.stats.pointCount).toBe(4);
    // The merged session is re-checkpointed and the journal dropped, so a
    // second crash cannot lose the background points.
    expect(checkpoint.writeCheckpoint).toHaveBeenCalled();
    expect(checkpoint.clearBackgroundPoints).toHaveBeenCalled();
  });

  it('background points pass through the GPS filter on recovery', async () => {
    const s = useRecorderStore.getState();
    s.start('Filtered');
    s.addPoint(pt({ time: 1_000_000 }));
    s.addPoint(pt({ time: 1_002_000, latitude: 46.800025 }));
    simulateCrash();

    await checkpoint.appendBackgroundPoints([
      pt({ time: 1_004_000, latitude: 46.9 }), // ~11 km teleport — rejected
      pt({ time: 1_006_000, latitude: 46.80005, accuracy: 120 }), // bad accuracy — rejected
      pt({ time: 1_008_000, latitude: 46.800075 }), // fine
    ]);

    expect(await initRecorderRecovery()).toBe(true);
    expect(useRecorderStore.getState().points.map((p) => p.time)).toEqual([
      1_000_000, 1_002_000, 1_008_000,
    ]);
  });
});

describe('mergeBackgroundPoints (foreground merge)', () => {
  it('folds journaled points into a live session, recomputes stats, checkpoints', () => {
    const s = useRecorderStore.getState();
    s.start('Live merge');
    s.addPoint(pt({ time: 1_000_000 }));
    s.addPoint(pt({ time: 1_002_000, latitude: 46.800025 }));
    (checkpoint.writeCheckpoint as jest.Mock).mockClear();

    useRecorderStore.getState().mergeBackgroundPoints([
      pt({ time: 1_002_000, latitude: 46.800025 }), // duplicate delivery
      pt({ time: 1_004_000, latitude: 46.80005 }),
    ]);

    const after = useRecorderStore.getState();
    expect(after.points.map((p) => p.time)).toEqual([1_000_000, 1_002_000, 1_004_000]);
    expect(after.stats.pointCount).toBe(3);
    expect(checkpoint.writeCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('skips the checkpoint write when nothing new was merged', () => {
    const s = useRecorderStore.getState();
    s.start('No-op merge');
    s.addPoint(pt({ time: 1_000_000 }));
    (checkpoint.writeCheckpoint as jest.Mock).mockClear();

    useRecorderStore.getState().mergeBackgroundPoints([pt({ time: 1_000_000 })]);
    expect(useRecorderStore.getState().points).toHaveLength(1);
    expect(checkpoint.writeCheckpoint).not.toHaveBeenCalled();
  });

  it('is a no-op while idle (recovery owns that case)', () => {
    useRecorderStore.getState().mergeBackgroundPoints([pt({ time: 1_000_000 })]);
    expect(useRecorderStore.getState().points).toHaveLength(0);
    expect(useRecorderStore.getState().status).toBe('idle');
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

describe('lastSavedTrackId (end-of-recording signal for the Strava prompt)', () => {
  it('is set to the saved track id on stop() and consumed by acknowledgeSavedTrack()', async () => {
    const s = useRecorderStore.getState();
    s.start('Pushable hike');
    s.addPoint(pt({ time: 1_000_000 }));
    s.addPoint(pt({ time: 1_002_000, latitude: 46.800025 }));
    const track = await useRecorderStore.getState().stop();
    expect(track).not.toBeNull();
    expect(useRecorderStore.getState().lastSavedTrackId).toBe(track!.id);

    useRecorderStore.getState().acknowledgeSavedTrack();
    expect(useRecorderStore.getState().lastSavedTrackId).toBeNull();
  });

  it('stays null when the recording had no points (nothing was saved)', async () => {
    const s = useRecorderStore.getState();
    s.start('Empty');
    await useRecorderStore.getState().stop();
    expect(useRecorderStore.getState().lastSavedTrackId).toBeNull();
  });
});

describe('activity category threading', () => {
  it('start(name, category) carries the category through stop() into the saved track', async () => {
    const s = useRecorderStore.getState();
    s.start('Categorized', 'trail-run');
    expect(useRecorderStore.getState().category).toBe('trail-run');

    useRecorderStore.getState().addPoint(pt({ time: 1_000_000 }));
    const track = await useRecorderStore.getState().stop();
    expect(track?.category).toBe('trail-run');
    // The library summary carries it too (Library colors trails by category).
    expect(useLibraryStore.getState().tracks.find((t) => t.id === track!.id)?.category).toBe(
      'trail-run',
    );
    // The next session must not inherit it.
    expect(useRecorderStore.getState().category).toBeNull();
  });

  it('a category-less start stays uncategorized (no category key on the track)', async () => {
    const s = useRecorderStore.getState();
    s.start('Plain');
    expect(useRecorderStore.getState().category).toBeNull();
    useRecorderStore.getState().addPoint(pt({ time: 1_000_000 }));
    const track = await useRecorderStore.getState().stop();
    expect(track).not.toBeNull();
    expect(track).not.toHaveProperty('category');
  });

  it('survives the checkpoint → crash → recovery round-trip', async () => {
    const s = useRecorderStore.getState();
    s.start('Crashy ski', 'ski');
    s.addPoint(pt({ time: 1_000_000 }));

    simulateCrash();
    expect(await initRecorderRecovery()).toBe(true);
    expect(useRecorderStore.getState().category).toBe('ski');
  });

  it('recovers an OLD checkpoint (no category field) as uncategorized', async () => {
    // Checkpoints written by builds that predate categories lack the field —
    // recovery must stay compatible and simply restore uncategorized.
    checkpoint.writeCheckpoint({
      status: 'recording',
      name: 'Legacy hike',
      startedAt: 999_000,
      pausedMs: 0,
      points: [pt({ time: 1_000_000 })],
      waypoints: [],
    });
    resetRecorderRecoveryForTests();
    expect(await initRecorderRecovery()).toBe(true);
    expect(useRecorderStore.getState().category).toBeNull();
    expect(useRecorderStore.getState().name).toBe('Legacy hike');
  });
});

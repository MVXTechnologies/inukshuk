import { DEFAULT_GNSS_CONFIG, newProfile } from '@core/gnss/config';
import { gnssSecrets } from '@data/gnss/credentials';
import {
  SIMULATED_RECEIVER_ID,
  SIMULATED_RECEIVER_NAME,
  SimulatedLink,
} from '@data/gnss/simulatedLink';
import { phoneFeedsRecorder, useGnssStore } from '@state/gnssStore';
import { useRecorderStore } from '@state/recorderStore';
import { act } from '@testing-library/react-native';

import { GnssSession, linkErrorMessage } from './session';

jest.mock('@data/storage', () => ({
  newId: () => 'id',
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
  deleteFileAt: jest.fn(),
}));
jest.mock('@data/recorderCheckpoint', () => ({
  clearCheckpoint: jest.fn(),
  maybeWriteCheckpoint: jest.fn(),
}));
jest.mock('@lib/nativeProj', () => ({ nativeEngine: () => null, initNativeProj: jest.fn() }));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

const RECEIVER = {
  id: SIMULATED_RECEIVER_ID,
  name: SIMULATED_RECEIVER_NAME,
  transport: 'fake' as const,
};

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

let link: SimulatedLink;
let session: GnssSession;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(Date.UTC(2026, 9, 7, 12));
  useGnssStore.setState({ hydrated: true, config: { ...DEFAULT_GNSS_CONFIG, receiver: RECEIVER } });
  useGnssStore.getState().resetLive();
  link = new SimulatedLink();
  session = new GnssSession(link);
});

afterEach(() => {
  session.stop();
  useRecorderStore.getState().discard();
  jest.useRealTimers();
});

describe('the receiver session on the simulated Québec City RTK session', () => {
  it('connects, takes over the location, records the receiver’s fixes and reaches RTK fixed', async () => {
    useRecorderStore.getState().start('RTK walk');
    session.start(RECEIVER);
    expect(useGnssStore.getState().link).toBe('connecting');
    await advance(400);
    expect(useGnssStore.getState().link).toBe('connected');
    await advance(3000);
    const s = useGnssStore.getState();
    expect(s.fix?.kind).toBe('autonomous');
    expect(s.use).toBe('external');
    expect(s.phone).toBe('standby');
    expect(phoneFeedsRecorder()).toBe(false);
    expect(s.map).not.toBeNull();
    // The project datum (WGS 84 by default) passes an autonomous fix through.
    expect(s.project?.ok).toBe(true);

    await advance(33_000);
    expect(useGnssStore.getState().status?.state).toBe('fixed');
    expect(useGnssStore.getState().fix?.accuracy?.h95).toBeLessThan(0.05);

    const points = useRecorderStore.getState().points;
    expect(points.length).toBeGreaterThan(1);
    expect(points.every((p) => p.source === 'external')).toBe(true);
    expect(points[points.length - 1]?.gnss?.fix).toBe('rtk-fixed');
    // The distance filter (5 m by default) thins a 1 Hz stream at walking pace.
    expect(points.length).toBeLessThan(15);
  });

  it('falls back to the phone when the receiver goes silent, and back when it returns', async () => {
    session.start(RECEIVER);
    await advance(3400);
    expect(useGnssStore.getState().use).toBe('external');
    await act(async () => {
      await link.disconnect();
    });
    expect(useGnssStore.getState().link).toBe('disconnected');
    await advance(6000);
    expect(useGnssStore.getState().use).toBe('phone');
    expect(useGnssStore.getState().phone).toBe('active');
    expect(phoneFeedsRecorder()).toBe(true);
  });

  it('with fallback off, the receiver stays the source when it drops', async () => {
    useGnssStore.getState().updateConfig({ fallbackToPhone: false });
    session.start(RECEIVER);
    await advance(3400);
    await act(async () => {
      await link.disconnect();
    });
    await advance(10_000);
    expect(useGnssStore.getState().use).toBe('external');
    expect(useGnssStore.getState().status?.freshness).toBe('lost');
  });

  it('stop hands the location back to the phone and keeps the scan results', async () => {
    session.start(RECEIVER);
    await advance(3400);
    useGnssStore.getState().publish({ devices: [] });
    session.stop();
    expect(useGnssStore.getState()).toMatchObject({ use: 'phone', link: 'idle', fix: null });
    // Starting the same receiver twice is one connection.
    session.start(RECEIVER);
    session.start(RECEIVER);
    await advance(400);
    expect(useGnssStore.getState().link).toBe('connected');
  });

  it('streams the active NTRIP profile to the receiver once connected', async () => {
    const profile = { ...newProfile('p1', null), host: 'caster.example', mountpoint: 'SIM_LEVIS' };
    await gnssSecrets.set('p1', 'secret');
    useGnssStore.getState().updateConfig({ profiles: [profile], activeProfileId: 'p1' });
    session.start(RECEIVER);
    await advance(400);
    await advance(3000);
    expect(useGnssStore.getState().ntrip.phase).toBe('streaming');
    expect(link.written).toBeGreaterThan(0);
    // Switching corrections off stops them.
    useGnssStore.getState().updateConfig({ activeProfileId: null });
    await act(async () => {
      await session.refreshCorrections();
    });
    expect(useGnssStore.getState().ntrip.phase).toBe('off');
  });

  it('scans: the simulated receiver is found, then the scan ends', async () => {
    await act(async () => {
      await session.scan();
    });
    expect(useGnssStore.getState().scanning).toBe(true);
    await advance(300);
    expect(useGnssStore.getState().devices.map((d) => d.id)).toEqual([SIMULATED_RECEIVER_ID]);
    await advance(2000);
    expect(useGnssStore.getState().scanning).toBe(false);
    session.stopScan();
  });

  it('an unknown device is a fatal link error, shown in words', async () => {
    session.start({ id: 'AA:BB', name: 'Other', transport: 'ble' });
    await advance(10);
    expect(useGnssStore.getState().error).toBe('This build only has the simulated receiver');
  });
});

describe('linkErrorMessage', () => {
  it('says what to do', () => {
    expect(linkErrorMessage('E_GNSS_BLUETOOTH_OFF', '')).toMatch(/Bluetooth is off/);
    expect(linkErrorMessage('E_GNSS_PERMISSION', '')).toMatch(/permission/);
    expect(linkErrorMessage('E_GNSS_NOT_BONDED', '')).toMatch(/Pair the receiver/);
    expect(linkErrorMessage('E_GNSS_CONNECT_TIMEOUT', '')).toMatch(/close by/);
    expect(linkErrorMessage('E_GNSS_NO_SERIAL_SERVICE', '')).toMatch(/data stream/);
    expect(linkErrorMessage('E_OTHER', 'fallback')).toBe('fallback');
  });
});

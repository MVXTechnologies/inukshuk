import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useLibrary } from './useLibrary';
import { idb } from '../lib/idb';

jest.mock('react', () => jest.requireActual('../../../node_modules/react'));
jest.mock('../lib/idb', () => ({
  GPX_STORE: 'gpx',
  LIBRARY_STORE: 'library',
  idb: { get: jest.fn(), commitLibrary: jest.fn(), put: jest.fn() },
}));
jest.mock('../demo/routes', () => ({
  DEMO_ROUTES: [{ id: 'demo', name: 'Demo', startedAt: 1000 }],
  DEMO_FOLDERS: [],
  DEMO_CUSTOM_CATEGORIES: [],
  DEMO_WAYPOINTS: [],
}));
jest.mock('../demo/synth', () => ({
  synthGpx: () =>
    '<gpx><trk><trkseg><trkpt lat="45" lon="-70"/><trkpt lat="45.01" lon="-70"/></trkseg></trk></gpx>',
}));
afterEach(() => {
  jest.resetAllMocks();
});

describe('library persistence integration', () => {
  it('keeps private-mode demo GPX usable and explicitly reports not saved', async () => {
    jest.mocked(idb.get).mockRejectedValue(new Error('blocked'));
    jest.mocked(idb.commitLibrary).mockRejectedValue(new Error('blocked'));
    const { result } = await renderHook(() => useLibrary());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.persistence.state).toBe('error');
    expect(await result.current.loadPoints('demo')).toHaveLength(2);
  });

  it('retains a failed import and retries both its XML and summary', async () => {
    jest.mocked(idb.get).mockResolvedValue(undefined);
    jest.mocked(idb.commitLibrary).mockResolvedValue(undefined);
    const { result } = await renderHook(() => useLibrary());
    await waitFor(() => expect(result.current.ready).toBe(true));
    jest.mocked(idb.commitLibrary).mockRejectedValue(new Error('quota'));
    let message = '';
    await act(async () => {
      message = await result.current.importFiles([
        {
          name: 'Trail.gpx',
          text: async () =>
            '<gpx><trk><trkseg><trkpt lat="46" lon="-70"/><trkpt lat="46.01" lon="-70"/></trkseg></trk></gpx>',
        } as File,
      ]);
    });
    expect(message).toMatch(/not saved/i);
    const imported = result.current.index.tracks.find((track) => track.id !== 'demo')!;
    expect(await result.current.loadPoints(imported.id)).toHaveLength(2);
    jest.mocked(idb.commitLibrary).mockResolvedValue(undefined);
    await act(async () => {
      expect(await result.current.retrySave()).toBe(true);
    });
    const write = jest.mocked(idb.commitLibrary).mock.calls.at(-1)!;
    expect(write[1].get(imported.id)).toContain('<gpx>');
    expect(result.current.persistence.state).toBe('saved');
  });
  it('keeps failed trim points usable, then atomically retries deletion', async () => {
    jest.mocked(idb.get).mockResolvedValue(undefined);
    jest.mocked(idb.commitLibrary).mockResolvedValue(undefined);
    const { result } = await renderHook(() => useLibrary());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const points = await result.current.loadPoints('demo');
    jest.mocked(idb.commitLibrary).mockRejectedValue(new Error('quota'));
    await act(async () => {
      expect(
        await result.current.applyTrim(
          'demo',
          points.map((point) => ({ ...point, latitude: 46 })),
          'overwrite',
        ),
      ).toMatch(/not saved/i);
    });
    expect((await result.current.loadPoints('demo'))[0]?.latitude).toBe(46);
    await act(async () => {
      result.current.removeTrack('demo');
    });
    expect(result.current.index.tracks).toHaveLength(0);
    expect(await result.current.loadPoints('demo')).toEqual([]);
    jest.mocked(idb.commitLibrary).mockResolvedValue(undefined);
    await act(async () => {
      await result.current.retrySave();
    });
    const write = jest.mocked(idb.commitLibrary).mock.calls.at(-1)!;
    expect(write[0]).toMatchObject({ tracks: [] });
    expect(write[1].get('demo')).toBe(null);
  });

  it('does not overwrite an unseen saved library after an initial read failure', async () => {
    jest.mocked(idb.get).mockRejectedValue(new Error('blocked'));
    const { result } = await renderHook(() => useLibrary());
    await waitFor(() => expect(result.current.ready).toBe(true));
    jest.mocked(idb.get).mockResolvedValue({ demoSeeded: true, tracks: [{ id: 'precious' }] });
    await act(async () => {
      expect(await result.current.retrySave()).toBe(false);
    });
    expect(idb.commitLibrary).not.toHaveBeenCalled();
    expect(result.current.persistence.message).toMatch(/Reload/);
  });

  it('retries failed reseeding as one complete replacement', async () => {
    jest.mocked(idb.get).mockResolvedValue(undefined);
    jest.mocked(idb.commitLibrary).mockResolvedValue(undefined);
    const { result } = await renderHook(() => useLibrary());
    await waitFor(() => expect(result.current.ready).toBe(true));
    jest.mocked(idb.commitLibrary).mockRejectedValue(new Error('quota'));
    await act(async () => {
      await result.current.reseed();
    });
    expect(result.current.persistence.state).toBe('error');
    expect(await result.current.loadPoints('demo')).toHaveLength(2);
    jest.mocked(idb.commitLibrary).mockResolvedValue(undefined);
    await act(async () => {
      await result.current.retrySave();
    });
    const write = jest.mocked(idb.commitLibrary).mock.calls.at(-1)!;
    expect(write[2]).toBe(true);
    expect(write[1].get('demo')).toContain('<gpx>');
  });
});

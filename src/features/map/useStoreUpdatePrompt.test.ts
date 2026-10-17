import { act, renderHook } from '@testing-library/react-native';

import { UPDATE_CHECK_INTERVAL_MS, type UpdateCheckState } from '@core/app/storeUpdate';

import {
  UPDATE_CHECK_DELAY_MS,
  resetUpdateCheckForTests,
  useStoreUpdatePrompt,
} from './useStoreUpdatePrompt';

jest.mock('@data/storeUpdate', () => ({
  readUpdateCheckState: jest.fn(),
  saveUpdateCheckState: jest.fn(),
  fetchStoreAnswer: jest.fn(),
  runningBinary: jest.fn(() => ({ version: '2.7.0', build: '119' })),
  startStoreUpdate: jest.fn(async () => 'store'),
  openStorePage: jest.fn(async () => true),
  installDownloadedUpdate: jest.fn(async () => true),
}));

jest.mock('@lib/playAppUpdate', () => {
  const listeners = new Set<(mockState: unknown) => void>();
  return {
    onPlayInstallState: jest.fn((fn: (mockState: unknown) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
    __emit: (mockState: unknown) => listeners.forEach((fn) => fn(mockState)),
  };
});

jest.mock('@state/recorderStore', () => {
  const { create } = jest.requireActual('zustand');
  return { useRecorderStore: create(() => ({ status: 'idle' })) };
});

jest.mock('@state/teamStore', () => {
  const { create } = jest.requireActual('zustand');
  return { useTeamStore: create(() => ({ sosAlarm: null, soses: [] })) };
});

const data = jest.requireMock('@data/storeUpdate') as {
  readUpdateCheckState: jest.Mock;
  saveUpdateCheckState: jest.Mock;
  fetchStoreAnswer: jest.Mock;
  startStoreUpdate: jest.Mock;
  openStorePage: jest.Mock;
  installDownloadedUpdate: jest.Mock;
};
const playMock = jest.requireMock('@lib/playAppUpdate') as { __emit: (s: unknown) => void };
const { useRecorderStore } = jest.requireMock('@state/recorderStore') as {
  useRecorderStore: { setState: (s: object) => void };
};
const { useTeamStore } = jest.requireMock('@state/teamStore') as {
  useTeamStore: { setState: (s: object) => void };
};

const NOW = 1_800_000_000_000;
const IOS_OFFER = { platform: 'ios' as const, version: '2.7.1', trackId: 42 };
const ANDROID_OFFER = { platform: 'android' as const, versionCode: 120 };
const EMPTY: UpdateCheckState = {
  lastCheckAt: null,
  offer: null,
  dismissed: null,
  downloadPending: false,
};

async function mountAndSettle() {
  const hook = await renderHook(() => useStoreUpdatePrompt());
  expect(hook.result.current).toBeNull();
  await act(async () => {
    jest.advanceTimersByTime(UPDATE_CHECK_DELAY_MS);
  });
  // The read, then the store's answer: one turn each.
  await act(async () => {});
  return hook;
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  jest.clearAllMocks();
  resetUpdateCheckForTests();
  useRecorderStore.setState({ status: 'idle' });
  useTeamStore.setState({ sosAlarm: null, soses: [] });
  data.readUpdateCheckState.mockResolvedValue(EMPTY);
  data.fetchStoreAnswer.mockResolvedValue({ offer: IOS_OFFER, phase: { kind: 'available' } });
  data.startStoreUpdate.mockResolvedValue('store');
  data.installDownloadedUpdate.mockResolvedValue(true);
});

afterEach(() => {
  jest.useRealTimers();
});

it('checks after the launch delay, never before, and shows the offer', async () => {
  const { result } = await renderHook(() => useStoreUpdatePrompt());
  await act(async () => {
    jest.advanceTimersByTime(UPDATE_CHECK_DELAY_MS - 1);
  });
  expect(data.fetchStoreAnswer).not.toHaveBeenCalled();
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(data.fetchStoreAnswer).toHaveBeenCalledTimes(1);
  expect(result.current).toMatchObject({ text: 'Version 2.7.1 available', action: 'Update' });
  expect(data.saveUpdateCheckState).toHaveBeenCalledWith({
    lastCheckAt: NOW + UPDATE_CHECK_DELAY_MS,
    offer: IOS_OFFER,
    dismissed: null,
    downloadPending: false,
  });
});

it('checks once per launch, even when the Map mounts again', async () => {
  const first = await mountAndSettle();
  await first.unmount();
  await mountAndSettle();
  expect(data.fetchStoreAnswer).toHaveBeenCalledTimes(1);
});

it('waits a day between checks, but still shows the remembered offer', async () => {
  data.readUpdateCheckState.mockResolvedValue({
    ...EMPTY,
    lastCheckAt: NOW - UPDATE_CHECK_INTERVAL_MS / 2,
    offer: IOS_OFFER,
  });
  const { result } = await mountAndSettle();
  expect(data.fetchStoreAnswer).not.toHaveBeenCalled();
  expect(result.current?.text).toBe('Version 2.7.1 available');
});

it('drops a remembered offer once that version is installed', async () => {
  data.readUpdateCheckState.mockResolvedValue({
    ...EMPTY,
    lastCheckAt: NOW - 1000,
    offer: { ...IOS_OFFER, version: '2.7.0' },
  });
  const { result } = await mountAndSettle();
  expect(result.current).toBeNull();
});

it('is silent when the store cannot answer, and does not count it as a check', async () => {
  data.fetchStoreAnswer.mockResolvedValue(null);
  const { result } = await mountAndSettle();
  expect(result.current).toBeNull();
  expect(data.saveUpdateCheckState).not.toHaveBeenCalled();
});

it('is silent when reading the state fails', async () => {
  data.readUpdateCheckState.mockRejectedValue(new Error('io'));
  const { result } = await mountAndSettle();
  expect(result.current).toBeNull();
});

it('close remembers this version only', async () => {
  const { result } = await mountAndSettle();
  await act(async () => result.current?.onDismiss());
  expect(result.current).toBeNull();
  expect(data.saveUpdateCheckState).toHaveBeenLastCalledWith(
    expect.objectContaining({ dismissed: 'ios:2.7.1' }),
  );
});

it('a dismissed version stays away; a newer one shows', async () => {
  data.readUpdateCheckState.mockResolvedValue({ ...EMPTY, dismissed: 'ios:2.7.1' });
  const hidden = await mountAndSettle();
  expect(hidden.result.current).toBeNull();
  await hidden.unmount();

  resetUpdateCheckForTests();
  data.fetchStoreAnswer.mockResolvedValue({
    offer: { ...IOS_OFFER, version: '2.7.2' },
    phase: { kind: 'available' },
  });
  const shown = await mountAndSettle();
  expect(shown.result.current?.text).toBe('Version 2.7.2 available');
});

it('never shows during a recording or a live SOS', async () => {
  const { result } = await mountAndSettle();
  expect(result.current).not.toBeNull();
  await act(async () => useRecorderStore.setState({ status: 'recording' }));
  expect(result.current).toBeNull();
  await act(async () => useRecorderStore.setState({ status: 'paused' }));
  expect(result.current).toBeNull();
  await act(async () => useRecorderStore.setState({ status: 'idle' }));
  expect(result.current).not.toBeNull();
  await act(async () => useTeamStore.setState({ soses: [{ resolved: false }] }));
  expect(result.current).toBeNull();
  await act(async () => useTeamStore.setState({ soses: [{ resolved: true }] }));
  expect(result.current).not.toBeNull();
  await act(async () => useTeamStore.setState({ sosAlarm: { entity: 'sos:a:b' } }));
  expect(result.current).toBeNull();
});

it('iPhone: Update opens the store page', async () => {
  const { result } = await mountAndSettle();
  await act(async () => result.current?.onAction());
  expect(data.startStoreUpdate).toHaveBeenCalledWith(IOS_OFFER);
  expect(result.current?.action).toBe('Update');
});

it('Android: Update downloads in the background, then Restart installs', async () => {
  data.fetchStoreAnswer.mockResolvedValue({ offer: ANDROID_OFFER, phase: { kind: 'available' } });
  data.startStoreUpdate.mockResolvedValue('started');
  const { result } = await mountAndSettle();
  expect(result.current?.text).toBe('New version available');

  await act(async () => result.current?.onAction());
  expect(result.current).toMatchObject({ text: 'Downloading update', action: null });

  await act(async () => playMock.__emit({ status: 2, bytesDownloaded: 50, totalBytes: 100 }));
  expect(result.current?.text).toBe('Downloading update · 50 %');
  // A tap while it downloads does nothing.
  await act(async () => result.current?.onAction());
  expect(data.startStoreUpdate).toHaveBeenCalledTimes(1);

  await act(async () => playMock.__emit({ status: 11, bytesDownloaded: 100, totalBytes: 100 }));
  expect(result.current).toMatchObject({ text: 'Update downloaded', action: 'Restart' });
  await act(async () => result.current?.onAction());
  expect(data.installDownloadedUpdate).toHaveBeenCalledTimes(1);
  expect(data.openStorePage).not.toHaveBeenCalled();
});

it('Android: a failed install opens the Play listing', async () => {
  data.fetchStoreAnswer.mockResolvedValue({ offer: ANDROID_OFFER, phase: { kind: 'downloaded' } });
  data.installDownloadedUpdate.mockResolvedValue(false);
  const { result } = await mountAndSettle();
  await act(async () => result.current?.onAction());
  expect(data.openStorePage).toHaveBeenCalledWith(ANDROID_OFFER);
});

it('Android: a declined or failed download offers the update again', async () => {
  data.fetchStoreAnswer.mockResolvedValue({ offer: ANDROID_OFFER, phase: { kind: 'available' } });
  data.startStoreUpdate.mockResolvedValue('declined');
  const { result } = await mountAndSettle();
  await act(async () => result.current?.onAction());
  expect(result.current?.action).toBe('Update');
  await act(async () => playMock.__emit({ status: 2, bytesDownloaded: 1, totalBytes: 10 }));
  await act(async () => playMock.__emit({ status: 5, bytesDownloaded: 0, totalBytes: 0 }));
  expect(result.current?.action).toBe('Update');
});

it('a remembered offer can be dismissed without a check', async () => {
  data.readUpdateCheckState.mockResolvedValue({
    ...EMPTY,
    lastCheckAt: NOW - 1000,
    offer: IOS_OFFER,
  });
  const { result } = await mountAndSettle();
  await act(async () => result.current?.onDismiss());
  expect(result.current).toBeNull();
  expect(data.saveUpdateCheckState).toHaveBeenCalledWith({
    ...EMPTY,
    lastCheckAt: NOW - 1000,
    offer: IOS_OFFER,
    dismissed: 'ios:2.7.1',
  });
});

it('Android: an accepted download is asked about again at the next launch', async () => {
  data.fetchStoreAnswer.mockResolvedValue({ offer: ANDROID_OFFER, phase: { kind: 'available' } });
  data.startStoreUpdate.mockResolvedValue('started');
  const first = await mountAndSettle();
  await act(async () => first.result.current?.onAction());
  expect(data.saveUpdateCheckState).toHaveBeenLastCalledWith(
    expect.objectContaining({ downloadPending: true }),
  );
  await first.unmount();

  // The next launch, within the day: the pending download is asked about.
  resetUpdateCheckForTests();
  data.readUpdateCheckState.mockResolvedValue({
    ...EMPTY,
    lastCheckAt: NOW,
    offer: ANDROID_OFFER,
    downloadPending: true,
  });
  data.fetchStoreAnswer.mockResolvedValue({ offer: ANDROID_OFFER, phase: { kind: 'downloaded' } });
  const second = await mountAndSettle();
  expect(data.fetchStoreAnswer).toHaveBeenCalledTimes(2);
  expect(second.result.current).toMatchObject({ text: 'Update downloaded', action: 'Restart' });
  expect(data.saveUpdateCheckState).toHaveBeenLastCalledWith(
    expect.objectContaining({ downloadPending: true }),
  );
});

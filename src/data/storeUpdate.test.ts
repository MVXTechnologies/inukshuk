import { Linking, Platform } from 'react-native';

import { EMPTY_UPDATE_CHECK_STATE } from '@core/app/storeUpdate';

import {
  fetchStoreAnswer,
  installDownloadedUpdate,
  openStorePage,
  readUpdateCheckState,
  runningBinary,
  saveUpdateCheckState,
  startStoreUpdate,
} from './storeUpdate';

jest.mock('expo-application', () => ({
  nativeApplicationVersion: '2.7.0',
  nativeBuildVersion: '119',
  applicationId: 'com.inukshuk.app',
}));

jest.mock('@lib/playAppUpdate', () => ({
  PLAY_AVAILABILITY: { AVAILABLE: 2, IN_PROGRESS: 3 },
  playUpdateInfo: jest.fn(),
  startPlayFlexibleUpdate: jest.fn(),
  completePlayUpdate: jest.fn(),
}));

jest.mock('./storage', () => {
  let stored: unknown = null;
  return {
    readJson: jest.fn(async () => stored),
    writeJson: jest.fn((_name: string, value: unknown) => {
      stored = value;
    }),
    isNetworkAllowed: jest.fn(() => true),
    __set: (v: unknown) => {
      stored = v;
    },
  };
});

const storageMock = jest.requireMock('./storage') as {
  readJson: jest.Mock;
  writeJson: jest.Mock;
  isNetworkAllowed: jest.Mock;
  __set: (v: unknown) => void;
};
const play = jest.requireMock('@lib/playAppUpdate') as {
  playUpdateInfo: jest.Mock;
  startPlayFlexibleUpdate: jest.Mock;
  completePlayUpdate: jest.Mock;
};

function lookupResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => body } as unknown as Response;
}

let fetchSpy: jest.SpyInstance;
let openSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  storageMock.__set(null);
  storageMock.isNetworkAllowed.mockReturnValue(true);
  fetchSpy = jest.spyOn(global, 'fetch');
  openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  jest.replaceProperty(Platform, 'OS', 'ios');
  jest.spyOn(Platform, 'Version', 'get').mockReturnValue('18.2');
});

afterEach(() => {
  // Spies, the Platform getter and replaced properties.
  jest.restoreAllMocks();
});

it('reports the native binary, not the over-the-air bundle', () => {
  expect(runningBinary()).toEqual({ version: '2.7.0', build: '119' });
});

describe('the persisted state', () => {
  it('reads a missing or junk file as empty', async () => {
    expect(await readUpdateCheckState()).toEqual({
      lastCheckAt: null,
      offer: null,
      dismissed: null,
      downloadPending: false,
    });
    storageMock.readJson.mockRejectedValueOnce(new Error('io'));
    expect((await readUpdateCheckState()).offer).toBeNull();
  });

  it('round-trips through update-check.json', async () => {
    const state = {
      lastCheckAt: 7,
      offer: { platform: 'ios' as const, version: '2.7.1', trackId: 42 },
      dismissed: null,
      downloadPending: false,
    };
    saveUpdateCheckState(state);
    expect(storageMock.writeJson).toHaveBeenCalledWith('update-check.json', state);
    expect(await readUpdateCheckState()).toEqual(state);
  });

  it('a failed write is swallowed', () => {
    storageMock.writeJson.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() =>
      saveUpdateCheckState({ ...EMPTY_UPDATE_CHECK_STATE, lastCheckAt: 1 }),
    ).not.toThrow();
  });
});

describe('fetchStoreAnswer on iPhone', () => {
  it('asks the App Store by bundle id and offers a newer version', async () => {
    fetchSpy.mockResolvedValue(
      lookupResponse({ results: [{ version: '2.7.1', trackId: 42, minimumOsVersion: '17.0' }] }),
    );
    expect(await fetchStoreAnswer()).toEqual({
      offer: { platform: 'ios', version: '2.7.1', trackId: 42 },
      phase: { kind: 'available' },
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'https://itunes.apple.com/lookup?bundleId=com.inukshuk.app',
    );
  });

  it('answers "nothing new" for the running version', async () => {
    fetchSpy.mockResolvedValue(lookupResponse({ results: [{ version: '2.7.0', trackId: 42 }] }));
    expect(await fetchStoreAnswer()).toEqual({ offer: null, phase: { kind: 'available' } });
  });

  it('is silent (null) offline, on HTTP errors and with network off', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Network request failed'));
    expect(await fetchStoreAnswer()).toBeNull();
    fetchSpy.mockResolvedValueOnce(lookupResponse({}, false));
    expect(await fetchStoreAnswer()).toBeNull();
    storageMock.isNetworkAllowed.mockReturnValue(false);
    expect(await fetchStoreAnswer()).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('fetchStoreAnswer on Android', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'android');
  });

  const info = {
    availability: 2,
    versionCode: 120,
    installStatus: 0,
    flexibleAllowed: true,
    bytesDownloaded: 0,
    totalBytes: 0,
  };

  it('offers what Play has, by versionCode', async () => {
    play.playUpdateInfo.mockResolvedValue(info);
    expect(await fetchStoreAnswer()).toEqual({
      offer: { platform: 'android', versionCode: 120 },
      phase: { kind: 'available' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('picks up a download that finished in an earlier session', async () => {
    play.playUpdateInfo.mockResolvedValue({ ...info, availability: 3, installStatus: 11 });
    expect(await fetchStoreAnswer()).toEqual({
      offer: { platform: 'android', versionCode: 120 },
      phase: { kind: 'downloaded' },
    });
  });

  it('nothing on offer, or no Play at all', async () => {
    play.playUpdateInfo.mockResolvedValueOnce({ ...info, availability: 1 });
    expect(await fetchStoreAnswer()).toEqual({ offer: null, phase: { kind: 'available' } });
    play.playUpdateInfo.mockResolvedValueOnce({ ...info, versionCode: 0 });
    expect(await fetchStoreAnswer()).toEqual({ offer: null, phase: { kind: 'available' } });
    play.playUpdateInfo.mockResolvedValueOnce(null);
    expect(await fetchStoreAnswer()).toBeNull();
  });
});

describe('the Update button', () => {
  const ios = { platform: 'ios' as const, version: '2.7.1', trackId: 42 };
  const android = { platform: 'android' as const, versionCode: 120 };

  it('iPhone opens the App Store app, else the web page', async () => {
    expect(await startStoreUpdate(ios)).toBe('store');
    expect(openSpy).toHaveBeenCalledWith('itms-apps://apps.apple.com/app/id42');
    openSpy.mockClear();
    openSpy.mockRejectedValueOnce(new Error('no scheme'));
    expect(await openStorePage(ios)).toBe(true);
    expect(openSpy).toHaveBeenLastCalledWith('https://apps.apple.com/app/id42');
  });

  it('Android starts Play’s flexible update', async () => {
    play.startPlayFlexibleUpdate.mockResolvedValueOnce(true);
    expect(await startStoreUpdate(android)).toBe('started');
    play.startPlayFlexibleUpdate.mockResolvedValueOnce(false);
    expect(await startStoreUpdate(android)).toBe('declined');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('Android without in-app updates opens the Play listing', async () => {
    play.startPlayFlexibleUpdate.mockRejectedValueOnce(new Error('unavailable'));
    expect(await startStoreUpdate(android)).toBe('store');
    expect(openSpy).toHaveBeenCalledWith('market://details?id=com.inukshuk.app');
    play.startPlayFlexibleUpdate.mockRejectedValueOnce(new Error('unavailable'));
    openSpy.mockRejectedValue(new Error('nothing opens'));
    expect(await startStoreUpdate(android)).toBe('failed');
  });

  it('Restart to update installs, and reports a failure', async () => {
    play.completePlayUpdate.mockResolvedValueOnce(undefined);
    expect(await installDownloadedUpdate()).toBe(true);
    play.completePlayUpdate.mockRejectedValueOnce(new Error('x'));
    expect(await installDownloadedUpdate()).toBe(false);
  });
});

import type { StravaConnection } from '@core/strava/tokens';
import { resetSecureStoreForTests } from '@data/secureStore';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';
import { requireOptionalNativeModule } from 'expo';
import * as SecureStore from 'expo-secure-store';

import { STRAVA_SECRET, stravaWritesSettled, useStravaStore } from './stravaStore';

jest.mock('@data/storage', () => ({
  readJson: jest.fn(async () => null),
  writeJson: jest.fn(),
  deleteJson: jest.fn(),
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('expo', () => ({ requireOptionalNativeModule: jest.fn(() => ({})) }));

const CONN: StravaConnection = {
  accessToken: 'a1',
  refreshToken: 'r1',
  expiresAt: 1_800_000_000,
  athleteId: 7,
  athleteName: 'Jane Doe',
  scopes: ['activity:write', 'activity:read_all'],
};

const keychain = () => (globalThis as { __secureStore?: Map<string, string> }).__secureStore;
const stored = () =>
  JSON.parse(keychain()?.get(STRAVA_SECRET) ?? 'null') as {
    connection: StravaConnection | null;
    savedAt: number;
  } | null;

beforeEach(() => {
  resetSecureStoreForTests();
  jest.mocked(requireOptionalNativeModule).mockReturnValue({});
  jest.mocked(storage.readJson).mockReset().mockResolvedValue(null);
  jest.mocked(storage.writeJson).mockReset();
  jest.mocked(storage.deleteJson).mockReset();
  jest.mocked(reportError).mockReset();
  useStravaStore.setState({ hydrated: false, connection: null });
});

describe('Strava tokens in secure storage (audit L4)', () => {
  it('nothing saved: disconnected, nothing written', async () => {
    await useStravaStore.getState().hydrate();
    expect(useStravaStore.getState()).toMatchObject({ hydrated: true, connection: null });
    expect(storage.writeJson).not.toHaveBeenCalled();
    expect(storage.deleteJson).not.toHaveBeenCalled();
  });

  it('migrates strava.json once: secure copy written and verified, then the file deleted', async () => {
    jest.mocked(storage.readJson).mockResolvedValue({ schemaVersion: 1, connection: CONN });
    await useStravaStore.getState().hydrate();
    expect(useStravaStore.getState().connection).toEqual(CONN);
    expect(stored()?.connection).toEqual(CONN);
    expect(storage.deleteJson).toHaveBeenCalledWith('strava.json');
    expect(storage.writeJson).not.toHaveBeenCalled();
    // Next launch: read from secure storage, no file left.
    jest.mocked(storage.readJson).mockResolvedValue(null);
    useStravaStore.setState({ hydrated: false, connection: null });
    await useStravaStore.getState().hydrate();
    expect(useStravaStore.getState().connection).toEqual(CONN);
  });

  it('an unverified secure write keeps the plain file (tokens are never lost)', async () => {
    jest.mocked(storage.readJson).mockResolvedValue({ schemaVersion: 1, connection: CONN });
    jest.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(null).mockResolvedValueOnce('torn');
    await useStravaStore.getState().hydrate();
    expect(useStravaStore.getState().connection).toEqual(CONN);
    expect(storage.deleteJson).not.toHaveBeenCalled();
    expect(storage.writeJson).toHaveBeenCalledWith(
      'strava.json',
      expect.objectContaining({ connection: CONN }),
    );
  });

  it('a failing keychain is reported and falls back to the file', async () => {
    jest.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('locked'));
    jest.mocked(storage.readJson).mockResolvedValue({ schemaVersion: 1, connection: CONN });
    jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('locked'));
    await useStravaStore.getState().hydrate();
    expect(useStravaStore.getState().connection).toEqual(CONN);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'strava-secure-read');
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'strava-secure-write');
    expect(storage.writeJson).toHaveBeenCalled();
  });

  it('a binary without secure storage keeps using the file', async () => {
    jest.mocked(requireOptionalNativeModule).mockReturnValue(null);
    resetSecureStoreForTests();
    useStravaStore.getState().setConnection(CONN);
    await stravaWritesSettled();
    expect(storage.writeJson).toHaveBeenCalledWith(
      'strava.json',
      expect.objectContaining({ connection: CONN }),
    );
    expect(keychain()?.size).toBe(0);
  });

  it('when both copies exist, the newer wins', async () => {
    keychain()?.set(
      STRAVA_SECRET,
      JSON.stringify({ schemaVersion: 1, connection: { ...CONN, accessToken: 'new' }, savedAt: 2 }),
    );
    jest
      .mocked(storage.readJson)
      .mockResolvedValue({ schemaVersion: 1, connection: CONN, savedAt: 1 });
    await useStravaStore.getState().hydrate();
    expect(useStravaStore.getState().connection?.accessToken).toBe('new');
    // The stale file goes once the secure copy is re-saved.
    expect(storage.deleteJson).toHaveBeenCalledWith('strava.json');
    // A junk secure entry loses to a good file.
    keychain()?.set(STRAVA_SECRET, '{torn');
    jest.mocked(storage.readJson).mockResolvedValue({ schemaVersion: 1, connection: CONN });
    await useStravaStore.getState().hydrate();
    expect(useStravaStore.getState().connection?.accessToken).toBe('a1');
  });

  it('rotated tokens are written in order; disconnecting deletes the secret', async () => {
    const s = useStravaStore.getState();
    s.setConnection(CONN);
    s.setTokens({ accessToken: 'a2', refreshToken: 'r2', expiresAt: 1 });
    s.setTokens({ accessToken: 'a3', refreshToken: 'r3', expiresAt: 2 });
    await stravaWritesSettled();
    expect(stored()?.connection).toMatchObject({ accessToken: 'a3', refreshToken: 'r3' });
    s.clearConnection();
    await stravaWritesSettled();
    expect(keychain()?.has(STRAVA_SECRET)).toBe(false);
    expect(storage.deleteJson).toHaveBeenCalledWith('strava.json');
    // Disconnected: refreshed tokens have nowhere to go.
    useStravaStore.getState().setTokens({ accessToken: 'x', refreshToken: 'y', expiresAt: 3 });
    expect(useStravaStore.getState().connection).toBeNull();
  });

  it('a file that can’t be deleted is reported, not fatal', async () => {
    jest.mocked(storage.deleteJson).mockImplementation(() => {
      throw new Error('EPERM');
    });
    useStravaStore.getState().setConnection(CONN);
    await stravaWritesSettled();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'strava-file');
    expect(stored()?.connection).toEqual(CONN);
  });
});

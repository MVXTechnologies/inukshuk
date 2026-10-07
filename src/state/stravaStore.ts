import {
  STRAVA_SCHEMA_VERSION,
  sanitizeStravaDoc,
  type StravaConnection,
  type StravaTokens,
} from '@core/strava/tokens';
import { deleteSecret, readSecret, secretKey, writeSecret } from '@data/secureStore';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';
import { create } from 'zustand';

/** The pre-2.5.0 plain-JSON copy (security audit L4); migrated, then deleted. */
const STRAVA_FILE = 'strava.json';
/** The connection document in secure storage (Keychain / Keystore). */
export const STRAVA_SECRET = secretKey('strava', 'connection');

/**
 * The Strava connection: tokens + athlete identity, persisted in the
 * platform's secure storage (`@data/secureStore`). Pure token math and the
 * total sanitizer live in `@core/strava/tokens`; the OAuth/network flows that
 * mutate this store live in `src/lib/strava.ts`.
 *
 * Migration from `strava.json` (one time, on hydrate): the connection is
 * written to secure storage and read back; only a verified write deletes the
 * plain file (and its staging/corrupt copies). Should secure storage fail —
 * or a binary lack it — the file stays and keeps being written, so tokens
 * (which Strava rotates) are never lost. Each document carries `savedAt`, so
 * when both copies exist the newer one wins.
 */
interface StravaState {
  hydrated: boolean;
  /** The connected athlete's tokens/identity, or null when not connected. */
  connection: StravaConnection | null;

  hydrate: () => Promise<void>;
  /** Store a fresh connection (after the OAuth code exchange). */
  setConnection: (connection: StravaConnection) => void;
  /**
   * Store refreshed tokens. Strava ROTATES refresh tokens — this must always
   * be called with the full token set from the refresh response, never a
   * partial update that keeps the old refresh token.
   */
  setTokens: (tokens: StravaTokens) => void;
  /** Forget the connection (after deauthorize, or when Strava revokes us). */
  clearConnection: () => void;
}

interface Doc {
  schemaVersion: number;
  connection: StravaConnection | null;
  savedAt: number;
}

function docOf(connection: StravaConnection | null): Doc {
  return { schemaVersion: STRAVA_SCHEMA_VERSION, connection, savedAt: Date.now() };
}

function savedAtOf(raw: unknown): number {
  const v = (raw as { savedAt?: unknown } | null)?.savedAt;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parse(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Writes go out one after another, in call order (rotated tokens must never be overtaken). */
let queue: Promise<void> = Promise.resolve();

/**
 * Save the connection: secure storage first; the plain file only if that
 * fails (deleted again once a later write verifies).
 */
function persist(connection: StravaConnection | null): Promise<void> {
  const doc = docOf(connection);
  queue = queue.then(async () => {
    let secured = false;
    try {
      secured =
        connection === null
          ? (await deleteSecret(STRAVA_SECRET), true)
          : await writeSecret(STRAVA_SECRET, JSON.stringify(doc));
    } catch (err) {
      reportError(err, 'strava-secure-write');
    }
    try {
      if (secured) storage.deleteJson(STRAVA_FILE);
      else storage.writeJson(STRAVA_FILE, doc);
    } catch (err) {
      reportError(err, 'strava-file');
    }
  });
  return queue;
}

/** Test-only: wait for queued writes. */
export function stravaWritesSettled(): Promise<void> {
  return queue;
}

export const useStravaStore = create<StravaState>((set, get) => ({
  hydrated: false,
  connection: null,

  hydrate: async () => {
    let secure: unknown = null;
    try {
      secure = parse(await readSecret(STRAVA_SECRET));
    } catch (err) {
      reportError(err, 'strava-secure-read');
    }
    const legacy = await storage.readJson<unknown>(STRAVA_FILE);
    // The newer copy wins (a fallback file write after a secure one, or the reverse).
    const newest = legacy !== null && savedAtOf(legacy) >= savedAtOf(secure) ? legacy : secure;
    // Total sanitization: a torn/junk document hydrates as disconnected.
    const connection = sanitizeStravaDoc(newest);
    set({ connection, hydrated: true });
    // One-time migration: re-save through secure storage, which deletes the
    // plain file only once the secure copy reads back.
    if (legacy !== null) await persist(connection);
  },

  setConnection: (connection) => {
    set({ connection });
    void persist(connection);
  },

  setTokens: (tokens) => {
    const current = get().connection;
    if (!current) return; // disconnected mid-refresh — nothing to update
    const next: StravaConnection = { ...current, ...tokens };
    set({ connection: next });
    void persist(next);
  },

  clearConnection: () => {
    set({ connection: null });
    void persist(null);
  },
}));

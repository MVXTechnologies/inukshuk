import {
  STRAVA_SCHEMA_VERSION,
  sanitizeStravaDoc,
  type StravaConnection,
  type StravaTokens,
} from '@core/strava/tokens';
import * as storage from '@data/storage';
import { create } from 'zustand';

const STRAVA_FILE = 'strava.json';

/**
 * The Strava connection: tokens + athlete identity, persisted to `strava.json`
 * (same atomic write path as the other documents). Pure token math and the
 * total sanitizer live in `@core/strava/tokens`; the OAuth/network flows that
 * mutate this store live in `src/lib/strava.ts`.
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

function persist(connection: StravaConnection | null): void {
  storage.writeJson(STRAVA_FILE, { schemaVersion: STRAVA_SCHEMA_VERSION, connection });
}

export const useStravaStore = create<StravaState>((set, get) => ({
  hydrated: false,
  connection: null,

  hydrate: async () => {
    const saved = await storage.readJson<unknown>(STRAVA_FILE);
    // Total sanitization: a torn/junk file hydrates as disconnected.
    set({ connection: sanitizeStravaDoc(saved), hydrated: true });
  },

  setConnection: (connection) => {
    set({ connection });
    persist(connection);
  },

  setTokens: (tokens) => {
    const current = get().connection;
    if (!current) return; // disconnected mid-refresh — nothing to update
    const next: StravaConnection = { ...current, ...tokens };
    set({ connection: next });
    persist(next);
  },

  clearConnection: () => {
    set({ connection: null });
    persist(null);
  },
}));

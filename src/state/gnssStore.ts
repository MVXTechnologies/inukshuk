import {
  DEFAULT_GNSS_CONFIG,
  sanitizeGnssConfig,
  type GnssConfig,
  type NtripProfile,
} from '@core/gnss/config';
import type { GnssFix, SatInView } from '@core/gnss/fix';
import type { PositionResult } from '@core/gnss/output';
import type { ExternalStatus, PhoneGpsMode, PositionSourceKind } from '@core/gnss/quality';
import type { LinkDevice, LinkStateName } from '@data/gnss/link';
import * as storage from '@data/storage';
import { create } from 'zustand';

const GNSS_FILE = 'gnss.json';

/** The NTRIP client's state, for the corrections row and the sheet. */
export interface NtripState {
  phase: 'off' | 'connecting' | 'streaming' | 'error' | 'unavailable';
  /** Why it isn't streaming (caster refusal, no socket in this build…). */
  message: string | null;
  /** Correction bytes received this session. */
  bytes: number;
  lastDataAtMs: number | null;
}

export const NTRIP_OFF: NtripState = { phase: 'off', message: null, bytes: 0, lastDataAtMs: null };

/**
 * The external GNSS receiver (#588): its saved settings (`gnss.json`, never a
 * password — `@data/gnss/credentials`) and the live session the controller
 * (`@features/gnss/session`) publishes: link, latest fix and quality, the
 * position source, the fix on the map and in the project datum, NTRIP.
 */
interface GnssState {
  hydrated: boolean;
  config: GnssConfig;

  link: LinkStateName;
  linkReason: string | null;
  /** The last receiver error worth showing (permission, Bluetooth off…). */
  error: string | null;
  scanning: boolean;
  /** Receivers found by the current / last scan, nearest-signal first. */
  devices: LinkDevice[];

  fix: GnssFix | null;
  status: ExternalStatus | null;
  sky: SatInView[];
  /** What the app's location uses now. */
  use: PositionSourceKind;
  /** How hard the phone's GPS should work. */
  phone: PhoneGpsMode;
  /** The phone's own last accuracy, metres (for "Phone GPS ±5 m · receiver off"). */
  phoneAccuracyM: number | null;
  /** The fix where the map draws it (WGS 84), and how it got there. */
  map: { lat: number; lon: number; result: PositionResult } | null;
  /** The fix in the project datum. */
  project: PositionResult | null;
  /**
   * While `project` waits for a grid download: the fix in the same frame
   * with ellipsoidal heights (`@core/gnss/output` fallbackDatum), else null.
   */
  projectFallback: PositionResult | null;
  ntrip: NtripState;
  /** The receiver detail sheet is up (map). */
  sheetOpen: boolean;

  hydrate: () => Promise<void>;
  /** Change the saved settings (one write). */
  updateConfig: (patch: Partial<GnssConfig>) => void;
  upsertProfile: (p: NtripProfile) => void;
  removeProfile: (id: string) => void;
  setSheetOpen: (open: boolean) => void;
  /** The session publishes here (no write to disk). */
  publish: (patch: Partial<Omit<GnssState, 'config' | 'hydrated'>>) => void;
  /** Back to "no receiver": the session stopped. */
  resetLive: () => void;
}

const LIVE = {
  link: 'idle' as LinkStateName,
  linkReason: null,
  error: null,
  scanning: false,
  devices: [],
  fix: null,
  status: null,
  sky: [],
  use: 'phone' as PositionSourceKind,
  phone: 'active' as PhoneGpsMode,
  phoneAccuracyM: null,
  map: null,
  project: null,
  projectFallback: null,
  ntrip: NTRIP_OFF,
};

function persist(config: GnssConfig): void {
  storage.writeJson(GNSS_FILE, config);
}

export const useGnssStore = create<GnssState>((set, get) => ({
  hydrated: false,
  config: DEFAULT_GNSS_CONFIG,
  ...LIVE,
  sheetOpen: false,

  hydrate: async () => {
    if (get().hydrated) return;
    const saved = await storage.readJson<unknown>(GNSS_FILE);
    set({ config: sanitizeGnssConfig(saved), hydrated: true });
  },

  updateConfig: (patch) => {
    const config = { ...get().config, ...patch };
    set({ config });
    persist(config);
  },

  upsertProfile: (p) => {
    const { profiles } = get().config;
    const next = profiles.some((x) => x.id === p.id)
      ? profiles.map((x) => (x.id === p.id ? p : x))
      : [...profiles, p];
    get().updateConfig({ profiles: next });
  },

  removeProfile: (id) => {
    const { profiles, activeProfileId } = get().config;
    get().updateConfig({
      profiles: profiles.filter((p) => p.id !== id),
      activeProfileId: activeProfileId === id ? null : activeProfileId,
    });
  },

  setSheetOpen: (sheetOpen) => set({ sheetOpen }),

  publish: (patch) => set(patch),

  resetLive: () => set({ ...LIVE, sheetOpen: false }),
}));

/**
 * Whether the phone's own fixes feed the recorder now. False while the
 * external receiver is the position source: its fixes are recorded instead,
 * and a phone fix in between would be a ≈ 1.5 m teleport (`@core/gnss/receiver`).
 */
export function phoneFeedsRecorder(): boolean {
  return useGnssStore.getState().use !== 'external';
}

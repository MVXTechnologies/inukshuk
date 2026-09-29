/**
 * When Inukshuk imports new Strava activities by itself (#432): on app start
 * and each return to the foreground, at most once per 15 minutes, only when
 * the user wants it, Strava can be read, the network is allowed, everything
 * has loaded, and no import job is on screen (a job the user stopped stays
 * stopped until they dismiss it).
 *
 * The first import is always a deliberate one from the Import sheet: until
 * the user has finished one, there is no "last import" to continue from and
 * nothing happens automatically — a whole history never starts downloading
 * behind their back.
 */

/** At most one automatic check per this long. */
export const AUTO_IMPORT_INTERVAL_MS = 15 * 60_000;

export interface AutoImportInput {
  /** The Settings switch. */
  enabled: boolean;
  /** Connected with `activity:read_all`. */
  canImport: boolean;
  /** Not in "locally downloaded only" mode. */
  networkAllowed: boolean;
  /** The import, Strava and Library stores have all loaded. */
  hydrated: boolean;
  /** Any job exists (running, paused, stopped, or a summary not dismissed). */
  hasJob: boolean;
  /** Strava's last finished import, or null before the first one. */
  lastImportAt: number | null;
  /** The last automatic attempt this session, or null. */
  lastAttemptAt: number | null;
  now: number;
}

export function shouldAutoImport(input: AutoImportInput): boolean {
  if (!input.enabled || !input.canImport || !input.networkAllowed || !input.hydrated) return false;
  if (input.hasJob || input.lastImportAt === null) return false;
  return input.lastAttemptAt === null || input.now - input.lastAttemptAt >= AUTO_IMPORT_INTERVAL_MS;
}

/** The quiet import's closing line: "2 new activities from Strava". */
export function quietImportMessage(imported: number, label: string): string {
  return `${imported} new ${imported === 1 ? 'activity' : 'activities'} from ${label}`;
}

/**
 * Durable team state on this phone (#589). The rules (spec §12b) this must
 * keep:
 *
 * - **Never lose the writer's chain.** Every op this device signs is appended
 *   to the team's op log BEFORE it is sent to anyone, and the writer cursor
 *   (`{seq, hlc, prev}`) is saved right after. On launch the runtime takes the
 *   later of the saved cursor and the device's own chain in the log, so a
 *   crash between the two writes can never make the device reuse a seq or
 *   fork its own chain (which every peer would treat as equivocation).
 * - Secrets stay in the secure store: the device's Ed25519/X25519 secrets
 *   (`@data/secureStore`, this-device-only, readable after first unlock).
 *   Team keys are not stored at all: they are re-unwrapped from the log with
 *   the device's X25519 secret on every launch.
 *
 * Layout under the documents directory:
 *
 *   teams/index.json          the teams on this phone and their local prefs
 *   teams/<teamId>/ops.jsonl  every accepted logged op, one envelope per line
 *   teams/<teamId>/cursor.json the writer cursor
 *
 * The op log is append-only; a torn last line (a crash mid-append) is skipped
 * on read. Op bodies are end-to-end encrypted anyway; the clear control
 * bodies (member ids, roles) are what every member already holds.
 */
import type { WriterCursor } from '@core/team/actions';

/** Local, per-team preferences (never synced). */
export interface TeamPrefs {
  /** Share my position with the team (opt-in, owner B9). */
  sharePosition: boolean;
  /** Seconds between position updates while sharing. */
  shareIntervalS: number;
  /** Share only while a recording runs (owner B9's default). */
  shareOnlyWhileRecording: boolean;
}

export const DEFAULT_TEAM_PREFS: TeamPrefs = {
  sharePosition: false,
  shareIntervalS: 60,
  shareOnlyWhileRecording: true,
};

export interface TeamRecord {
  teamId: string;
  /** Last known name (shown before the log loads). */
  name: string;
  /** My display name in this team. */
  myName: string;
  joinedAt: number;
  prefs: TeamPrefs;
  /** Newest message time I have seen in the chat (unread count). */
  lastReadAt: number;
  /** Key id my latest profile message was sealed under (re-posted on a new key). */
  profileKeyId?: string;
  /** Key id the team-name message was last re-posted under (admins). */
  teamNameKeyId?: string;
}

/** Device secrets, base64url (the public keys are derived on load). */
export interface DeviceSecrets {
  v: 1;
  sign: string;
  box: string;
}

export interface TeamDisk {
  loadDevice(): Promise<DeviceSecrets | null>;
  /** True only when the secret verifiably stuck. */
  saveDevice(secrets: DeviceSecrets): Promise<boolean>;
  loadTeams(): Promise<TeamRecord[]>;
  saveTeams(teams: readonly TeamRecord[]): void;
  /** Every stored envelope, in append order (unparsable lines skipped). */
  loadOps(teamId: string): Promise<unknown[]>;
  /** Synchronous append: when it returns, the ops are on disk. */
  appendOps(teamId: string, envelopes: readonly unknown[]): void;
  loadCursor(teamId: string): Promise<WriterCursor | null>;
  saveCursor(teamId: string, cursor: WriterCursor): void;
  deleteTeam(teamId: string): void;
}

/** Parse the op log text: one JSON envelope per line; junk and torn lines skipped. */
export function parseOpLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as unknown);
    } catch {
      // A torn final line (crash mid-append) or corruption: the peers still hold it.
    }
  }
  return out;
}

export function isWriterCursor(v: unknown): v is WriterCursor {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  const hlc = c['hlc'] as Record<string, unknown> | undefined;
  return (
    Number.isSafeInteger(c['seq']) &&
    (c['seq'] as number) >= 0 &&
    typeof hlc === 'object' &&
    hlc !== null &&
    Number.isFinite(hlc['wall']) &&
    Number.isSafeInteger(hlc['counter']) &&
    (c['prev'] === undefined || typeof c['prev'] === 'string')
  );
}

/** Tests, the loopback build's simulated teammates: everything in memory. */
export class MemoryTeamDisk implements TeamDisk {
  device: DeviceSecrets | null = null;
  teams: TeamRecord[] = [];
  readonly ops = new Map<string, unknown[]>();
  readonly cursors = new Map<string, WriterCursor>();
  /** Every append and cursor save, in order (tests check write-before-send). */
  readonly journal: string[] = [];

  async loadDevice() {
    return this.device;
  }
  async saveDevice(s: DeviceSecrets) {
    this.device = s;
    return true;
  }
  async loadTeams() {
    return this.teams.map((t) => ({ ...t, prefs: { ...t.prefs } }));
  }
  saveTeams(teams: readonly TeamRecord[]) {
    this.teams = teams.map((t) => ({ ...t, prefs: { ...t.prefs } }));
  }
  async loadOps(teamId: string) {
    return [...(this.ops.get(teamId) ?? [])];
  }
  appendOps(teamId: string, envelopes: readonly unknown[]) {
    // Round-trip through JSON like the file does.
    const list = this.ops.get(teamId) ?? [];
    for (const e of envelopes) list.push(JSON.parse(JSON.stringify(e)) as unknown);
    this.ops.set(teamId, list);
    this.journal.push(`ops:${envelopes.length}`);
  }
  async loadCursor(teamId: string) {
    return this.cursors.get(teamId) ?? null;
  }
  saveCursor(teamId: string, cursor: WriterCursor) {
    this.cursors.set(teamId, JSON.parse(JSON.stringify(cursor)) as WriterCursor);
    this.journal.push(`cursor:${cursor.seq}`);
  }
  deleteTeam(teamId: string) {
    this.ops.delete(teamId);
    this.cursors.delete(teamId);
    this.teams = this.teams.filter((t) => t.teamId !== teamId);
  }
}

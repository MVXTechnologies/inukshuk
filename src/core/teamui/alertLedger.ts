/**
 * Which phone notification a team alert raises, and once only (#708). Pure.
 *
 * - **Channels:** an SOS goes to "Team SOS" (alarm tone, long vibration,
 *   time-sensitive on iOS), a rally point to "Team rally" (default sound, its
 *   own vibration), everything else `alert`-level to the shared team channel.
 *   `badge` alerts never notify.
 * - **Never my own:** an alert whose author is me raises nothing (the core's
 *   routing already says so; this is the last gate before the phone buzzes).
 * - **Once per entity:** an SOS or rally point notifies once per id, however
 *   many times a resync brings its ops again. When it is resolved or ended
 *   ({@link AlertLedger.settle}) its notification is cleared, and a reopened
 *   SOS may alarm again.
 */
import type { TeamRally, TeamSos } from './field';
import type { TeamAlert } from './alerts';

export type AlertChannel = 'sos' | 'rally' | 'team';

/** The channel an alert notifies on, or null when it only updates the app. */
export function alertChannel(a: Pick<TeamAlert, 'kind' | 'level'>): AlertChannel | null {
  if (a.level !== 'alert') return null;
  if (a.kind === 'sos') return 'sos';
  if (a.kind === 'rally') return 'rally';
  return 'team';
}

/** The entity key of an SOS or a rally point (as on `TeamAlert.entity`). */
export const sosEntity = (s: Pick<TeamSos, 'owner' | 'id'>) => `sos:${s.owner}:${s.id}`;
export const rallyEntity = (r: Pick<TeamRally, 'owner' | 'id'>) => `rly:${r.owner}:${r.id}`;

/** The SOS and rally points that are active now (open SOS, the live rally point). */
export function activeEntities(
  soses: readonly TeamSos[],
  rally: TeamRally | null,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const s of soses) if (!s.resolved) out.add(sosEntity(s));
  if (rally !== null) out.add(rallyEntity(rally));
  return out;
}

/** The shortest gap between two in-app rally buzzes from one raiser (#743). */
export const RALLY_BUZZ_GAP_MS = 60_000;

/**
 * The in-app rally buzz (#743): with the app open, a new rally point
 * vibrates the phone as an SOS does (the system notification alone left it
 * silent in the foreground). On top of the ledger's limits (once per rally
 * point, never my own), one raiser buzzes this phone at most once per
 * {@link RALLY_BUZZ_GAP_MS}: a teammate moving the rally point three times
 * in a minute is one buzz, not three.
 */
export class RallyBuzzGate {
  private readonly last = new Map<string, number>();

  constructor(private readonly gapMs = RALLY_BUZZ_GAP_MS) {}

  /** Whether `author`'s rally may buzz at `now` (and, if so, it counts from now). */
  admit(author: string, now: number): boolean {
    const prev = this.last.get(author);
    if (prev !== undefined && now - prev < this.gapMs && now >= prev) return false;
    this.last.set(author, now);
    return true;
  }
}

export interface Routed {
  channel: AlertChannel;
  /** The notification's identifier: the entity for SOS and rally (so it can be cleared). */
  id: string | null;
}

export class AlertLedger {
  /** Notified entities, each with the write that rang for it. */
  private readonly notified = new Map<string, string>();

  /**
   * Whether `alert` raises a phone notification now, and on which channel;
   * records SOS and rally entities so a resync never notifies twice. An SOS
   * reopened after a resolve rings again even when the resolve and the reopen
   * arrived in one sync (never settled in between, QA 2.6.1).
   */
  route(alert: TeamAlert, me: string): Routed | null {
    const channel = alertChannel(alert);
    if (channel === null || alert.author === me) return null;
    if (channel === 'team') return { channel, id: null };
    const entity = alert.entity;
    if (entity === undefined) return null;
    const rang = this.notified.get(entity);
    if (rang !== undefined && !(alert.sosPhase === 'reopen' && rang !== alert.key)) return null;
    this.notified.set(entity, alert.key);
    return { channel, id: entity };
  }

  /** Whether `entity` has notified (and not been settled since). */
  has(entity: string): boolean {
    return this.notified.has(entity);
  }

  /**
   * The notified entities that are no longer active (resolved, ended,
   * deleted): forgotten here, returned so their notifications are cleared.
   */
  settle(active: ReadonlySet<string>): string[] {
    const gone: string[] = [];
    for (const e of this.notified.keys()) if (!active.has(e)) gone.push(e);
    for (const e of gone) this.notified.delete(e);
    return gone;
  }
}

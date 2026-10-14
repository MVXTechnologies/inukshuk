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

export interface Routed {
  channel: AlertChannel;
  /** The notification's identifier: the entity for SOS and rally (so it can be cleared). */
  id: string | null;
}

export class AlertLedger {
  private readonly notified = new Set<string>();

  /**
   * Whether `alert` raises a phone notification now, and on which channel;
   * records SOS and rally entities so a resync never notifies twice.
   */
  route(alert: TeamAlert, me: string): Routed | null {
    const channel = alertChannel(alert);
    if (channel === null || alert.author === me) return null;
    if (channel === 'team') return { channel, id: null };
    const entity = alert.entity;
    if (entity === undefined || this.notified.has(entity)) return null;
    this.notified.add(entity);
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
    for (const e of this.notified) if (!active.has(e)) gone.push(e);
    for (const e of gone) this.notified.delete(e);
    return gone;
  }
}

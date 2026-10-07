/** TEST-ONLY helpers shared by the team protocol tests. */
import { toB64u } from '../bytes';
import { generateDeviceKeys, type DeviceKeys } from '../crypto';
import { addMemberBody, createInvite, createTeam, targetOf } from '../actions';
import type { SignedOp } from '../envelope';
import { memberIdOf } from '../ids';
import { TeamReplica } from '../replica';
import type { GroupLink, Role } from '../roles';
import { nodeCrypto } from './nodeCrypto';

export const c = nodeCrypto;
/** 2026-10-07T12:00Z — a realistic "now" for every test. */
export const T0 = Date.UTC(2026, 9, 7, 12);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export interface Device {
  keys: DeviceKeys;
  id: string;
  x: string;
}

export function device(): Device {
  const keys = generateDeviceKeys(c);
  return { keys, id: memberIdOf(keys.signPublic), x: toB64u(keys.boxPublic) };
}

export interface World {
  teamId: string;
  owner: Device;
  replicas: Map<string, TeamReplica>;
  /** The owner's replica. */
  root: TeamReplica;
}

/** A fresh team whose owner replica holds the genesis and first key. */
export function newWorld(now = T0, lifetimeMs?: number): World {
  const owner = device();
  const team = createTeam(c, owner.keys, now, lifetimeMs === undefined ? {} : { lifetimeMs });
  const root = new TeamReplica(c, team.teamId, owner.keys, team.writer.cursor);
  root.addKey(team.key);
  const report = root.ingest([team.genesis.env], now);
  if (report.accepted.length !== 1) throw new Error('genesis not accepted');
  return { teamId: team.teamId, owner, replicas: new Map([[owner.id, root]]), root };
}

/** A replica for `d` that has every op `from` holds. */
export function joinReplica(world: World, d: Device, from: TeamReplica, now: number): TeamReplica {
  const r = new TeamReplica(c, world.teamId, d.keys);
  r.ingest(allEnvs(from, now), now);
  world.replicas.set(d.id, r);
  return r;
}

export function allEnvs(r: TeamReplica, now: number): unknown[] {
  return [...r.log.logged(), ...r.liveEphemeral(now)].map((op) => op.env);
}

/** Admin `by` adds `d` with `role` directly (m.add). */
export function addMember(
  by: TeamReplica,
  d: Device,
  role: Role,
  now: number,
  groups?: GroupLink[],
): SignedOp {
  const key = by.sendKey();
  if (!key) throw new Error('no send key');
  return by.control(
    now,
    'm.add',
    addMemberBody(c, by.teamId, targetOf(d), role, key, groups ? { groups } : {}),
  );
}

/** Two-way full exchange between replicas (what a sync session converges to). */
export function exchange(a: TeamReplica, b: TeamReplica, now: number): void {
  b.ingest(allEnvs(a, now), now);
  a.ingest(allEnvs(b, now), now);
}

export function invite(
  by: TeamReplica,
  now: number,
  options: Partial<Parameters<typeof createInvite>[2]> = {},
) {
  const inv = createInvite(c, by.teamId, {
    expiresAt: now + 2 * DAY,
    maxUses: 1,
    role: 'member',
    ...options,
  });
  const op = by.control(now, 'i.create', inv.body);
  return { ...inv, op };
}

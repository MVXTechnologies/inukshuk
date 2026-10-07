import { fromB64uLen, toB64u } from './bytes';
import type { Json } from './canonical';
import { KEY_BYTES, type DeviceKeys, type TeamCrypto } from './crypto';
import { buildOp, type Encryption, type OpDraft, type OpType, type SignedOp } from './envelope';
import { hlcObserve, hlcTick, MAX_CLOCK_LEAD_MS, type Hlc } from './hlc';

import { deriveTeamId, memberIdOf } from './ids';
import {
  encodeInvite,
  inviteIdOf,
  INVITE_SEED_BYTES,
  type InviteChannel,
  type InviteToken,
  type JoinProof,
} from './invite';
import { newTeamKey, wrapKeys, type TeamKey, type WrapTarget } from './keys';
import { DEFAULT_TEAM_LIFETIME_MS, type MemberState } from './membership';
import type { Audience, GroupLink, Priority, Role } from './roles';

/** What a device persists per team to keep writing where it left off. */
export interface WriterCursor {
  seq: number;
  hlc: Hlc;
  /** Id of the last logged op written (the chain head). */
  prev?: string;
}

/**
 * Op builders (#589): the bodies `membership.ts` validates, produced in one
 * place so app code never hand-writes protocol JSON.
 *
 * An {@link OpWriter} owns one device's per-team `seq` counter, chain head
 * (`prev`, the id of its last logged op) and HLC. The data layer must persist
 * all three and restore them on launch: reusing a `seq` or forking the chain
 * would look like equivocation to every peer.
 */
export class OpWriter {
  constructor(
    private readonly c: TeamCrypto,
    readonly keys: DeviceKeys,
    readonly teamId: string,
    private seq = 0,
    private clock: Hlc = { wall: 0, counter: 0 },
    private prev?: string,
  ) {}

  get id(): string {
    return memberIdOf(this.keys.signPublic);
  }

  /** Persist after every write. */
  get cursor(): WriterCursor {
    return this.prev === undefined
      ? { seq: this.seq, hlc: this.clock }
      : { seq: this.seq, hlc: this.clock, prev: this.prev };
  }

  /**
   * Advance past a peer's stamp. Call only for ops the fold accepted, and
   * never further than `now + MAX_CLOCK_LEAD_MS` (review M1): one op stamped
   * at the edge of the skew window must not drag this device's clock forward
   * and get its later ops refused as "too far ahead".
   */
  observe(remote: Hlc, now: number): void {
    this.clock = hlcObserve(this.clock, remote, now, MAX_CLOCK_LEAD_MS);
  }

  private stamp(now: number): Hlc {
    this.clock = hlcTick(this.clock, now);
    return this.clock;
  }

  /** A logged op (control or data): takes the next seq. */
  write(now: number, draft: Omit<OpDraft, 'sq' | 'hlc'>): SignedOp {
    this.seq += 1;
    const op = buildOp(
      this.c,
      { keys: this.keys, teamId: this.teamId },
      {
        ...draft,
        sq: this.seq,
        ...(this.prev !== undefined ? { pv: this.prev } : {}),
        hlc: this.stamp(now),
      },
    );
    this.prev = op.id;
    return op;
  }

  /** An ephemeral op (seq 0, TTL). */
  ephemeral(now: number, draft: Omit<OpDraft, 'sq' | 'hlc'>): SignedOp {
    return buildOp(
      this.c,
      { keys: this.keys, teamId: this.teamId },
      {
        ...draft,
        sq: 0,
        hlc: this.stamp(now),
      },
    );
  }

  control(now: number, t: OpType, b: Json, labels?: { secret: Json; key: TeamKey }): SignedOp {
    return this.write(now, {
      t,
      b,
      ...(labels
        ? {
            secret: labels.secret,
            enc: { mode: 'group', keyId: labels.key.keyId, key: labels.key.key },
          }
        : {}),
    });
  }

  data(
    now: number,
    t: 'e.set' | 'e.del' | 'msg',
    secret: Json,
    enc: Encryption,
    extra: { aud?: Audience; pr?: Priority } = {},
  ): SignedOp {
    return this.write(now, { t, secret, enc, ...extra });
  }
}

export function targetOf(m: Pick<MemberState, 'id' | 'x'>): WrapTarget {
  return { memberId: m.id, boxPublic: fromB64uLen(m.x, KEY_BYTES)! };
}

export interface NewTeam {
  teamId: string;
  genesis: SignedOp;
  key: TeamKey;
  writer: OpWriter;
}

/** Found a team: the owner's genesis op (with the first team key wrapped for themselves). */
export function createTeam(
  c: TeamCrypto,
  owner: DeviceKeys,
  now: number,
  options: { lifetimeMs?: number; name?: string } = {},
): NewTeam {
  const nonce = c.randomBytes(16);
  const teamId = deriveTeamId(c, owner.signPublic, nonce);
  const writer = new OpWriter(c, owner, teamId);
  const key = newTeamKey(c);
  const id = memberIdOf(owner.signPublic);
  const kw = wrapKeys(c, teamId, [key], [{ memberId: id, boxPublic: owner.boxPublic }]);
  const genesis = writer.control(
    now,
    'm.genesis',
    {
      nonce: toB64u(nonce),
      x: toB64u(owner.boxPublic),
      exp: Math.floor(now) + (options.lifetimeMs ?? DEFAULT_TEAM_LIFETIME_MS),
      kw: kw as unknown as Json,
    },
    options.name === undefined ? undefined : { secret: { name: options.name }, key },
  );
  return { teamId, genesis, key, writer };
}

const groupsJson = (groups: readonly GroupLink[] | undefined): Json | undefined =>
  groups === undefined || groups.length === 0 ? undefined : (groups as unknown as Json);

/** `m.add` body: an admin adds a device it has in front of it (e.g. QR the other way). */
export function addMemberBody(
  c: TeamCrypto,
  teamId: string,
  target: WrapTarget,
  role: Role,
  sendKey: TeamKey,
  options: { groups?: GroupLink[]; from?: number } = {},
): Json {
  const b: Record<string, Json> = {
    m: target.memberId,
    x: toB64u(target.boxPublic),
    r: role,
    kw: wrapKeys(c, teamId, [sendKey], [target]) as unknown as Json,
  };
  const g = groupsJson(options.groups);
  if (g !== undefined) b['g'] = g;
  if (options.from !== undefined) b['from'] = options.from;
  return b;
}

/** `m.admit` body from a verified join request. */
export function admitBody(c: TeamCrypto, teamId: string, proof: JoinProof, sendKey: TeamKey): Json {
  const target = { memberId: proof.m, boxPublic: fromB64uLen(proof.x, KEY_BYTES)! };
  return { ...proof, kw: wrapKeys(c, teamId, [sendKey], [target]) as unknown as Json };
}

/** `k.rotate` body: a fresh key wrapped for every given (active) member. */
export function rotateBody(
  c: TeamCrypto,
  teamId: string,
  members: readonly Pick<MemberState, 'id' | 'x'>[],
): { body: Json; key: TeamKey } {
  const key = newTeamKey(c);
  return {
    body: { kw: wrapKeys(c, teamId, [key], members.map(targetOf)) as unknown as Json },
    key,
  };
}

/** `k.share` body: re-wrap keys we hold for members who missed them. */
export function shareBody(
  c: TeamCrypto,
  teamId: string,
  keys: readonly TeamKey[],
  members: readonly Pick<MemberState, 'id' | 'x'>[],
): Json {
  return { kw: wrapKeys(c, teamId, keys, members.map(targetOf)) as unknown as Json };
}

export interface InviteOptions {
  expiresAt: number;
  maxUses: number;
  role: 'member' | 'guest';
  groups?: GroupLink[];
  /** Who may admit with it: any member (default) or only an admin. */
  approve?: 'any' | 'admin';
}

/** A fresh invite: the `i.create` body for the log and the token to send. */
export function createInvite(
  c: TeamCrypto,
  teamId: string,
  options: InviteOptions,
): { body: Json; token: InviteToken; encode: (channel: InviteChannel) => string } {
  const token: InviteToken = {
    teamId,
    seed: c.randomBytes(INVITE_SEED_BYTES),
    expiresAt: Math.floor(options.expiresAt / 1000) * 1000,
  };
  const b: Record<string, Json> = {
    inv: inviteIdOf(c, token),
    exp: token.expiresAt,
    max: options.maxUses,
    r: options.role,
    ap: options.approve ?? 'any',
  };
  const g = groupsJson(options.groups);
  if (g !== undefined) b['g'] = g;
  return { body: b, token, encode: (channel) => encodeInvite(token, channel) };
}

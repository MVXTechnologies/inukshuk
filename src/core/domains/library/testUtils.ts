/**
 * TEST-ONLY: a light, deterministic library group for fold-level tests. Ops
 * are unsigned stand-ins (the fold only reads `env.t`, `env.au`, the stamp and
 * the decoded body), authors have fixed roles, and each "phone" keeps its own
 * HLC and the op ids it knows, so tests can stage offline edits and syncs.
 * The signed path is covered by `replica.test.ts` with real crypto.
 */
import type { Json } from '@core/team/canonical';
import { applyDataOp, emptyData, reduceData, type TeamData } from '@core/team/data';
import type { SignedOp } from '@core/team/envelope';
import { hlcObserve, hlcTick, type Hlc } from '@core/team/hlc';
import { compareOps, type TeamState } from '@core/team/membership';
import type { Role } from '@core/team/roles';
import { GMETA, GROUP_RECORD_ID } from '@core/group/meta';

import { libraryRegistry } from './index';
import { buildHistory, historyOps, type LibraryHistory } from './history';
import { libraryView, type LibraryView } from './tree';
import type { DelBody, SetBody } from './writes';

/** 2026-10-07T12:00Z. */
export const T0 = Date.UTC(2026, 9, 7, 12);
export const MIN = 60_000;
export const DAY = 24 * 60 * MIN;

/** A member id (43 base64url chars) from a short tag. */
export const mid = (tag: string): string => tag.padEnd(43, 'A');
/** A group id (22 base64url chars). */
export const gid = (tag: string): string => tag.padEnd(22, 'A');

export const OWNER = mid('own');
export const ROOT = 'root';

/** One phone of the simulated group: its author id, clock and known ops. */
export interface Phone {
  id: string;
  hlc: Hlc;
  known: Set<string>;
}

export class LibSim {
  readonly ops = new Map<string, SignedOp>();
  readonly bodies = new Map<string, Json>();
  readonly roles = new Map<string, Role>();
  readonly phones = new Map<string, Phone>();
  private seq = 0;

  constructor(members: Readonly<Record<string, Role>> = {}) {
    this.join(OWNER, 'owner');
    for (const [id, role] of Object.entries(members)) this.join(id, role);
  }

  join(id: string, role: Role): Phone {
    this.roles.set(id, role);
    const p: Phone = { id, hlc: { wall: 0, counter: 0 }, known: new Set() };
    this.phones.set(id, p);
    return p;
  }

  phone(id: string): Phone {
    const p = this.phones.get(id);
    if (p === undefined) throw new Error(`no phone ${id}`);
    return p;
  }

  /** `author` writes an op at local time `now`; it knows it at once. */
  write(author: string, now: number, t: 'e.set' | 'e.del', body: Json): SignedOp {
    const p = this.phone(author);
    p.hlc = hlcTick(p.hlc, now);
    this.seq += 1;
    const id = `op${String(this.seq).padStart(6, '0')}`;
    const op = {
      id,
      env: { t, au: author },
      stamp: { wall: p.hlc.wall, counter: p.hlc.counter, author },
      bytes: 0,
    } as unknown as SignedOp;
    this.ops.set(id, op);
    this.bodies.set(id, body);
    p.known.add(id);
    return op;
  }

  set(author: string, now: number, body: SetBody): SignedOp {
    return this.write(author, now, 'e.set', body as unknown as Json);
  }

  del(author: string, now: number, body: DelBody): SignedOp {
    return this.write(author, now, 'e.del', body as unknown as Json);
  }

  /** The owner's `gmeta`: a library group rooted at `root`. */
  meta(now: number, root = ROOT): SignedOp {
    return this.set(OWNER, now, { k: GMETA, id: GROUP_RECORD_ID, f: { app: 'lib', v: 1, root } });
  }

  /** `to` learns everything `from` knows (and its clock moves past it). */
  deliver(from: string, to: string, now: number): void {
    const a = this.phone(from);
    const b = this.phone(to);
    for (const id of a.known) {
      if (b.known.has(id)) continue;
      b.known.add(id);
      b.hlc = hlcObserve(b.hlc, this.ops.get(id)!.stamp, now);
    }
  }

  /** Everyone learns everything. */
  syncAll(now: number): void {
    const ids = [...this.phones.keys()];
    for (const a of ids) for (const b of ids) if (a !== b) this.deliver(a, b, now);
    for (const a of ids) for (const b of ids) if (a !== b) this.deliver(a, b, now);
  }

  /** A resolved-state stand-in over some ops, in fold order. */
  state(ids: Iterable<string> = this.ops.keys()): TeamState {
    const data = [...ids].map((id) => this.ops.get(id)!).sort(compareOps);
    const roleAt = new Map(data.map((op) => [op.id, this.roles.get(op.env.au)!]));
    // The group was born a day before the tests' clock (gmeta may not predate it).
    const genesis = { stamp: { wall: T0 - DAY, counter: 0, author: OWNER } };
    return { data, roleAt, genesis } as unknown as TeamState;
  }

  readonly decode = (op: SignedOp): Json | undefined => this.bodies.get(op.id);

  /** Fold some ops (default: all) as a phone would. */
  fold(ids?: Iterable<string>): TeamData {
    return reduceData(this.state(ids), this.decode, libraryRegistry());
  }

  /** Fold one op at a time into one view (the replica's incremental path). */
  foldIncremental(ids?: Iterable<string>): TeamData {
    const state = this.state(ids);
    const out = emptyData();
    for (const op of state.data) applyDataOp(out, state, op, this.decode, libraryRegistry());
    return out;
  }

  /** What phone `id` sees: its data, tree and history. */
  look(id?: string): { data: TeamData; view: LibraryView; history: LibraryHistory } {
    const ids = id === undefined ? undefined : this.phone(id).known;
    const state = this.state(ids);
    const data = reduceData(state, this.decode, libraryRegistry());
    return {
      data,
      view: libraryView(data),
      history: buildHistory(historyOps(state, data, this.decode)),
    };
  }

  /** Why the fold skipped op `id` (undefined: kept). */
  why(id: string, ids?: Iterable<string>): string | undefined {
    return this.fold(ids).skipped.find((s) => s.id === id)?.why;
  }
}

/** A canonical, order-free text of a tree (for convergence checks). */
export function canonicalView(v: LibraryView): string {
  const nodes = [...v.folders.values(), ...v.items.values()]
    .map((n) => ({ ...n, fields: Object.fromEntries(Object.entries(n.fields).sort()) }))
    .sort((a, b) => (`${a.kind}:${a.id}` < `${b.kind}:${b.id}` ? -1 : 1));
  const children = [...v.children.entries()]
    .map(([k, list]) => [k, list.map((n) => `${n.kind}:${n.id}`)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const repaired = [...v.repaired.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return JSON.stringify({ root: v.root, nodes, children, repaired });
}

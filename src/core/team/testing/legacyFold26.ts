/**
 * TEST-ONLY: the 2.6.1 data fold, frozen verbatim (`data.ts` `applyDataOp`
 * at `integ/2.6.1` @ 62a4d267, before the sync-group registry seam of 2.7.0
 * PR G1). It is the oracle of the seam's golden and property tests, and the
 * fold of the simulated 2.6 phone in the mixed-version tests: a kind it does
 * not know is skipped as `invalid` (stored, relayed, chain intact).
 *
 * It calls today's parsers and record rules (`parseSetBody`, `authorizeRecord`,
 * `validTaskFields`…), so it pins the DISPATCH (which rule runs for which op,
 * in which order, with which skip reason), not those rules themselves: they
 * have their own suites. Never edit it to make a test pass.
 */
import type { Json } from '../canonical';
import {
  deleteOp,
  dict,
  isLive,
  mergeEntity,
  mergeRegister,
  setOp,
  type EntityState,
  visibleFields,
} from '../crdt';
import {
  entityKey,
  GUEST_KINDS,
  OWNED_KINDS,
  parseDelBody,
  parseMsgBody,
  parsePosBody,
  parseSetBody,
  type Decode,
  type EntityKind,
  type EntityRecord,
  type PosBody,
  type TeamData,
} from '../data';
import type { SignedOp } from '../envelope';
import type { TeamState } from '../membership';
import { isAdminRole, parseAudience } from '../roles';
import { authorizeRecord, RECORD_KINDS, reindex, type RecordKind, vertexTrail } from '../records';
import { isTaskStatusUpdate, validTaskFields } from '../tasks';

export function legacyApplyDataOp(
  out: TeamData,
  state: TeamState,
  op: SignedOp,
  decode: Decode,
): void {
  const merge = (key: string, rec: Omit<EntityRecord, 'state'>, patch: EntityState) => {
    const prev = out.entities.get(key);
    const next = prev
      ? { ...prev, state: mergeEntity(prev.state, patch) }
      : { ...rec, state: patch };
    out.entities.set(key, next);
    if (next.kind === 'trl' || next.kind === 'tve' || next.kind === 'sos' || next.kind === 'drw')
      reindex(out.index, next, prev?.state);
  };
  const { env, stamp } = op;
  // Authority is the author's role at the op's position in the fold (review M4).
  const role = state.roleAt.get(op.id);
  const forbid = () => {
    out.skipped.push({ id: op.id, why: 'forbidden' });
  };
  const body = decode(op);
  if (body === undefined) {
    out.skipped.push({ id: op.id, why: 'undecryptable' });
    return;
  }
  switch (env.t) {
    case 'e.set': {
      const b = parseSetBody(body);
      if (!b) break;
      // Fail closed: every accepted data op has a role; guests write comments only.
      if (role === undefined || (role === 'guest' && !GUEST_KINDS.includes(b.k))) return forbid();
      if (b.k === 'task') {
        if (!validTaskFields(b.f, env.au)) break;
        const owner = b.o ?? env.au;
        const key = entityKey('task', b.id, owner);
        if (owner !== env.au) {
          // Someone else's task: it must exist (nobody, admins included, creates a
          // task in another member's name); then an admin writes any field, the
          // current assignee only the status.
          const cur = out.entities.get(key);
          if (cur === undefined || !isLive(cur.state)) return forbid();
          const assignee = visibleFields(cur.state)['assignee'];
          if (!isAdminRole(role) && (assignee !== env.au || !isTaskStatusUpdate(b.f)))
            return forbid();
        }
        merge(key, { kind: 'task', id: b.id, owner }, setOp(b.f, stamp));
        return;
      }
      if ((RECORD_KINDS as readonly string[]).includes(b.k)) {
        const r = authorizeRecord(
          { kind: b.k as RecordKind, id: b.id, o: b.o, f: b.f, author: env.au, role },
          (kind, id, o) => out.entities.get(entityKey(kind as EntityKind, id, o)),
          out.index,
          stamp.wall,
        );
        if (r === 'invalid') break;
        if (r === 'forbidden') return forbid();
        const rrec: Omit<EntityRecord, 'state'> = { kind: b.k, id: b.id };
        if (r.owner) rrec.owner = r.owner;
        merge(entityKey(b.k, b.id, r.owner), rrec, setOp(b.f, stamp));
        return;
      }
      const owner = OWNED_KINDS.includes(b.k) ? env.au : undefined;
      const rec: Omit<EntityRecord, 'state'> = { kind: b.k, id: b.id };
      if (owner) rec.owner = owner;
      merge(entityKey(b.k, b.id, owner), rec, setOp(b.f, stamp));
      return;
    }
    case 'e.del': {
      const b = parseDelBody(body);
      if (!b) break;
      const owned = OWNED_KINDS.includes(b.k);
      const owner = owned ? (b.o ?? env.au) : undefined;
      if (role === undefined || (role === 'guest' && !GUEST_KINDS.includes(b.k))) return forbid();
      // A resolution is reopened (res: false), never deleted.
      if (b.k === 'mres') return forbid();
      // Trail vertices: any member deletes one of a live trail (`o` = its owner).
      const vertex =
        b.k === 'tve' &&
        owner !== undefined &&
        (() => {
          const tr = vertexTrail(b.id);
          const t = tr === null ? undefined : out.entities.get(entityKey('trl', tr, owner));
          return t !== undefined && isLive(t.state);
        })();
      if (b.k === 'tve' && !vertex) return forbid();
      if (owned && owner !== env.au && !isAdminRole(role) && !vertex) return forbid();
      const rec: Omit<EntityRecord, 'state'> = { kind: b.k, id: b.id };
      if (owner) rec.owner = owner;
      merge(entityKey(b.k, b.id, owner), rec, deleteOp(stamp));
      return;
    }
    case 'msg': {
      const b = parseMsgBody(body);
      if (!b) break;
      // Only the owner named in a pin thread can root it (review: pin hijack).
      if (b.ll && b.th !== `pin:${env.au}:${b.id}`) break;
      const key = entityKey('msg', b.id, env.au);
      if (out.entities.get(key)?.state.created !== undefined) return; // immutable: first wins
      const fields = dict<Json>([
        ['th', b.th],
        ['tx', b.tx],
      ]);
      if (b.mn) fields['mn'] = b.mn;
      if (b.ll) fields['ll'] = b.ll;
      const rec: Omit<EntityRecord, 'state'> = { kind: 'msg', id: b.id, owner: env.au };
      const aud = env.aud === undefined ? undefined : parseAudience(env.aud);
      if (aud) rec.aud = aud;
      if (env.pr !== undefined) rec.pr = env.pr;
      merge(key, rec, setOp(fields, stamp));
      return;
    }
    case 'pos': {
      const b = parsePosBody(body);
      if (!b) break;
      const reg = { value: b as PosBody & Record<string, Json>, stamp };
      const prev = out.positions.get(env.au);
      out.positions.set(env.au, prev ? mergeRegister(prev, reg) : reg);
      return;
    }
  }
  out.skipped.push({ id: op.id, why: 'invalid' });
}

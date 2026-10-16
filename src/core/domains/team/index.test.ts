/**
 * The sync-group seam's merge gate (2.7.0 PR G1): ZERO behaviour change for
 * the team domain.
 *
 * 1. **Golden refold.** A team log recorded with the pre-seam fold
 *    (`@core/team/testing/golden`) refolds, as each of three viewers and in
 *    three arrival orders, to exactly the canonical view recorded then:
 *    entities, stamps, positions, skip reasons, record index, membership.
 *    The one intended difference: a newer app's kind (`pnm` in the log) is
 *    skipped as `unknown` instead of `invalid` (design §5.1).
 * 2. **Oracle.** The same, against the frozen 2.6.1 fold (`legacyFold26`) on
 *    the same folded state.
 * 3. **Property.** Seeded random workloads over every kind (valid, invalid,
 *    forbidden, unknown, and the 2.7.0 kinds), with fully seeded crypto: the
 *    new fold of every 2.6 kind equals the 2.6.1 fold, incrementally and on a
 *    full refold.
 */
import type { Json } from '@core/team/canonical';
import { toB64u } from '@core/team/bytes';
import { generateDeviceKeys, type DeviceKeys, type TeamCrypto } from '@core/team/crypto';
import { addMemberBody, createTeam, targetOf } from '@core/team/actions';
import {
  emptyData,
  ENTITY_KINDS,
  parseKindWrite,
  reduceData,
  type TeamData,
} from '@core/team/data';
import type { SignedOp } from '@core/team/envelope';
import { memberIdOf } from '@core/team/ids';
import type { TeamState } from '@core/team/membership';
import { GroupReplica, TeamReplica } from '@core/team/replica';
import type { Role } from '@core/team/roles';
import { canonicalText } from '@core/team/testing/golden/canon';
import { replay, REPLAYS, VIEWERS, viewText, type Viewer } from '@core/team/testing/golden/load';
import type { RecordedLog } from '@core/team/testing/golden/teamLog26';
import { legacyApplyDataOp } from '@core/team/testing/legacyFold26';
import { int, mulberry32, pick, type Rng } from '@core/team/testing/prop';
import { seededCrypto } from '@core/team/testing/seeded';
import { MIN, T0 } from '@core/team/testing/fixtures';
import { capBody } from '@core/teamdraw/caps';
import { arrowFields } from '@core/teamdraw/testUtils';
import { encodePolyline } from '@core/trails/polyline';
import { GMETA, groupPlugin, IRDV, NET } from '@core/group/meta';

import { TEAM_V27_KINDS } from './groupKinds';
import { TEAM_DOMAIN, TEAM_KINDS_V26, teamPlugin, teamRegistry } from './index';

const LOG = require('@core/team/testing/golden/teamLog26.json') as RecordedLog;
const EXPECTED = require('@core/team/testing/golden/teamLog26.expected.json') as Record<
  Viewer,
  { skipped: { id: string; why: string }[]; entities: unknown[] }
>;

/** The 2.6.1 fold of a resolved state (the oracle). */
function legacyReduce(state: TeamState, decode: (op: SignedOp) => Json | undefined): TeamData {
  const out = emptyData();
  for (const op of state.data) legacyApplyDataOp(out, state, op, decode);
  return out;
}

/** Record writes whose kind no domain registers (a newer app's), by op id. */
function unknownKindOps(r: TeamReplica): Set<string> {
  const out = new Set<string>();
  for (const op of r.state.data) {
    if (op.env.t !== 'e.set' && op.env.t !== 'e.del') continue;
    // A well-formed write (else it stays `invalid`, before and after the seam).
    const b = parseKindWrite(op.env.t, r.decode(op));
    if (b !== undefined && teamRegistry().forKind(b.k) === undefined) out.add(op.id);
  }
  return out;
}

/** The pre-seam text with the one intended change: unknown kinds say so. */
function relabel(text: string, unknown: ReadonlySet<string>): string {
  const v = JSON.parse(text) as { skipped: { id: string; why: string }[] };
  for (const s of v.skipped) if (unknown.has(s.id) && s.why === 'invalid') s.why = 'unknown';
  return JSON.stringify(v);
}

describe('golden refold: a recorded 2.6.1 team log folds exactly as before the seam', () => {
  it('the recording is substantial (every kind, every skip reason, three viewers)', () => {
    expect(LOG.envs.length).toBeGreaterThanOrEqual(70);
    const owner = EXPECTED.owner;
    expect(owner.entities.length).toBeGreaterThanOrEqual(30);
    const why = new Set(owner.skipped.map((s) => s.why));
    expect(why).toEqual(new Set(['invalid', 'forbidden']));
    expect(new Set(EXPECTED.guest.skipped.map((s) => s.why))).toContain('undecryptable');
  });

  for (const v of VIEWERS) {
    for (const how of REPLAYS) {
      it(`${v}, ${how}: identical canonical view (only change: a newer app's kind says unknown)`, () => {
        const seeds = how === 'shuffled' ? [1, 2, 3] : [1];
        for (const seed of seeds) {
          const r = replay(LOG, v, how, seed);
          // Reading the view folds anything a coalesced refold deferred.
          const text = viewText(r, LOG.now);
          const unknown = unknownKindOps(r);
          // The log holds two newer-app ops (a 2.7 note, then its delete) every viewer reads.
          expect(unknown.size).toBe(2);
          expect(text).toBe(relabel(JSON.stringify(EXPECTED[v]), unknown));
        }
      });
    }
  }

  it('the frozen 2.6.1 fold of the same state gives the same view (the oracle)', () => {
    for (const v of VIEWERS) {
      const r = replay(LOG, v, 'batch');
      const data = r.data(LOG.now);
      const legacy = legacyReduce(r.state, (op) => r.decode(op));
      legacy.positions = data.positions;
      expect(canonicalText(r.state, data)).toBe(
        relabel(canonicalText(r.state, legacy), unknownKindOps(r)),
      );
      // And reduceData (the replica-free fold) agrees with the replica's view.
      const fresh = reduceData(r.state, (op) => r.decode(op), teamRegistry());
      fresh.positions = data.positions;
      expect(canonicalText(r.state, fresh)).toBe(canonicalText(r.state, data));
    }
  });
});

// ── Property: random workloads, seeded end to end ───────────────────────────

interface Dev {
  keys: DeviceKeys;
  id: string;
  x: string;
}

function seededWorld(seed: number) {
  const cs: TeamCrypto = seededCrypto(seed);
  const dev = (): Dev => {
    const keys = generateDeviceKeys(cs);
    return { keys, id: memberIdOf(keys.signPublic), x: toB64u(keys.boxPublic) };
  };
  const owner = dev();
  const team = createTeam(cs, owner.keys, T0);
  const root = new GroupReplica(cs, team.teamId, owner.keys, team.writer.cursor);
  root.addKey(team.key);
  root.ingest([team.genesis.env], T0);
  const roles: Role[] = ['admin', 'member', 'member', 'guest'];
  const devs = roles.map((role, i) => {
    const d = dev();
    root.control(T0 + 1 + i, 'm.add', addMemberBody(cs, team.teamId, targetOf(d), role, team.key));
    return d;
  });
  const envs = (r: GroupReplica, now: number) =>
    [...r.log.logged(), ...r.liveEphemeral(now)].map((op) => op.env);
  const replicas = [
    root,
    ...devs.map((d) => {
      const r = new GroupReplica(cs, team.teamId, d.keys);
      r.ingest(envs(root, T0 + 10), T0 + 10);
      return r;
    }),
  ];
  const ids = [owner.id, ...devs.map((d) => d.id)];
  /** What `to` does not hold yet (as anti-entropy sends: no re-verifying held ops). */
  const missing = (from: GroupReplica, to: GroupReplica, now: number) =>
    [...from.log.logged(), ...from.liveEphemeral(now)]
      .filter((op) => to.log.get(op.id) === undefined)
      .map((op) => op.env);
  const sync = (now: number) => {
    for (const r of replicas) root.ingest(missing(r, root, now), now);
    for (const r of replicas) r.ingest(missing(root, r, now), now);
  };
  return { cs, teamId: team.teamId, owner, root, replicas, ids, sync, envs };
}

const ID_POOL = ['a', 'b', 'tl', 'tl_b0', 'tl_b1', 'tl_x1', 'm1', 'g', 's1'];
const CHILD = 'AAAAAAAAAAAAAAAAAAAAAA';
const PTS: [number, number][] = [
  [-71.2167, 46.8025],
  [-71.2067, 46.8085],
  [-71.1967, 46.8125],
];

/** One random write: often valid, often not, sometimes of a kind nobody knows. */
function randomWrite(
  rnd: Rng,
  author: string,
  ids: string[],
  now: number,
): ['e.set' | 'e.del' | 'msg', Json] {
  const id = pick(rnd, ID_POOL);
  const other = pick(rnd, ids);
  const o = rnd() < 0.25 ? other : undefined;
  const roll = rnd();
  if (roll < 0.15) {
    const th = pick(rnd, [
      'team',
      `dm:${other}`,
      `pin:${author}:${id}`,
      `pin:${other}:${id}`,
      'bad th',
    ]);
    const body: Record<string, Json> = { id, th, tx: 'hello' };
    if (th.startsWith('pin:') && rnd() < 0.6) body['ll'] = PTS[0]!;
    if (rnd() < 0.2) body['mn'] = [other];
    return ['msg', body];
  }
  const kinds = [...ENTITY_KINDS, ...TEAM_V27_KINDS, GMETA, IRDV, NET, 'pnm', 'zzz'];
  const k = pick(rnd, kinds);
  if (roll < 0.3) {
    const body: Record<string, Json> = { k, id };
    if (o !== undefined) body['o'] = o;
    return ['e.del', body];
  }
  const f: Record<string, Json> = (() => {
    switch (k) {
      case 'task':
        return pick<Record<string, Json>>(rnd, [
          { title: 'Scout', assignee: other },
          { done: true, dby: author, dat: now },
          { done: false, dby: null, dat: null },
          { title: '' },
        ]);
      case 'trl':
        return pick<Record<string, Json>>(rnd, [
          { name: 'Ridge', base: encodePolyline(PTS) },
          { color: '#FF8800' },
          { base: encodePolyline(PTS.slice(0, 2)) },
          { color: 'red' },
        ]);
      case 'tve':
        return pick<Record<string, Json>>(rnd, [
          { to: other, tr: 'tl', la: 46.81, lo: -71.21 },
          { to: author, tr: 'tl', la: 46.81, lo: -71.21, k: 'h0000s' },
          { to: other, tr: 'zz', la: 99, lo: 0 },
        ]);
      case 'sos':
        return pick<Record<string, Json>>(rnd, [
          { la: 46.8, lo: -71.2, tx: 'help' },
          { res: true, rby: author, rat: now },
          { la: 46.8, lo: -71.2, res: false, rby: null, rat: null },
          { tx: 'x'.repeat(300) },
        ]);
      case 'rly':
        return pick<Record<string, Json>>(rnd, [
          { la: 46.8, lo: -71.2, r: 50 },
          { tx: 'move' },
          { r: 5 },
        ]);
      case 'mres':
        return pick<Record<string, Json>>(rnd, [
          { res: true, rby: author, rat: now },
          { res: true, rby: other, rat: 1 },
        ]);
      case 'drw':
        return pick<Record<string, Json>>(rnd, [
          arrowFields(now, 5 * MIN),
          { tx: 'note' },
          arrowFields(now, null),
        ]);
      case 'cap':
        return pick<Record<string, Json>>(rnd, [capBody(author, now).f, { pen: -1 }]);
      case 'rcp':
        return pick<Record<string, Json>>(rnd, [
          { ak: 'sos', ao: other },
          { ak: 'rly', ao: other },
          { ak: 'wpt', ao: other },
        ]);
      case 'comment':
        return { photoId: 'ph', text: 'nice' };
      case GMETA:
        return pick<Record<string, Json>>(rnd, [
          { app: 'lib' },
          { app: 'team', net: 1 },
          { net: 2 },
        ]);
      case 'gref':
        return { app: 'lib', name: 'Maps' };
      case 'irdv':
        return { s: other };
      case 'net':
        return pick<Record<string, Json>>(rnd, [{ inet: 1 }, { inet: 0 }, { inet: 5 }]);
      default:
        return pick<Record<string, Json>>(rnd, [
          { name: `n${int(rnd, 0, 9)}` },
          { n: int(rnd, 0, 99) },
          { '9x': 1 },
        ]);
    }
  })();
  const kid =
    k === 'tve'
      ? pick(rnd, ['tl_b0', 'tl_b1', 'tl_x1'])
      : k === 'gref'
        ? CHILD
        : k === 'irdv'
          ? other
          : id;
  const body: Record<string, Json> = { k, id: kid, f };
  if (o !== undefined) body['o'] = o;
  return ['e.set', body];
}

const V26 = new Set<string>(TEAM_KINDS_V26);

/** The canonical text of a view restricted to the 2.6 kinds (and the ops that wrote them). */
function v26Text(r: GroupReplica, data: TeamData, newKindOps: ReadonlySet<string>): string {
  const out = emptyData();
  for (const [k, rec] of data.entities) if (V26.has(rec.kind)) out.entities.set(k, rec);
  out.positions = data.positions;
  out.skipped = data.skipped.filter((s) => !newKindOps.has(s.id));
  out.index = data.index;
  return canonicalText(r.state, out);
}

/** Ops writing a kind a 2.6 phone does not know, by id, split into registered (2.7) and unknown. */
function newKindOps(r: GroupReplica) {
  const v27 = new Set<string>();
  const unknown = new Set<string>();
  for (const op of r.state.data) {
    if (op.env.t !== 'e.set' && op.env.t !== 'e.del') continue;
    const k = (r.decode(op) as { k?: unknown } | undefined)?.k;
    if (typeof k !== 'string' || V26.has(k)) continue;
    if (teamRegistry().forKind(k) !== undefined) v27.add(op.id);
    // Only a well-formed write of an unknown kind says so; a malformed one stays `invalid`.
    else if (parseKindWrite(op.env.t, r.decode(op)) !== undefined) unknown.add(op.id);
  }
  return { v27, unknown };
}

describe('property: the seam folds every 2.6 kind exactly as the 2.6.1 fold', () => {
  const SEEDS = 40;
  const OPS = 60;

  it(`${SEEDS} seeded workloads × ${OPS} writes: incremental and full refolds match the oracle`, () => {
    let accepted = 0;
    let skippedTotal = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = mulberry32(seed * 7919);
      const w = seededWorld(seed);
      let now = T0 + MIN;
      for (let i = 0; i < OPS; i++) {
        const ri = int(rnd, 0, w.replicas.length - 1);
        const r = w.replicas[ri]!;
        now += 1000;
        const [t, body] = randomWrite(rnd, w.ids[ri]!, w.ids, now);
        r.write(now, t, body);
        // Reads between writes keep the incremental data path busy.
        if (rnd() < 0.3) r.data(now);
        if (rnd() < 0.15) w.sync(now);
      }
      now += 1000;
      w.sync(now);
      for (const r of w.replicas) {
        const data = r.data(now);
        const { v27, unknown } = newKindOps(r);
        const legacy = legacyReduce(r.state, (op) => r.decode(op));
        legacy.positions = data.positions;
        const expected = relabel(v26Text(r, legacy, v27), unknown);
        expect(v26Text(r, data, v27)).toBe(expected);
        // A full refold (a fresh replica fed everything at once) agrees too.
        const fresh = new GroupReplica(w.cs, w.teamId, r.keys);
        fresh.ingest(w.envs(r, now), now);
        expect(v26Text(fresh, fresh.data(now), newKindOps(fresh).v27)).toBe(expected);
        accepted += data.entities.size;
        skippedTotal += data.skipped.length;
      }
    }
    // The workload exercises both outcomes, a lot.
    expect(accepted).toBeGreaterThan(SEEDS * 20);
    expect(skippedTotal).toBeGreaterThan(SEEDS * 20);
  });

  it('a seed replays bit for bit (seeded crypto: same op ids, same view)', () => {
    const run = () => {
      const w = seededWorld(99);
      const rnd = mulberry32(99);
      let now = T0 + MIN;
      for (let i = 0; i < 20; i++) {
        now += 1000;
        const ri = int(rnd, 0, w.replicas.length - 1);
        const [t, body] = randomWrite(rnd, w.ids[ri]!, w.ids, now);
        w.replicas[ri]!.write(now, t, body);
      }
      w.sync(now + 1000);
      return [w.root.log.logged().map((op) => op.id), viewText(w.root, now + 1000)] as const;
    };
    expect(run()).toEqual(run());
  });
});

describe('the team plug-in', () => {
  it('owns the 2.6 kinds and gref; the registry adds the group kinds (gmeta, irdv, net) and is frozen', () => {
    expect(teamPlugin.id).toBe(TEAM_DOMAIN);
    expect(teamPlugin.kinds).toEqual([...ENTITY_KINDS, 'gref']);
    const reg = teamRegistry();
    expect(reg).toBe(teamRegistry());
    expect(reg.isFrozen).toBe(true);
    expect(reg.forKind('wpt')).toBe(teamPlugin);
    expect(reg.forKind('gref')).toBe(teamPlugin);
    expect(reg.forKind(GMETA)?.id).toBe('group');
    expect(reg.forKind('irdv')?.id).toBe('group');
    expect(reg.forKind('net')?.id).toBe('group');
    expect(reg.forKind('pnm')).toBeUndefined();
    expect(reg.forThread(`pin:x:y`)).toBe(teamPlugin);
    expect(reg.forThread('trail:t1')).toBe(teamPlugin);
  });

  it('keys owned kinds by their owner, as entityKey always did', () => {
    for (const k of ENTITY_KINDS) {
      expect(teamPlugin.owned(k)).toBe(
        [
          'tve',
          'task',
          'track',
          'photo',
          'comment',
          'msg',
          'trl',
          'sos',
          'rly',
          'mres',
          'drw',
          'cap',
          'rcp',
        ].includes(k),
      );
    }
    expect(teamPlugin.owned('gref')).toBe(true);
    expect(groupPlugin.owned('irdv')).toBe(true);
    expect(groupPlugin.owned('net')).toBe(false);
  });

  it('alerts ride lane 0, everything else lane 1; it needs the pen capability for strokes', () => {
    expect(teamPlugin.lane?.('sos', {})).toBe(0);
    expect(teamPlugin.lane?.('rly', {})).toBe(0);
    expect(teamPlugin.lane?.('wpt', {})).toBe(1);
    expect(teamPlugin.needsCaps).toEqual(['pen']);
    expect(teamPlugin.ephemeral).toEqual(['pos', 'pen']);
  });

  it('TeamReplica is the GroupReplica (the 2.6 name), and a group takes its own registry', () => {
    expect(TeamReplica).toBe(GroupReplica);
    const r = replay(LOG, 'owner', 'batch');
    expect(r.groupId).toBe(LOG.teamId);
    expect(r.registry).toBe(teamRegistry());
  });
});

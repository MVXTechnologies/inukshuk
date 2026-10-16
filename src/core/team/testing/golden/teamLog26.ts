/**
 * TEST-ONLY: the workload behind the recorded golden team log
 * (`teamLog26.json`), the merge gate of the sync-group seam (2.7.0 PR G1).
 *
 * A six-phone team (owner, admin, two members, a guest, and a member who is
 * removed mid-way) writes every 2.6.1 kind through the real replicas: valid
 * writes, LWW races, assignee and admin task updates, trails with moved,
 * inserted and deleted vertices, SOS raise/resolve with the cooldown,
 * rally points, receipts, resolutions, drawings, capability records, pins,
 * DMs sealed to one member, positions, a removal with its forced rotation,
 * and the rejects the fold must keep rejecting (guest writes, pin hijack,
 * forged task status, bad fields, a deleted resolution, a newer app's kind).
 *
 * The log was recorded ONCE, with the pre-seam fold (2.6.1 `data.ts`,
 * `integ/2.6.1` @ 62a4d267), together with the
 * canonical view each viewer folded from it (`teamLog26.expected.json`).
 * Re-running this generator makes a different log (fresh keys and nonces):
 * never re-record the expected views with post-seam code.
 */
import { toB64u } from '../../bytes';
import type { Json } from '../../canonical';
import type { DeviceKeys } from '../../crypto';
import { activeMembers, cutFor } from '../../membership';
import { rotateBody } from '../../actions';
import { baseKey, keyBetween } from '../../records';
import { TeamReplica } from '../../replica';
import { capBody } from '@core/teamdraw/caps';
import { encodePolyline } from '@core/trails/polyline';
import { drawOn } from '@core/teamdraw/testUtils';

import { addMember, c, device, joinReplica, MIN, newWorld, T0, type Device } from '../fixtures';

export interface RecordedLog {
  teamId: string;
  /** The wall time every viewer folds at. */
  now: number;
  /** Viewer device keys (base64url): the owner, the guest, the removed member. */
  viewers: Record<'owner' | 'guest' | 'removed', Record<keyof DeviceKeys, string>>;
  /** Every envelope any phone held, in a fixed order. */
  envs: unknown[];
}

const b64 = (k: DeviceKeys): Record<keyof DeviceKeys, string> => ({
  signSecret: toB64u(k.signSecret),
  signPublic: toB64u(k.signPublic),
  boxSecret: toB64u(k.boxSecret),
  boxPublic: toB64u(k.boxPublic),
});

const QC: [number, number] = [-71.2167, 46.8025];
const NEAR: [number, number] = [-71.2067, 46.8085];
const FAR: [number, number] = [-71.1967, 46.8125];

export function recordTeamLog26(): RecordedLog {
  const w = newWorld();
  const ann = device();
  const bob = device();
  const eve = device();
  const gus = device();
  const max = device();
  addMember(w.root, ann, 'admin', T0 + 1);
  addMember(w.root, bob, 'member', T0 + 2);
  addMember(w.root, eve, 'member', T0 + 3);
  addMember(w.root, gus, 'guest', T0 + 4);
  addMember(w.root, max, 'member', T0 + 5);
  const join = (d: Device) => joinReplica(w, d, w.root, T0 + 6);
  const ra = join(ann);
  const rb = join(bob);
  const re = join(eve);
  const rg = join(gus);
  const rm = join(max);
  const all = [w.root, ra, rb, re, rg, rm];
  const envsOf = (r: TeamReplica, now: number) =>
    [...r.log.logged(), ...r.liveEphemeral(now)].map((op) => op.env);
  const sync = (now: number) => {
    for (const r of all) w.root.ingest(envsOf(r, now), now);
    for (const r of all) r.ingest(envsOf(w.root, now), now);
  };

  let now = T0 + MIN;
  const step = (ms = 1000) => (now += ms);
  const set = (r: TeamReplica, b: Json, o: Parameters<TeamReplica['write']>[3] = {}) =>
    r.write(step(), 'e.set', b, o);
  const del = (r: TeamReplica, b: Json) => r.write(step(), 'e.del', b);
  const msg = (r: TeamReplica, b: Json, o: Parameters<TeamReplica['write']>[3] = {}) =>
    r.write(step(), 'msg', b, o);

  // ── Capabilities, chat, pins ───────────────────────────────────────────────
  for (const [r, d] of [
    [rb, bob],
    [re, eve],
    [rg, gus],
    [ra, ann],
  ] as const)
    set(r, capBody(d.id, now) as unknown as Json);
  msg(rb, { id: 'm1', th: 'team', tx: 'Leaving the lot', mn: [eve.id] });
  msg(rb, { id: 'p1', th: `pin:${bob.id}:p1`, tx: 'Water here', ll: QC });
  msg(re, { id: 'm2', th: `pin:${bob.id}:p1`, tx: 'Thanks' });
  msg(rg, { id: 'g1', th: 'team', tx: 'Guest here' });
  msg(rb, { id: 'm3', th: 'team', tx: 'Ridge is clear' }, { pr: 1 });
  msg(w.root, { id: 'd1', th: `dm:${bob.id}`, tx: 'Only for Bob' }, { sealedTo: [bob.id] });
  msg(w.root, { id: 'gx', th: 'g:north', tx: 'North crew' });
  // Pin hijack: Eve roots a pin on Bob's thread (invalid).
  msg(re, { id: 'p9', th: `pin:${bob.id}:p9`, tx: 'Mine now', ll: NEAR });
  sync(step());

  // ── Shared and owned plain kinds ───────────────────────────────────────────
  set(rb, { k: 'wpt', id: 'w1', f: { name: 'Camp', la: QC[1], lo: QC[0] } });
  set(rb, { k: 'point', id: 'pt1', f: { n: 1 } });
  set(rb, { k: 'track', id: 'tr1', f: { name: 'Morning loop', len: 4200 } });
  set(rb, { k: 'photo', id: 'ph1', f: { lngLat: QC, at: now } });
  set(rg, { k: 'comment', id: 'c1', f: { photoId: 'ph1', text: 'nice' } });
  set(rg, { k: 'wpt', id: 'w2', f: { name: 'Guest wpt' } }); // forbidden: guest
  sync(step());
  set(re, { k: 'wpt', id: 'w1', f: { name: 'Base camp' } }); // LWW over Bob's name
  set(rb, { k: 'wpt', id: 'w1', f: { name: 'Camp 1' } });
  del(rg, { k: 'wpt', id: 'w1' }); // forbidden: guest
  set(w.root, { k: 'wpt', id: 'bad', f: { '1bad': 1 } }); // invalid field name
  set(w.root, { k: 'wpt', id: 'w3', f: { name: 'x' }, o: bob.id }); // invalid: o on wpt
  del(rb, { k: 'point', id: 'pt1' });
  set(rb, { k: 'point', id: 'pt1', f: { n: 2 } }); // revived after the delete
  sync(step());

  // ── Tasks ─────────────────────────────────────────────────────────────────
  set(rb, { k: 'task', id: 't1', f: { title: 'Scout the ridge', assignee: eve.id } });
  sync(step());
  set(re, { k: 'task', id: 't1', o: bob.id, f: { done: true, dby: eve.id, dat: now } });
  set(re, { k: 'task', id: 't1', o: bob.id, f: { title: 'Mine' } }); // forbidden: not status
  set(ra, { k: 'task', id: 't1', o: bob.id, f: { title: 'Scout the north ridge' } }); // admin
  set(re, { k: 'task', id: 'nope', o: bob.id, f: { done: false, dby: null, dat: null } });
  set(rb, { k: 'task', id: 't2', f: { title: 'Forged', done: true, dby: eve.id, dat: 1 } });
  sync(step());

  // ── Trails and vertices ────────────────────────────────────────────────────
  set(rb, { k: 'trl', id: 'tl1', f: { name: 'Ridge', base: encodePolyline([QC, NEAR, FAR]) } });
  set(rb, { k: 'trl', id: 'tl2', f: { name: 'Bad', color: 'red', base: 'x' } }); // invalid
  sync(step());
  set(re, { k: 'trl', id: 'tl1', o: bob.id, f: { color: '#FF8800' } });
  set(re, { k: 'trl', id: 'tl1', o: bob.id, f: { base: encodePolyline([QC, FAR]) } }); // forbidden
  set(re, { k: 'tve', id: 'tl1_b0', f: { to: bob.id, tr: 'tl1', la: 46.803, lo: -71.216 } });
  const k = keyBetween(baseKey(0), baseKey(1));
  if (k === null) throw new Error('no key');
  set(re, { k: 'tve', id: 'tl1_x1', f: { to: bob.id, tr: 'tl1', k, la: 46.805, lo: -71.21 } });
  del(re, { k: 'tve', id: 'tl1_b2', o: bob.id });
  del(rg, { k: 'tve', id: 'tl1_b1', o: bob.id }); // forbidden: guest
  sync(step());

  // ── Alerts: SOS, rally, receipts, resolutions ──────────────────────────────
  set(re, { k: 'sos', id: 's1', f: { la: 46.81, lo: -71.21, tx: 'Ankle' } });
  set(re, { k: 'sos', id: 's2', f: { la: 46.81, lo: -71.21, tx: 'Second' } }); // one open
  set(rb, { k: 'rly', id: 'r1', f: { la: NEAR[1], lo: NEAR[0], tx: 'Meet', r: 50 } });
  sync(step());
  set(rb, { k: 'rcp', id: 's1', f: { ak: 'sos', ao: eve.id } });
  set(rg, { k: 'rcp', id: 'r1', f: { ak: 'rly', ao: bob.id } });
  set(re, { k: 'rcp', id: 's1', f: { ak: 'sos', ao: eve.id } }); // invalid: own alert
  set(ra, { k: 'sos', id: 's1', o: eve.id, f: { res: true, rby: ann.id, rat: now } });
  set(re, { k: 'mres', id: 'm1', o: bob.id, f: { res: true, rby: eve.id, rat: now } });
  set(rg, { k: 'mres', id: 'm3', o: bob.id, f: { res: true, rby: gus.id, rat: now } }); // forbidden
  del(re, { k: 'mres', id: 'm1', o: bob.id }); // forbidden: never deleted
  sync(step());
  set(re, { k: 'sos', id: 's3', f: { la: 46.82, lo: -71.22 } }); // cooldown: forbidden
  sync(step(2 * MIN));
  set(re, { k: 'sos', id: 's1', f: { la: 46.82, lo: -71.22, res: false, rby: null, rat: null } });
  sync(step());

  // ── Drawings ──────────────────────────────────────────────────────────────
  drawOn(rb, step(), 'a1', null);
  set(rb, { k: 'drw', id: 'a1', f: { tx: 'Ridge' } });
  drawOn(re, step(), 'e1', 5 * MIN);
  drawOn(rg, step(), 'g1', null); // forbidden: guest
  del(rb, { k: 'drw', id: 'a1' });
  sync(step());

  // ── Guests: their own comments, alerts, caps and receipts only ────────────
  set(rg, { k: 'point', id: 'gp', f: { n: 1 } }); // forbidden
  set(rg, { k: 'task', id: 'gt', f: { title: 'Mine', assignee: bob.id } }); // forbidden
  set(rg, { k: 'track', id: 'gtr', f: { name: 'Mine' } }); // forbidden
  set(rg, { k: 'photo', id: 'gph', f: { at: now } }); // forbidden
  set(rg, { k: 'trl', id: 'gtl', f: { name: 'Mine', base: encodePolyline([QC, NEAR]) } });
  set(rg, { k: 'rly', id: 'gr', f: { la: QC[1], lo: QC[0] } }); // forbidden
  set(rg, { k: 'comment', id: 'c3', f: { photoId: 'ph1', text: 'again' } });
  del(rg, { k: 'comment', id: 'c3' }); // their own: fine
  del(rg, { k: 'task', id: 't1', o: bob.id }); // forbidden
  sync(step());
  // Redactions: an admin redacts a guest's message; a member cannot redact Bob's.
  del(ra, { k: 'msg', id: 'g1', o: gus.id });
  del(re, { k: 'msg', id: 'm3', o: bob.id }); // forbidden
  sync(step());

  // ── A newer app's kind (a 2.7 note on a pin), written and deleted ─────────
  set(rb, { k: 'pnm', id: 'p1', f: { show: 1 } });
  msg(rb, { id: 'm4', th: 'team', tx: 'After the note' });
  del(rb, { k: 'pnm', id: 'p1' });

  // ── Positions ─────────────────────────────────────────────────────────────
  rb.position(step(), { la: 46.8, lo: -71.2, at: now });
  re.position(step(), { la: 46.81, lo: -71.21, ac: 5, el: 120, at: now });
  rg.position(step(), { la: 46.79, lo: -71.19, at: now });
  sync(step());

  // ── Max writes, is removed, the team rotates; Max keeps writing ────────────
  set(rm, { k: 'wpt', id: 'w9', f: { name: 'Max camp' } });
  msg(rm, { id: 'x1', th: 'team', tx: 'Before removal' });
  sync(step());
  w.root.control(step(), 'm.remove', { m: max.id, cut: cutFor(w.root.state, max.id) });
  w.root.control(step(), 'k.rotate', rotateBody(c, w.teamId, activeMembers(w.root.state)).body);
  msg(rm, { id: 'x2', th: 'team', tx: 'After removal' }); // above the cut
  sync(step());
  msg(w.root, { id: 'm5', th: 'team', tx: 'New key era' });
  set(ra, { k: 'wpt', id: 'w4', f: { name: 'After rotation' } });
  del(ra, { k: 'photo', id: 'ph1', o: bob.id }); // admin deletes Bob's photo
  del(rb, { k: 'comment', id: 'c1', o: gus.id }); // forbidden: not Bob's
  sync(step());

  const seen = new Set<string>();
  const envs: unknown[] = [];
  for (const r of all) {
    for (const op of [...r.log.logged(), ...r.liveEphemeral(now)]) {
      if (seen.has(op.id)) continue;
      seen.add(op.id);
      envs.push(op.env);
    }
  }
  return {
    teamId: w.teamId,
    now: now + MIN,
    viewers: { owner: b64(w.owner.keys), guest: b64(gus.keys), removed: b64(max.keys) },
    envs,
  };
}

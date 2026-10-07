import { isLive, visibleFields } from './crdt';
import {
  entityKey,
  parseDelBody,
  parseMsgBody,
  parsePosBody,
  parseSetBody,
  reduceData,
} from './data';
import { resolveTeam } from './membership';
import { addMember, c, device, exchange, joinReplica, MIN, newWorld, T0 } from './testing/fixtures';
import { forAll, int, mulberry32, pick, shuffle } from './testing/prop';

describe('body parsers', () => {
  it('accept well-formed bodies and reject everything else', () => {
    expect(parseSetBody({ k: 'wpt', id: 'w1', f: { name: 'Camp' } })).toBeDefined();
    for (const bad of [
      null,
      { k: 'msg', id: 'a', f: { x: 1 } },
      { k: 'nope', id: 'a', f: { x: 1 } },
      { k: 'wpt', id: 'a b', f: { x: 1 } },
      { k: 'wpt', id: 'a', f: {} },
      { k: 'wpt', id: 'a', f: { '1bad': 1 } },
      { k: 'wpt', id: 'a', f: { x: 1 }, extra: 1 },
    ]) {
      expect(parseSetBody(bad)).toBeUndefined();
    }
    expect(parseDelBody({ k: 'photo', id: 'p', o: device().id })).toBeDefined();
    expect(parseDelBody({ k: 'photo', id: 'p', o: 'x' })).toBeUndefined();
    expect(parseMsgBody({ id: 'm', th: 'dm:abc', tx: 'hi', mn: [device().id] })).toBeDefined();
    expect(parseMsgBody({ id: 'm', th: 'DM!', tx: 'hi' })).toBeUndefined();
    expect(parseMsgBody({ id: 'm', th: 'team', tx: 'x'.repeat(4001) })).toBeUndefined();
    expect(parseMsgBody({ id: 'm', th: 'team', tx: 'x', mn: ['nope'] })).toBeUndefined();
    expect(parsePosBody({ la: 46.8, lo: -71.2, ac: 5, el: 100, at: T0 })).toBeDefined();
    for (const bad of [
      { la: 91, lo: 0, at: T0 },
      { la: 0, lo: 0, at: 1.5 },
      { la: 0, lo: 0, at: T0, ac: -1 },
      { la: 0, lo: 0, at: T0, el: 'x' },
    ]) {
      expect(parsePosBody(bad)).toBeUndefined();
    }
  });
});

describe('reduceData', () => {
  it('shared waypoints merge per field across members', () => {
    const w = newWorld();
    const b = device();
    addMember(w.root, b, 'member', T0 + 1);
    const rb = joinReplica(w, b, w.root, T0 + 2);
    w.root.write(T0 + MIN, 'e.set', { k: 'wpt', id: 'camp', f: { name: 'Camp', ele: 900 } });
    rb.write(T0 + 2 * MIN, 'e.set', { k: 'wpt', id: 'camp', f: { note: 'water' } });
    exchange(w.root, rb, T0 + 3 * MIN);
    const e = rb.data().entities.get(entityKey('wpt', 'camp'))!;
    expect(visibleFields(e.state)).toEqual({ name: 'Camp', ele: 900, note: 'water' });
    expect([...w.root.data().entities.keys()]).toEqual([...rb.data().entities.keys()]);
  });

  it('owned records: others cannot overwrite; only the owner or an admin deletes', () => {
    const w = newWorld();
    const b = device();
    const e = device();
    addMember(w.root, b, 'member', T0 + 1);
    addMember(w.root, e, 'member', T0 + 2);
    const rb = joinReplica(w, b, w.root, T0 + 3);
    const re = joinReplica(w, e, w.root, T0 + 3);
    rb.write(T0 + MIN, 'e.set', { k: 'comment', id: 'c1', f: { photoId: 'p', text: 'nice' } });
    // Eve writes "the same" comment id: it becomes her own record, Bob's is untouched.
    re.write(T0 + 2 * MIN, 'e.set', {
      k: 'comment',
      id: 'c1',
      f: { photoId: 'p', text: 'hijack' },
    });
    const del = re.write(T0 + 3 * MIN, 'e.del', { k: 'comment', id: 'c1', o: b.id })!;
    exchange(rb, re, T0 + 4 * MIN);
    exchange(rb, w.root, T0 + 4 * MIN);
    const data = rb.data();
    const bobs = data.entities.get(entityKey('comment', 'c1', b.id))!;
    expect(visibleFields(bobs.state)).toEqual({ photoId: 'p', text: 'nice' });
    expect(data.entities.get(entityKey('comment', 'c1', e.id))?.owner).toBe(e.id);
    expect(data.skipped).toContainEqual({ id: del.id, why: 'forbidden' });
    // The owner (admin) can delete Bob's comment.
    w.root.write(T0 + 5 * MIN, 'e.del', { k: 'comment', id: 'c1', o: b.id });
    expect(isLive(w.root.data().entities.get(entityKey('comment', 'c1', b.id))!.state)).toBe(false);
  });

  it('messages are immutable; redaction tombstones them; audience and priority are kept', () => {
    const w = newWorld();
    w.root.control(T0 + 1, 'g.set', { id: 'sar' });
    w.root.write(
      T0 + MIN,
      'msg',
      { id: 'm1', th: 'team', tx: 'first' },
      { aud: { g: ['sar'] }, pr: 2 },
    );
    w.root.write(T0 + 2 * MIN, 'msg', { id: 'm1', th: 'team', tx: 'rewritten' });
    const rec = w.root.data().entities.get(entityKey('msg', 'm1', w.owner.id))!;
    expect(visibleFields(rec.state)['tx']).toBe('first');
    expect(rec.aud).toEqual({ g: ['sar'] });
    expect(rec.pr).toBe(2);
    w.root.write(T0 + 3 * MIN, 'e.del', { k: 'msg', id: 'm1' });
    expect(isLive(w.root.data().entities.get(entityKey('msg', 'm1', w.owner.id))!.state)).toBe(
      false,
    );
  });

  it('positions: latest per member; invalid and undecryptable bodies are reported', () => {
    const w = newWorld();
    w.root.position(T0 + MIN, { la: 46.8, lo: -71.2, at: T0 + MIN });
    w.root.position(T0 + 2 * MIN, { la: 46.9, lo: -71.3, at: T0 + 2 * MIN });
    expect(w.root.data().positions.get(w.owner.id)?.value.la).toBe(46.9);
    const bad = w.root.write(T0 + 3 * MIN, 'e.set', { k: 'wpt', id: 'x', f: {} })!;
    expect(w.root.data().skipped).toContainEqual({ id: bad.id, why: 'invalid' });
    // A peer without the key cannot decode.
    const s = resolveTeam(c, w.teamId, [
      ...w.root.log.logged(),
      ...w.root.liveEphemeral(T0 + 3 * MIN),
    ]);
    const blind = reduceData(s, () => undefined);
    expect(blind.skipped.every((x) => x.why === 'undecryptable')).toBe(true);
  });

  it('property: the data view is independent of arrival order across replicas', () => {
    const w = newWorld();
    const b = device();
    addMember(w.root, b, 'member', T0 + 1);
    const rb = joinReplica(w, b, w.root, T0 + 2);
    const rnd = mulberry32(99);
    const ids = ['a', 'b', 'c'];
    for (let i = 0; i < 40; i++) {
      const r = rnd() < 0.5 ? w.root : rb;
      const t = T0 + MIN + int(rnd, 0, 5) * 1000;
      if (rnd() < 0.2) r.write(t, 'e.del', { k: 'wpt', id: pick(rnd, ids) });
      else
        r.write(t, 'e.set', {
          k: 'wpt',
          id: pick(rnd, ids),
          f: { [pick(rnd, ['n', 'm'])]: int(rnd, 0, 9) },
        });
    }
    exchange(w.root, rb, T0 + 10 * MIN);
    const all = [...w.root.log.logged()];
    const view = (ops: typeof all) => {
      const s = resolveTeam(c, w.teamId, ops);
      const d = reduceData(s, (op) => w.root.decode(op));
      return [...d.entities].map(([k, e]) => [k, isLive(e.state), visibleFields(e.state)]).sort();
    };
    const ref = view(all);
    expect(view([...rb.log.logged()])).toEqual(ref);
    forAll(
      100,
      20,
      (r) => shuffle(all, r),
      (order) => expect(view(order)).toEqual(ref),
    );
  });
});

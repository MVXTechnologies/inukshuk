import { baseKey } from '@core/team/records';
import {
  addMember,
  device,
  exchange,
  joinReplica,
  MIN,
  newWorld,
  T0,
} from '@core/team/testing/fixtures';

import {
  editors,
  editText,
  insertKey,
  nearestSegment,
  nearestVertex,
  SYS_EDIT,
  teamTrails,
} from './trails';

const LINE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

describe('team trails in the UI', () => {
  it('reads trails with their edited vertices and who is editing', () => {
    const w = newWorld();
    const d = device();
    addMember(w.root, d, 'member', T0 + 1);
    const r = joinReplica(w, d, w.root, T0 + 2);
    w.root.write(T0 + MIN, 'e.set', {
      k: 'trl',
      id: 't1',
      f: { name: 'Loop', base: LINE, so: w.owner.id, si: 'rec1' },
    });
    exchange(w.root, r, T0 + MIN);
    r.write(T0 + 2 * MIN, 'e.set', {
      k: 'tve',
      id: 't1_b1',
      f: { to: w.owner.id, tr: 't1', la: 41, lo: -121 },
    });
    r.write(T0 + 2 * MIN, 'msg', { id: 'e1', th: SYS_EDIT, tx: editText(`${w.owner.id}:t1`) });
    exchange(w.root, r, T0 + 3 * MIN);
    const data = w.root.data(T0 + 3 * MIN);
    const [trail] = teamTrails(data);
    expect(trail).toMatchObject({ name: 'Loop', src: { owner: w.owner.id, id: 'rec1' } });
    expect(trail!.vertices.map((v) => v.lat)).toEqual([38.5, 41, 43.252]);
    expect([...editors(data, T0 + 3 * MIN)]).toEqual([[d.id, `${w.owner.id}:t1`]]);
    expect(editors(data, T0 + 10 * MIN).size).toBe(0);
  });

  it('finds the vertex or segment under a tap, and insert keys', () => {
    const vs = [
      { id: 'a', key: baseKey(0), lng: -71, lat: 47, inserted: false },
      { id: 'b', key: baseKey(1), lng: -71, lat: 47.01, inserted: false },
    ];
    expect(nearestVertex(vs, [-71, 47.0001], 20)?.id).toBe('a');
    expect(nearestVertex(vs, [-71, 47.005], 20)).toBeNull();
    const seg = nearestSegment(vs, [-70.9999, 47.005], 20)!;
    expect(seg.index).toBe(0);
    expect(seg.point[1]).toBeCloseTo(47.005, 6);
    expect(nearestSegment(vs, [-70.99, 47.005], 20)).toBeNull();
    const mid = insertKey(vs, 0)!;
    expect(mid > baseKey(0) && mid < baseKey(1)).toBe(true);
    expect(insertKey(vs, 1)! > baseKey(1)).toBe(true);
    expect(insertKey(vs, -1)! < baseKey(0)).toBe(true);
  });
});

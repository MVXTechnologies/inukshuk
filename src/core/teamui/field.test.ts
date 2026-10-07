import {
  addMember,
  device,
  exchange,
  joinReplica,
  MIN,
  newWorld,
  T0,
} from '@core/team/testing/fixtures';

import { metres, rallyArrivals, teamRally, teamSos } from './field';

describe('SOS and rally readers', () => {
  it('lists SOS (open first) and the newest rally', () => {
    const w = newWorld();
    const d = device();
    addMember(w.root, d, 'member', T0 + 1);
    const r = joinReplica(w, d, w.root, T0 + 2);
    r.write(T0 + MIN, 'e.set', { k: 'sos', id: 's1', f: { la: 47, lo: -71, tx: 'Ankle' } });
    w.root.write(T0 + MIN, 'e.set', { k: 'rly', id: 'r1', f: { la: 47, lo: -71, r: 60 } });
    w.root.write(T0 + 2 * MIN, 'e.set', {
      k: 'rly',
      id: 'r2',
      f: { la: 47.1, lo: -71, tx: 'Summit', at: T0 + 60 * MIN, r: 80 },
    });
    exchange(w.root, r, T0 + 3 * MIN);
    const data = w.root.data(T0 + 3 * MIN);
    expect(teamSos(data)).toEqual([
      expect.objectContaining({ id: 's1', owner: d.id, text: 'Ankle', resolved: false }),
    ]);
    expect(teamRally(data)).toMatchObject({ id: 'r2', text: 'Summit', radius: 80 });
  });

  it('says who arrived and estimates the others', () => {
    const rally = {
      id: 'r',
      owner: 'o',
      lng: -71,
      lat: 47,
      text: '',
      when: null,
      radius: 60,
      at: 0,
    };
    const out = rallyArrivals(rally, [
      { id: 'a', at: [-71, 47.0003] },
      { id: 'b', at: [-71, 47.01], speedMps: 2 },
      { id: 'c', at: [-71, 47.01] },
      { id: 'd', at: null },
    ]);
    expect(out[0]).toMatchObject({ arrived: true, etaMin: 0 });
    expect(out[1]!.etaMin).toBe(Math.round(metres([-71, 47.01], [-71, 47]) / 2 / 60));
    expect(out[2]!.etaMin).toBe(Math.round(metres([-71, 47.01], [-71, 47]) / 1.2 / 60));
    expect(out[3]).toEqual({ id: 'd', distanceM: null, arrived: false, etaMin: null });
  });
});

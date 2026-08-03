import { buildHeatIndex, hotCountAt, trailsNear } from './heatIndex';

const input = (id: string, categoryId: string, keys: string[]) => ({
  id,
  categoryId,
  dilated: new Set(keys),
});

describe('heat index', () => {
  it('counts distinct same-category trails per cell', () => {
    const index = buildHeatIndex([
      input('a', 'run', ['0,0', '0,1']),
      input('b', 'run', ['0,1', '0,2']),
      input('c', 'run', ['0,1']),
    ]);
    expect(hotCountAt(index, '0,1', 'run')).toBe(3);
    expect(hotCountAt(index, '0,0', 'run')).toBe(1);
    expect(hotCountAt(index, '9,9', 'run')).toBe(0);
  });

  it('never mixes categories', () => {
    const index = buildHeatIndex([input('a', 'run', ['0,0']), input('b', 'hike', ['0,0'])]);
    expect(hotCountAt(index, '0,0', 'run')).toBe(1);
    expect(hotCountAt(index, '0,0', 'hike')).toBe(1);
  });

  it('trailsNear unions the ring and reports hot per any-category >= 2', () => {
    const index = buildHeatIndex([
      input('a', 'run', ['5,5']),
      input('b', 'run', ['5,6']), // neighbour of 5,5 → in the ring
      input('c', 'hike', ['5,5']),
    ]);
    const at = trailsNear(index, { row: 5, col: 5 });
    expect(at.trackIds).toEqual(['a', 'b', 'c']);
    expect(at.hot).toBe(true); // two 'run' trails in the ring
    const cold = trailsNear(index, { row: 50, col: 50 });
    expect(cold.trackIds).toEqual([]);
    expect(cold.hot).toBe(false);
  });

  it('a single trail everywhere is never hot', () => {
    const index = buildHeatIndex([input('a', 'run', ['1,1', '1,2'])]);
    expect(trailsNear(index, { row: 1, col: 1 }).hot).toBe(false);
  });
});

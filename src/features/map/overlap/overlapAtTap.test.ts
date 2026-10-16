import { overlapAtTap } from './overlapAtTap';

const P = 46.8;
const line = (lat: number) => ({
  geometry: {
    type: 'LineString' as const,
    coordinates: [
      [-71.21, lat],
      [-71.19, lat],
    ],
  },
});

describe('overlapAtTap (#745)', () => {
  it('refines the grid candidates against their real lines', () => {
    const lineFor = (id: string) =>
      id === 'near' ? line(P) : id === 'far' ? line(P + 0.0004) : null;
    // ~44 m north is outside a 15 m finger: only "near" and the unloaded one remain.
    const pick = overlapAtTap([-71.2, P], 15, ['near', 'far', 'unloaded'], lineFor, []);
    expect(pick.kind === 'choose' && pick.hits.map((h) => h.id)).toEqual(['near', 'unloaded']);
  });

  it('reads MultiLineString parts (a trail with pauses)', () => {
    const lineFor = () => ({
      geometry: {
        type: 'MultiLineString' as const,
        coordinates: [
          [
            [-71.3, 46.9],
            [-71.29, 46.9],
          ],
          [
            [-71.21, P],
            [-71.19, P],
          ],
        ],
      },
    });
    expect(overlapAtTap([-71.2, P], 10, ['t'], lineFor, [])).toEqual({
      kind: 'one',
      hit: { kind: 'trail', id: 't', distanceM: expect.any(Number) },
    });
  });

  it('a trail beside an area: the chooser offers both', () => {
    const area = {
      id: 'camp',
      ring: [
        [-71.22, 46.79],
        [-71.18, 46.79],
        [-71.18, 46.81],
        [-71.22, 46.81],
      ] as [number, number][],
    };
    const pick = overlapAtTap([-71.2, P], 10, ['t'], () => line(P), [area]);
    expect(pick.kind === 'choose' && pick.hits.map((h) => `${h.kind}:${h.id}`)).toEqual([
      'trail:t',
      'area:camp',
    ]);
  });
});

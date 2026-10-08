import { replyTo } from './responder';
import { lineLength, metres, MSA_TRAIL, pointAlong, routesNear, stepToward } from './routes';

const fixed = (v: number) => () => v;

describe('simulated teammates', () => {
  it('answer greetings, questions and mentions; stay quiet sometimes', () => {
    expect(replyTo('Bonjour tout le monde', false, fixed(0))).toBe('Salut!');
    expect(replyTo('Thanks!', false, fixed(0))).toBe('De rien!');
    expect(replyTo('On mange où?', false, fixed(0))).not.toBeNull();
    expect(replyTo('ok', true, fixed(0))).not.toBeNull();
    expect(replyTo('ok', false, fixed(0.9))).toBeNull();
  });

  it('walk the Mont-Sainte-Anne trail back and forth, and toward a target', () => {
    expect(MSA_TRAIL.length).toBeGreaterThan(100);
    const len = lineLength(MSA_TRAIL);
    expect(len).toBeGreaterThan(5_000);
    const start = MSA_TRAIL[0]!;
    expect(metres(pointAlong(MSA_TRAIL, 0), start)).toBeLessThan(1);
    expect(metres(pointAlong(MSA_TRAIL, 2 * len), start)).toBeLessThan(1);
    const a: [number, number] = [-70.92, 47.08];
    const b: [number, number] = [-70.91, 47.08];
    expect(metres(stepToward(a, b, 100), a)).toBeCloseTo(100, 0);
    expect(stepToward(a, b, 5_000)).toEqual(b);
    expect(routesNear(null, [])).toEqual([MSA_TRAIL]);
    const loops = routesNear([-71.2, 46.8], []);
    expect(loops).toHaveLength(2);
    expect(metres(loops[0]![0]!, [-71.2, 46.8])).toBeGreaterThan(300);
    expect(metres(loops[0]![0]!, [-71.2, 46.8])).toBeLessThan(700);
    const near: [number, number][] = [a, b];
    expect(routesNear(a, [near])).toEqual([near]);
  });
});

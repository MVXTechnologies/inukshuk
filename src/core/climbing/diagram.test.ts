import fixtures from './__fixtures__/crags.json';
import { parseCragDetail, type CragRoute } from './detail';
import { DIAGRAM_MAX_FIT, gradeChart, wallDiagram } from './diagram';

const weir = parseCragDetail(fixtures.Weir)!;
const lac = parseCragDetail(fixtures['Lac Long'])!;

const route = (p: Partial<CragRoute>): CragRoute => ({ id: 'x', name: 'x', styles: [], ...p });

describe('wallDiagram', () => {
  it('draws one line per route, left to right, numbered as the list', () => {
    const bw = weir.sectors.find((s) => s.name === 'Black and White')!;
    const d = wallDiagram(bw.routes, { width: 360, height: 260 });
    expect(d.lines).toHaveLength(bw.routes.length);
    expect(d.lines.map((l) => l.n)).toEqual(bw.routes.map((_, i) => i + 1));
    const xs = d.lines.map((l) => l.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(d.scrolls).toBe(bw.routes.length > DIAGRAM_MAX_FIT);
    expect(d.width).toBeGreaterThan(360);
  });

  it('scales height by length (8 m floor), dashes trad, dots bolts', () => {
    const d = wallDiagram(
      [
        route({ lengthM: 40, styles: ['sport'], bolts: 10, k: 'r', x: 20 }),
        route({ lengthM: 2, styles: ['trad'], k: 'r', x: 5 }),
        route({ styles: ['tr'] }),
      ],
      { width: 300, height: 200, footer: 30 },
    );
    const [a, b, c] = d.lines;
    expect(d.baseY).toBe(170);
    expect(a!.topY).toBeLessThan(b!.topY);
    expect(a!.bolts).toHaveLength(10);
    expect(a!.band).toBe(3);
    expect(a!.dashed).toBe(false);
    expect(b!.dashed).toBe(true);
    expect(d.baseY - b!.topY).toBeCloseTo(((d.baseY - 22) * 8) / 40);
    expect(c!.guessedLength).toBe(true);
    expect(c!.band).toBeNull();
    expect(d.scrolls).toBe(false);
    expect(d.ridge[0]).toEqual([0, d.baseY]);
    expect(d.ridge[d.ridge.length - 1]).toEqual([300, d.baseY]);
  });
});

describe('gradeChart', () => {
  it('counts Lac Long routes per grade, easiest first', () => {
    const southern = lac.sectors[0]!;
    const chart = gradeChart(southern.routes, 'yds')!;
    expect(chart.kind).toBe('r');
    expect(chart.bins.map((b) => b.label)).toEqual(
      [...chart.bins.map((b) => b.label)].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))),
    );
    expect(chart.bins.reduce((n, b) => n + b.count, 0) + chart.ungraded).toBe(
      southern.routes.length,
    );
  });

  it('bins French by number and letter', () => {
    const chart = gradeChart(
      [route({ k: 'r', x: 12 }), route({ k: 'r', x: 13 }), route({ k: 'r', x: 17 }), route({})],
      'french',
    )!;
    expect(chart.bins).toEqual([
      { label: '6b', count: 2, band: 1 },
      { label: '7a', count: 1, band: 2 },
    ]);
    expect(chart.ungraded).toBe(1);
  });

  it('is null without grades', () => {
    expect(gradeChart([route({})], 'yds')).toBeNull();
  });
});

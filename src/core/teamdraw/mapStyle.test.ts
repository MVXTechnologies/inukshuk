import { LIVE_LAYER_ORDER } from '@core/map/liveLayerOrder';

import { DRAW_LAYERS, DRAW_TAP_LAYERS, drawLayerStyles, HEAD_DP } from './mapStyle';

const C = { halo: 'H', selection: 'S', ink: 'I', onBadge: 'W' };
const FONT = ['Noto Sans Bold'];

/** Every expression's operators, flattened. */
function ops(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) {
    if (typeof v[0] === 'string') out.push(v[0]);
    for (const x of v) ops(x, out);
  } else if (v !== null && typeof v === 'object') {
    for (const x of Object.values(v)) ops(x, out);
  }
  return out;
}

describe('the team-drawing layers', () => {
  it('are six, each in the live layer order: over trails, under the flag and teammates', () => {
    const ids = Object.values(DRAW_LAYERS);
    expect(ids).toHaveLength(6);
    const at = (id: string) => (LIVE_LAYER_ORDER as readonly string[]).indexOf(id);
    for (const id of ids) {
      expect(at(id)).toBeGreaterThan(at('team-trl-who'));
      expect(at(id)).toBeLessThan(at('team-rally-dot'));
      expect(at(id)).toBeLessThan(at('team-member-dot'));
      expect(at(id)).toBeLessThan(at('waypoint-pin'));
    }
    expect(DRAW_TAP_LAYERS).not.toContain(DRAW_LAYERS.casing);
  });

  it('never uses ["zoom"] (iOS crashes on it inside match/case)', () => {
    const st = drawLayerStyles(C, 'a:b', FONT);
    expect(ops(st)).not.toContain('zoom');
  });

  it('halos the selected shape with the selection colour', () => {
    const casing = drawLayerStyles(C, 'me:s1', FONT).casing.paint['line-color'];
    expect(casing).toEqual(['case', ['==', ['get', 'drw'], 'me:s1'], 'S', 'H']);
    const none = drawLayerStyles(C, null, FONT).casing.paint['line-color'] as unknown[];
    expect(none[1]).toEqual(['==', ['get', 'drw'], '']);
  });

  it('sizes heads S/M/L from the L sprite, and turns them with the map', () => {
    const head = drawLayerStyles(C, null, FONT).head.layout!;
    expect(head['icon-rotation-alignment']).toBe('map');
    const size = head['icon-size'] as unknown[];
    const byLevel = size[4] as unknown[];
    expect(byLevel[3]).toBeCloseTo(HEAD_DP[1] / HEAD_DP[3] / 2, 3);
    expect(byLevel[6]).toBeCloseTo(0.5);
  });

  it('keeps badges and notes upright, banded by recency, in the given font', () => {
    const sym = drawLayerStyles(C, null, FONT).sym.layout!;
    expect(sym['icon-rotation-alignment']).toBeUndefined();
    expect(sym['text-font']).toBe(FONT);
    expect(sym['symbol-sort-key']).toEqual(['get', 'z']);
  });
});

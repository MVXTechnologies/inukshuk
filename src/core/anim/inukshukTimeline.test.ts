import { sampleTrack } from './keyframes';
import {
  contactLine,
  CYCLE_MS,
  dropStart,
  DROP_PX,
  DUST_MS,
  FADE_END_MS,
  FADE_START_MS,
  landingAt,
  OP,
  PLAY_ONCE_END_MS,
  ROT,
  sinceLanding,
  SETTLED_MS,
  SPECK_OPACITY,
  SPECKS,
  STONE_ORDER,
  STONE_TRACKS,
  SX,
  SY,
  TX,
  TY,
  type Rect,
  type StoneId,
} from './inukshukTimeline';

const at = (id: StoneId, t: number, ch: number) => sampleTrack(STONE_TRACKS[id], t, ch);

describe('Inukshuk loader timeline', () => {
  it('drops the stones bottom-up, 280 ms apart, each landing 400 ms after it starts', () => {
    expect(STONE_ORDER).toEqual(['leg-left', 'leg-right', 'torso', 'arm', 'head']);
    expect(STONE_ORDER.map(landingAt)).toEqual([400, 680, 960, 1240, 1520]);
    expect(SETTLED_MS).toBe(landingAt('head') + 240);
  });

  it.each(STONE_ORDER)('%s is hidden, tilted and high before its drop', (id) => {
    const t = Math.max(0, dropStart(id) - 1);
    expect(at(id, t, OP)).toBe(0);
    expect(at(id, t, TY)).toBeCloseTo(-DROP_PX, 0);
    expect(Math.abs(at(id, t, ROT))).toBeGreaterThanOrEqual(10);
  });

  it.each(STONE_ORDER)('%s straightens exactly on contact, then squashes', (id) => {
    const land = landingAt(id);
    expect(at(id, land, TX)).toBe(0);
    expect(at(id, land, TY)).toBe(0);
    expect(at(id, land, ROT)).toBe(0);
    expect(at(id, land, SX)).toBeGreaterThan(1.05);
    expect(at(id, land, SY)).toBeLessThan(0.9);
    // While falling, the tilt and drift shrink towards zero.
    const mid = dropStart(id) + 200;
    expect(Math.abs(at(id, mid, ROT))).toBeLessThan(Math.abs(at(id, dropStart(id) + 60, ROT)));
    expect(at(id, mid, OP)).toBe(1);
  });

  it.each(STONE_ORDER)('%s hops up a little after landing and is at rest 240 ms later', (id) => {
    const land = landingAt(id);
    expect(at(id, land + 120, TY)).toBeLessThan(0);
    for (const ch of [TX, TY, ROT]) expect(at(id, land + 240, ch)).toBe(0);
    expect(at(id, land + 240, SX)).toBe(1);
    expect(at(id, land + 240, SY)).toBe(1);
  });

  it('holds the complete figure, fades it, and is invisible at the loop seam', () => {
    for (const id of STONE_ORDER) {
      expect(at(id, SETTLED_MS, OP)).toBe(1);
      expect(at(id, FADE_START_MS, OP)).toBe(1);
      expect(at(id, (FADE_START_MS + FADE_END_MS) / 2, OP)).toBeGreaterThan(0);
      expect(at(id, (FADE_START_MS + FADE_END_MS) / 2, OP)).toBeLessThan(1);
      expect(at(id, FADE_END_MS, OP)).toBe(0);
      expect(at(id, CYCLE_MS - 1, OP)).toBe(0);
      expect(at(id, 0, OP)).toBe(0);
    }
  });

  it('plays once to a settled, dust-free figure before the fade', () => {
    expect(PLAY_ONCE_END_MS).toBeGreaterThanOrEqual(SETTLED_MS);
    expect(PLAY_ONCE_END_MS).toBeLessThan(FADE_START_MS);
    for (const id of STONE_ORDER) {
      expect(sampleTrack(SPECK_OPACITY, sinceLanding(PLAY_ONCE_END_MS, landingAt(id)), 0)).toBe(0);
    }
  });
});

describe('Inukshuk loader dust', () => {
  it('puffs five specks per landing, three left and two right', () => {
    expect(SPECKS).toHaveLength(5);
    expect(SPECKS.filter((s) => s.side === 'left')).toHaveLength(3);
  });

  it('is visible only within 400 ms of its landing, peaking at 0.6', () => {
    expect(sampleTrack(SPECK_OPACITY, 0, 0)).toBe(0);
    expect(sampleTrack(SPECK_OPACITY, 17, 0)).toBeCloseTo(0.6);
    expect(sampleTrack(SPECK_OPACITY, 300, 0)).toBeGreaterThan(0);
    expect(sampleTrack(SPECK_OPACITY, DUST_MS, 0)).toBe(0);
    expect(sampleTrack(SPECK_OPACITY, 3000, 0)).toBe(0);
  });

  it('moves each speck outward on its own side', () => {
    for (const s of SPECKS) {
      const x = sampleTrack(s.motion, 200, 0);
      expect(Math.sign(x)).toBe(s.side === 'left' ? -1 : 1);
      expect(sampleTrack(s.motion, 200, 1)).toBeLessThan(0);
    }
  });

  it('wraps time since landing into the loop', () => {
    expect(sinceLanding(500, 400)).toBe(100);
    expect(sinceLanding(100, 400)).toBe(CYCLE_MS - 300);
    expect(sinceLanding(400 + CYCLE_MS, 400)).toBe(0);
  });

  it('puffs from the ground for legs and from the torso ends for the arm', () => {
    const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
    const rects: Record<StoneId, Rect> = {
      head: r(271, 4, 229, 201),
      arm: r(2, 182, 780, 186),
      torso: r(177, 374, 438, 174),
      'leg-left': r(99, 549, 248, 317),
      'leg-right': r(428, 548, 255, 318),
    };
    expect(contactLine('leg-left', rects)).toEqual({ left: 99, right: 347, y: 866 });
    expect(contactLine('arm', rects)).toEqual({ left: 177, right: 615, y: 368 });
    expect(contactLine('head', rects)).toEqual({ left: 271, right: 500, y: 205 });
  });
});

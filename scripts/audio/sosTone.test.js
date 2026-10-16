/**
 * @jest-environment node
 */
const { describe, expect, it } = require('@jest/globals');
const { readFileSync } = require('node:fs');

const {
  D,
  F,
  PEAK,
  RATE,
  SECTION_S,
  TOTAL_S,
  sosToneLayout,
  sosToneSamples,
  sosToneWav,
} = require('./sosTone');

const ASSET = require.resolve('../../assets/sounds/team_sos.wav');
const samples = sosToneSamples();
const wav = sosToneWav();
const at = (s) => Math.round(s * RATE);
const peakOf = (a, b) => {
  let m = 0;
  for (let i = a; i < b; i++) m = Math.max(m, Math.abs(samples[i]));
  return m;
};
/** Goertzel power of `f` Hz over samples [a, b). */
const power = (f, a, b) => {
  const w = (2 * Math.PI * f) / RATE;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = a; i < b; i++) {
    const s0 = samples[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (b - a) ** 2;
};
/** Zero crossings per second over samples [a, b). */
const crossings = (a, b) => {
  let n = 0;
  for (let i = a + 1; i < b; i++) if (samples[i - 1] < 0 !== samples[i] < 0) n++;
  return (n / 2 / (b - a)) * RATE;
};

describe('the SOS tone (#708): the owner’s F then D', () => {
  it('the bundled file is exactly what the script synthesizes (our own sound)', () => {
    expect(readFileSync(ASSET).equals(wav)).toBe(true);
  });

  it('is an 8.0 s 16-bit mono 22.05 kHz PCM WAV, within the iOS 30 s limit', () => {
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(22_050);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
    expect(TOTAL_S).toBe(8);
    expect(samples.length).toBe(8 * 22_050);
    expect((wav.length - 44) / 2 / RATE).toBe(8);
  });

  it('lays out 4 s of F (24 stutter pulses) then 4 s of D (4 whoops)', () => {
    const layout = sosToneLayout();
    const f = layout.filter((s) => s.voice === 'F');
    const d = layout.filter((s) => s.voice === 'D');
    expect(layout).toEqual([...f, ...d]);
    expect(SECTION_S).toBe(4);
    expect(f).toHaveLength(24);
    expect(d).toHaveLength(4);
    for (const [i, s] of f.entries()) {
      expect(s.start).toBeCloseTo(i * 0.166, 9);
      expect(s.end - s.start).toBeCloseTo(0.11, 9);
    }
    expect(f[f.length - 1].end).toBeLessThanOrEqual(4);
    expect(d.map((s) => s.start)).toEqual([4, 5, 6, 7]);
    for (const s of d) expect(s.end - s.start).toBeCloseTo(0.85, 9);
    expect(F).toMatchObject({ freqs: [1000, 1414], h: 0.9, on: 0.11, period: 0.166 });
    expect(D).toMatchObject({ f0: 500, f1: 1800, h: 0.7, on: 0.85, period: 1 });
  });

  it('sounds in each segment and is silent between them', () => {
    const layout = sosToneLayout();
    for (const s of layout) expect(peakOf(at(s.start), at(s.end))).toBeGreaterThan(0.5);
    for (let i = 1; i < layout.length; i++)
      expect(peakOf(at(layout[i - 1].end), at(layout[i].start))).toBe(0);
    // The last 0.15 s is silent: slack for the next re-post's timer jitter.
    expect(peakOf(at(7.85), samples.length)).toBe(0);
  });

  it('F is the 1000 + 1414 Hz dual tone; D rises from ~500 to ~1800 Hz', () => {
    const [a, b] = [at(0.01), at(0.1)];
    const near = Math.max(power(1000, a, b), power(1414, a, b));
    expect(power(1000, a, b)).toBeGreaterThan(near / 4);
    expect(power(1414, a, b)).toBeGreaterThan(near / 4);
    expect(power(1200, a, b)).toBeLessThan(near / 50);
    // Zero crossings of a sweep track its (fundamental-dominated) pitch.
    const early = crossings(at(4.0), at(4.1));
    const late = crossings(at(4.75), at(4.85));
    expect(early).toBeGreaterThan(450);
    expect(early).toBeLessThan(700);
    expect(late).toBeGreaterThan(1500);
    expect(late).toBeLessThan(2000);
  });

  it('both sections reach near full scale without clipping, and nothing clicks', () => {
    expect(peakOf(0, at(4))).toBeCloseTo(PEAK, 9);
    expect(peakOf(at(4), samples.length)).toBeCloseTo(PEAK, 9);
    expect(PEAK).toBe(0.98);
    // Every segment ramps in and out from silence.
    for (const s of sosToneLayout()) {
      expect(Math.abs(samples[at(s.start)])).toBe(0);
      expect(Math.abs(samples[at(s.start) + at(s.end - s.start) - 1])).toBe(0);
    }
    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(0);
  });
});

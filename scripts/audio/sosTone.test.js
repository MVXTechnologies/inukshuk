/**
 * @jest-environment node
 */
const { describe, expect, it } = require('@jest/globals');
const { readFileSync } = require('node:fs');

const { RATE, sosToneSamples, sosToneWav } = require('./sosTone');

const ASSET = require.resolve('../../assets/sounds/team_sos.wav');
describe('the SOS tone (#708)', () => {
  it('the bundled file is exactly what the script synthesizes (our own sound)', () => {
    expect(readFileSync(ASSET).equals(sosToneWav())).toBe(true);
  });

  it('is a short 16-bit mono PCM WAV, within the iOS 30 s limit, never clipping', () => {
    const wav = sosToneWav();
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(RATE);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
    const samples = sosToneSamples();
    const seconds = samples.length / RATE;
    expect(seconds).toBeGreaterThan(1.5);
    expect(seconds).toBeLessThan(3);
    const peak = Math.max(...samples.map(Math.abs));
    expect(peak).toBeGreaterThan(0.6);
    expect(peak).toBeLessThanOrEqual(1);
    // Starts and ends silent (no click).
    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(0);
  });
});

// @ts-check
/**
 * Inukshuk's own SOS alarm tone (#708), synthesized here: no third-party
 * audio. Deterministic, so `sosTone.test.js` can prove the bundled file is
 * exactly what this script makes.
 *
 *   node scripts/audio/sosTone.js assets/sounds/team_sos.wav
 *
 * The sound is the owner's pick from the SOS sound lab ("F then D, 4 s each,
 * 100 % pitch"), 8.0 s in all:
 *
 * - 0–4 s, **F (stutter)**: a dissonant dual tone, 1000 + 1414 Hz, 0.11 s on,
 *   0.056 s off (24 pulses).
 * - 4–8 s, **D (whoop)**: a rising sweep, 500 → 1800 Hz over 0.85 s, one
 *   every 1.0 s (4 sweeps; the last 0.15 s is silent).
 *
 * Each voice is a sine plus odd harmonics at 1/k (the "rasp", h = 0.9 for F,
 * 0.7 for D), band-limited below Nyquist as the lab's Web Audio oscillators
 * are, with 4 ms ramps so nothing clicks. Each section is normalized to a
 * 0.98 peak (near full scale, never clipping). 16-bit mono PCM WAV at
 * 22.05 kHz: what iOS (Linear PCM, < 30 s; it plays a notification sound
 * once) and Android (res/raw, the "Team SOS" channel) both play. The app
 * re-posts the SOS notification every 8 s (`RESOUND_MS` = `SOS_TONE_MS`)
 * while the in-app alarm is up, so F → D → F → D loops until Acknowledge.
 */
const RATE = 22_050;
const NYQUIST = RATE / 2;
/** Total length, seconds (the app's re-sound interval matches it). */
const TOTAL_S = 8.0;
/** Each section's length, seconds: F fills [0, 4), D fills [4, 8). */
const SECTION_S = 4.0;
const RAMP_S = 0.004;
const PEAK = 0.98;
/** Odd harmonics up to this (the lab's 16-term periodic wave). */
const MAX_HARMONIC = 15;

const F = { freqs: [1000, 1414], h: 0.9, on: 0.11, period: 0.166 };
const D = { f0: 500, f1: 1800, h: 0.7, on: 0.85, period: 1.0 };

/**
 * Where each sounding segment lies, seconds from the start (the lab's GEN.F
 * and GEN.D over [0, 4) and [4, 8)).
 * @returns {{ voice: 'F' | 'D', start: number, end: number }[]}
 */
function sosToneLayout() {
  /** @type {{ voice: 'F' | 'D', start: number, end: number }[]} */
  const out = [];
  for (let i = 0; i * F.period + F.on <= SECTION_S; i++) {
    const start = i * F.period;
    out.push({ voice: 'F', start, end: start + F.on });
  }
  for (let i = 0; i * D.period + D.on <= SECTION_S + 1e-9; i++) {
    const start = SECTION_S + i * D.period;
    out.push({ voice: 'D', start, end: start + D.on });
  }
  return out;
}

/**
 * A harmonic's weight: full well below Nyquist, fading to 0 at it (no aliasing, no steps).
 * @param {number} freq
 */
function bandLimit(freq) {
  const knee = 0.85 * NYQUIST;
  if (freq <= knee) return 1;
  if (freq >= NYQUIST) return 0;
  return (NYQUIST - freq) / (NYQUIST - knee);
}

/**
 * One sample of the odd-harmonic wave at phase `p` and fundamental `f`.
 * @param {number} p
 * @param {number} f
 * @param {number} h
 */
function rasp(p, f, h) {
  let v = Math.sin(p);
  for (let k = 3; k <= MAX_HARMONIC; k += 2) {
    const w = bandLimit(k * f);
    if (w === 0) break;
    v += (h / k) * w * Math.sin(k * p);
  }
  return v;
}

/**
 * Scale `s[from, to)` so its peak is {@link PEAK}.
 * @param {number[]} s
 * @param {number} from
 * @param {number} to
 */
function normalize(s, from, to) {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(s[i] ?? 0));
  if (m === 0) return;
  for (let i = from; i < to; i++) s[i] = ((s[i] ?? 0) / m) * PEAK;
}

/** The tone's samples, −1…1. */
function sosToneSamples() {
  const total = Math.round(TOTAL_S * RATE);
  const split = Math.round(SECTION_S * RATE);
  /** @type {number[]} */
  const out = new Array(total).fill(0);
  const ramp = Math.round(RAMP_S * RATE);
  for (const seg of sosToneLayout()) {
    const a = Math.round(seg.start * RATE);
    const n = Math.round((seg.end - seg.start) * RATE);
    const dur = seg.end - seg.start;
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / ramp, (n - 1 - i) / ramp);
      let v;
      if (seg.voice === 'F') {
        const t = i / RATE;
        v = 0;
        for (const f of F.freqs) v += rasp(2 * Math.PI * f * t, f, F.h);
        v /= F.freqs.length;
      } else {
        const f = D.f0 + ((D.f1 - D.f0) * (i / RATE)) / dur;
        phase += (2 * Math.PI * f) / RATE;
        v = rasp(phase, f, D.h);
      }
      out[a + i] = v * env;
    }
  }
  normalize(out, 0, split);
  normalize(out, split, total);
  return out;
}

/** The tone as a 16-bit mono PCM WAV file. */
function sosToneWav() {
  const samples = sosToneSamples();
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2);
  });
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16); // PCM chunk size
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28); // byte rate
  head.writeUInt16LE(2, 32); // block align
  head.writeUInt16LE(16, 34); // bits per sample
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

module.exports = {
  sosToneWav,
  sosToneSamples,
  sosToneLayout,
  RATE,
  TOTAL_S,
  SECTION_S,
  PEAK,
  F,
  D,
};

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('usage: node scripts/audio/sosTone.js <out.wav>\n');
    process.exit(2);
  }
  require('node:fs').writeFileSync(target, sosToneWav());
  process.stdout.write(`wrote ${target}\n`);
}

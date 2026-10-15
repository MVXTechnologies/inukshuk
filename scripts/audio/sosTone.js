// @ts-check
/**
 * Inukshuk's own SOS alarm tone (#708), synthesized here: no third-party
 * audio. Deterministic, so `sosTone.test.js` can prove the bundled file is
 * exactly what this script makes.
 *
 *   node scripts/audio/sosTone.js assets/sounds/team_sos.wav
 *
 * The sound: three groups of three short rising chirps, alternating between
 * two pitches (B5 → E6, then E6 → A6), with a short rest between groups,
 * about 2.1 s in all. A chirp is a sine with a little of its 2nd and 3rd harmonics
 * (bright enough to cut through wind on a phone speaker, never harsh), with
 * 6 ms ramps so it never clicks. 16-bit mono PCM WAV at 22.05 kHz: what iOS
 * (Linear PCM, < 30 s) and Android (res/raw) both play as a notification
 * sound. The Android "Team SOS" channel repeats the alert with its long
 * vibration; the app re-sounds it until Acknowledge.
 */
const RATE = 22_050;
const BEEP_S = 0.13;
const GAP_S = 0.055;
const REST_S = 0.22;
const RAMP_S = 0.006;
const LEVEL = 0.82;

/** Each chirp: start and end frequency, Hz (B5, E6, A6). */
const CHIRPS = [
  [987.77, 1318.51],
  [1318.51, 1760.0],
  [987.77, 1318.51],
];
const GROUPS = 3;

/** The tone's samples, −1…1. */
function sosToneSamples() {
  /** @type {number[]} */
  const out = [];
  const silence = (s) => {
    for (let i = 0; i < Math.round(s * RATE); i++) out.push(0);
  };
  for (let g = 0; g < GROUPS; g++) {
    for (const [f0, f1] of CHIRPS) {
      const n = Math.round(BEEP_S * RATE);
      const ramp = Math.round(RAMP_S * RATE);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const f = f0 + ((f1 - f0) * i) / n;
        phase += (2 * Math.PI * f) / RATE;
        const env = Math.min(1, i / ramp, (n - 1 - i) / ramp);
        const v = Math.sin(phase) * 0.72 + Math.sin(2 * phase) * 0.18 + Math.sin(3 * phase) * 0.1;
        out.push(v * env * LEVEL);
      }
      silence(GAP_S);
    }
    if (g < GROUPS - 1) silence(REST_S);
  }
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

module.exports = { sosToneWav, sosToneSamples, RATE };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('usage: node scripts/audio/sosTone.js <out.wav>\n');
    process.exit(2);
  }
  require('node:fs').writeFileSync(target, sosToneWav());
  process.stdout.write(`wrote ${target}\n`);
}

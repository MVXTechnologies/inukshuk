#!/usr/bin/env node
/**
 * Wind-particle motion gate (weather M3).
 *
 * `assertVisible` cannot see a GL overlay: the wind streaks live in a
 * transparent GLView that the accessibility tree knows nothing about. Every
 * wind regression we have shipped — a shader that failed to compile, a
 * particle field seeded off-screen, a perf ladder that froze itself — left
 * the app looking perfectly healthy to Maestro while the overlay rendered
 * nothing at all.
 *
 * So this gate looks at PIXELS. It drives the app to the Wind layer, takes
 * two screenshots a few seconds apart with the camera sitting still, and
 * asserts that a meaningful number of pixels changed, spread across the map
 * rather than bunched in one place (a clock tick or a single re-tiling must
 * not pass). A live overlay differs by tens of thousands of pixels; a dead
 * one differs by zero, so the threshold needs no fine tuning.
 *
 * Usage:
 *   node scripts/wind-motion-check.mjs --app <path/to/Inukshuk.app> [options]
 *
 *   --app <path>      .app bundle to install first (skip to use what is installed)
 *   --device <udid>   simulator UDID (default: the booted one)
 *   --flow <path>     Maestro flow that leaves the app on the Wind layer
 *                     (default: .maestro/wind-motion.yaml)
 *   --settle <ms>     wait after the flow before the first capture (default 15000)
 *   --gap <ms>        delay between the two captures (default 3000)
 *   --min-diff <n>    minimum differing pixels (default 2000)
 *   --keep            keep the captures instead of deleting them
 *   --no-flow         skip Maestro; assume the app is already on the Wind layer
 *
 * Exits non-zero (with the measured numbers) when the overlay is not moving.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

// --- CLI ---------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};
const has = (name) => argv.includes(`--${name}`);

// --- Parked-feature guard ----------------------------------------------
// Weather (and with it the wind particles) is parked behind WEATHER_ENABLED
// in src/core/features/flags.ts. With the flag off the Wind layer cannot be
// selected at all, so the setup flow strands the app on a plain map and the
// pixel diff reads ~0 — a RED gate on a feature that is deliberately absent,
// which is noise, not signal.
//
// The honest handling is to refuse to run and say why, rather than to keep
// gating (always red) or to loosen the thresholds (always green on nothing).
// The flag is read from the TS source rather than duplicated here, so the
// gate comes back by itself the moment the constant flips — no second switch
// to remember. `npm run wind:motion` is not wired into any GitHub workflow
// (checked: ci.yml, nightly.yml, e2e.yml), so nothing in CI turns red or
// silently green either way; this only affects local/manual runs.
const flagsSrc = readFileSync(new URL('../src/core/features/flags.ts', import.meta.url), 'utf8');
if (/export const WEATHER_ENABLED: boolean = false;/.test(flagsSrc)) {
  console.log('=== wind:motion SKIPPED — the weather feature is PARKED ===');
  console.log('WEATHER_ENABLED is false in src/core/features/flags.ts, so the app has no');
  console.log('Wind layer to measure: the Weather row in the Overlays menu ships disabled');
  console.log('("Coming soon") and .maestro/wind-motion.yaml cannot reach the overlay.');
  console.log('');
  console.log('This gate is NOT passing — it did not run. To restore it, set');
  console.log('WEATHER_ENABLED = true, rebuild the app, and run this command again.');
  process.exit(0);
}

const APP = flag('app');
const FLOW = flag('flow', '.maestro/wind-motion.yaml');
const SETTLE_MS = Number(flag('settle', 15000));
const GAP_MS = Number(flag('gap', 3000));
const MIN_DIFF = Number(flag('min-diff', 2000));
// Per-channel sum that counts as "this pixel changed" — above sensor/encoder
// noise, far below a streak crossing the drape (~100 per channel).
const PIXEL_DELTA = 12;
// Chrome to ignore: the status bar/top controls and the legend + scrubber +
// tab bar. Fractions of image height.
const CROP_TOP = 0.12;
const CROP_BOTTOM = 0.76;
// The map must show motion in at least this many of the BANDS horizontal
// slices, so a clock tick or one re-tiled quadrant cannot pass.
const BANDS = 8;
const MIN_ACTIVE_BANDS = 4;

const sh = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function bootedDevice() {
  const out = sh('xcrun', ['simctl', 'list', 'devices', '-j']);
  for (const list of Object.values(JSON.parse(out).devices)) {
    for (const d of list) if (d.state === 'Booted') return d.udid;
  }
  throw new Error('no booted simulator — boot one or pass --device <udid>');
}

// --- minimal PNG decode (8-bit RGB/RGBA, non-interlaced) ---------------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colorType = data[9];
      if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`);
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
      if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function capture(device, path) {
  sh('xcrun', ['simctl', 'io', device, 'screenshot', path]);
  return decodePng(readFileSync(path));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- main --------------------------------------------------------------
const device = flag('device') ?? bootedDevice();
const work = mkdtempSync(join(tmpdir(), 'wind-motion-'));
const shotA = join(work, 'a.png');
const shotB = join(work, 'b.png');

try {
  if (APP) {
    if (!existsSync(APP)) throw new Error(`app bundle not found: ${APP}`);
    console.log(`installing ${APP}`);
    sh('xcrun', ['simctl', 'install', device, APP]);
  }

  if (!has('no-flow')) {
    if (!existsSync(FLOW)) throw new Error(`flow not found: ${FLOW}`);
    console.log(`driving ${FLOW} on ${device}`);
    execFileSync('maestro', ['--device', device, 'test', FLOW], { stdio: 'inherit' });
  }

  console.log(`settling ${SETTLE_MS} ms, then two captures ${GAP_MS} ms apart`);
  await sleep(SETTLE_MS);
  const a = capture(device, shotA);
  await sleep(GAP_MS);
  const b = capture(device, shotB);

  if (a.width !== b.width || a.height !== b.height) {
    throw new Error('captures differ in size — the app changed layout mid-check');
  }

  const y0 = Math.floor(a.height * CROP_TOP);
  const y1 = Math.floor(a.height * CROP_BOTTOM);
  const bandHeight = Math.max(1, Math.floor((y1 - y0) / BANDS));
  const perBand = new Array(BANDS).fill(0);
  let diff = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * a.width * a.channels;
    for (let x = 0; x < a.width; x++) {
      const i = row + x * a.channels;
      const d =
        Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (d > PIXEL_DELTA) {
        diff++;
        const band = Math.min(BANDS - 1, Math.floor((y - y0) / bandHeight));
        perBand[band]++;
      }
    }
  }
  // A band counts as active with at least 0.5% of the average band's quota,
  // which keeps one busy band from carrying the whole frame.
  const bandFloor = Math.max(20, Math.floor(MIN_DIFF / (BANDS * 4)));
  const activeBands = perBand.filter((n) => n >= bandFloor).length;

  console.log(`differing pixels: ${diff} (threshold ${MIN_DIFF})`);
  console.log(`per band: ${perBand.join(', ')}`);
  console.log(
    `active bands: ${activeBands} of ${BANDS} (need ${MIN_ACTIVE_BANDS}, floor ${bandFloor})`,
  );

  if (diff < MIN_DIFF) {
    console.error(
      `FAIL: the wind overlay is not animating — only ${diff} pixels changed in ${GAP_MS} ms.`,
    );
    process.exitCode = 1;
  } else if (activeBands < MIN_ACTIVE_BANDS) {
    console.error(
      `FAIL: motion is confined to ${activeBands} band(s) — that is a clock tick or a re-tile, not wind.`,
    );
    process.exitCode = 1;
  } else {
    console.log('PASS: wind particles are animating across the map.');
  }
  if (has('keep')) console.log(`captures kept in ${work}`);
} finally {
  if (!has('keep')) rmSync(work, { recursive: true, force: true });
}

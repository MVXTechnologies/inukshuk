#!/usr/bin/env node
/**
 * Pixel check for `.maestro/pdf-overlays.yaml` (#331): did the PDF overlay
 * actually draw on the map?
 *
 * The flow parks the GPS inside the large-JPEG fixture and screenshots the
 * map tab. The fixture page is four saturated quadrants (red / green / blue /
 * yellow — `LARGE_JPEG_QUADRANTS` in scripts/catalog/make-fixture.ts) under a
 * noise texture, drawn at raster-opacity 0.92 over the basemap. A basemap
 * alone is pastel (land beige, water pale blue, roads white/grey); an overlay
 * that drew paints most of the central screen with one of those saturated
 * colours. So: sample a grid over the central 60 % of the screenshot (UI chrome
 * — top status/search area, bottom rail — is excluded) and require that at
 * least MIN_COVERED of the samples are "fixture-coloured": high saturation and
 * near one of the four quadrant colours after the 0.92 blend.
 *
 * Usage: node scripts/e2e/check-overlay-screenshot.mjs <screenshot.png> [min-fraction]
 * Exit 0 when the overlay is visible, 1 otherwise (prints the coverage).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const UPNG = require('upng-js');

const QUADRANTS = [
  [220, 40, 40],
  [30, 200, 60],
  [30, 60, 220],
  [230, 210, 40],
];
// Noise is ±35 per channel and JPEG + resampling smear it further; the blend
// with a pastel basemap at 0.92 shifts channels by at most ~20.
const TOLERANCE = 90;

const [, , file, minArg] = process.argv;
if (!file) {
  console.error('usage: check-overlay-screenshot.mjs <screenshot.png> [min-fraction]');
  process.exit(2);
}
const MIN_COVERED = minArg ? Number(minArg) : 0.5;

const png = UPNG.decode(readFileSync(file));
const rgba = new Uint8Array(UPNG.toRGBA8(png)[0]);
const { width, height } = png;

function fixtureColoured(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 70) return false; // grey/pastel basemap, white roads, labels
  return QUADRANTS.some(
    ([qr, qg, qb]) =>
      Math.abs(r - qr) <= TOLERANCE &&
      Math.abs(g - qg) <= TOLERANCE &&
      Math.abs(b - qb) <= TOLERANCE,
  );
}

const STEPS = 24;
let covered = 0;
let total = 0;
for (let i = 0; i < STEPS; i++) {
  for (let j = 0; j < STEPS; j++) {
    // Central 60 % of both axes.
    const x = Math.floor(width * (0.2 + (0.6 * (i + 0.5)) / STEPS));
    const y = Math.floor(height * (0.2 + (0.6 * (j + 0.5)) / STEPS));
    const k = (y * width + x) * 4;
    total += 1;
    if (fixtureColoured(rgba[k], rgba[k + 1], rgba[k + 2])) covered += 1;
  }
}
const fraction = covered / total;
const verdict = fraction >= MIN_COVERED ? 'OK' : 'FAIL';
console.log(
  `${verdict}: ${covered}/${total} central samples carry the fixture's colours ` +
    `(${(fraction * 100).toFixed(1)} %, need ${(MIN_COVERED * 100).toFixed(0)} %) in ${file} (${width}×${height})`,
);
process.exit(fraction >= MIN_COVERED ? 0 : 1);

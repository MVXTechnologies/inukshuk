/**
 * Vertical-datum gate for the /dem LiDAR tiles (#725, infra/tiles/DEM-VALIDATION.md).
 *
 * The fixture (written by infra/tiles/nas/dem/validate.py) holds, per site, a
 * 32 × 32-px crop of the z16 tile /dem serves — Mapterhorn's tile cut by the
 * NAS transcoder — and the height the agency's own service gives at points
 * inside it: NRCan HRDEM WCS (CGVD2013), swisstopo's height service (LN02),
 * IGN's LiDAR HD altimetry (NGF-IGN69). Decoded here with the Worker's own
 * Terrarium decoder, each site must agree within the product's stated
 * accuracy, with no datum offset.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import * as zlib from 'zlib';

import { decodeTerrariumPng } from './contourMath';

interface Site {
  id: string;
  region: string;
  tool: 'hrdem-wcs' | 'swisstopo-height' | 'ign-lidarhd';
  datum: string;
  tile: [number, number, number];
  crop: [number, number, number];
  png: string;
  official: [number, number, number][];
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'dem', 'validation.json'), 'utf8'),
) as { cropSize: number; sites: Site[] };
const sitesFile = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'nas', 'dem', 'validation-sites.json'), 'utf8'),
) as { sites: { id: string }[] };

/**
 * Tolerances, metres (DEM-VALIDATION.md §Tolerances): a datum error shows as a
 * bias, so |mean| is held at 0.15 m — an ellipsoidal or global-geoid height
 * (tens of metres off) or a swapped national height system (decimetres) fails
 * it; RMS and max follow each product's stated 1σ, plus the resampling onto
 * Web Mercator pixels.
 */
const TOLERANCE: Record<
  Site['tool'],
  { bias: number; rms: (h: number) => number; max: (h: number) => number }
> = {
  // HRDEM lidar DTM. Both grids are 2.39 m Web Mercator pixels resampled
  // from the 2 m mosaic by different software: on a 45° slope half a pixel of
  // offset is 1.2 m, hence a max of 1.5 m rather than 3σ.
  'hrdem-wcs': { bias: 0.15, rms: () => 0.35, max: () => 1.5 },
  // swissALTI3D: ±0.3 m (1σ) below 2000 m, ±1–3 m above (swisstopo product info); max 3σ.
  'swisstopo-height': {
    bias: 0.15,
    rms: (h) => (h > 2000 ? 1.0 : 0.3),
    max: (h) => (h > 2000 ? 3.0 : 0.9),
  },
  // LiDAR HD MNT (IGN), the product Mapterhorn takes in France; max 3σ.
  'ign-lidarhd': { bias: 0.15, rms: () => 0.3, max: () => 0.9 },
};

const inflate = async (d: Uint8Array) => new Uint8Array(zlib.inflateSync(d));

async function differences(site: Site): Promise<number[]> {
  const dem = await decodeTerrariumPng(new Uint8Array(Buffer.from(site.png, 'base64')), inflate);
  expect([dem.width, dem.height]).toEqual([fixture.cropSize, fixture.cropSize]);
  return site.official.map(([px, py, h]) => dem.data[py * dem.width + px]! - h);
}

describe('/dem heights against the agencies’ own services', () => {
  it('covers every validation site, in both regions and all three datums', () => {
    expect(fixture.sites.map((s) => s.id)).toEqual(sitesFile.sites.map((s) => s.id));
    expect(new Set(fixture.sites.map((s) => s.region))).toEqual(
      new Set(['dem-quebec', 'dem-alps']),
    );
    expect(new Set(fixture.sites.map((s) => s.datum))).toEqual(
      new Set(['CGVD2013', 'LN02', 'NGF-IGN69']),
    );
  });

  it.each(fixture.sites.map((s) => [s.id, s] as const))('%s', async (_id, site) => {
    const d = await differences(site);
    expect(d.length).toBeGreaterThanOrEqual(12);
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const rms = Math.sqrt(d.reduce((a, b) => a + b * b, 0) / d.length);
    const height = site.official.reduce((a, [, , h]) => a + h, 0) / site.official.length;
    const tol = TOLERANCE[site.tool];
    expect(Math.abs(mean)).toBeLessThanOrEqual(tol.bias);
    expect(rms).toBeLessThanOrEqual(tol.rms(height));
    expect(Math.max(...d.map(Math.abs))).toBeLessThanOrEqual(tol.max(height));
  });
});

import { cropRasterToBbox, mercatorPixel } from './cropRaster';
import type { BoundingBox } from '@core/models';

// One z10 tile: x=300..301, y=352..353 covers roughly lng [-74.5, -73.8],
// lat [45.6, 46.1] — build a 2-tile-wide, 1-tile-tall raster (512×256).
const RANGE = { z: 10, minX: 300, maxX: 301, minY: 352, maxY: 352 };

function makeRaster(): { data: Uint8Array; width: number; height: number } {
  const width = 512;
  const height = 256;
  const data = new Uint8Array(width * height * 4);
  // Encode the absolute pixel coordinates into the channels so a crop's
  // content proves where it came from: R = x % 256, G = y % 256.
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x % 256;
      data[i + 1] = y % 256;
      data[i + 3] = 255;
    }
  return { data, width, height };
}

describe('mercatorPixel', () => {
  it('maps tile-corner coordinates to tile-edge pixels', () => {
    // North-west corner of tile (300, 352) at z10.
    const nwLng = (300 / 1024) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * 352) / 1024;
    const nwLat = (180 / Math.PI) * Math.atan(Math.sinh(n));
    const p = mercatorPixel(nwLng, nwLat, RANGE);
    expect(p.x).toBeCloseTo(0, 3);
    expect(p.y).toBeCloseTo(0, 3);
  });
});

describe('cropRasterToBbox', () => {
  it('cuts exactly the pixels under the bbox', () => {
    const raster = makeRaster();
    // A bbox spanning pixel columns ~[100..300] across the two tiles.
    const lngA = ((300 * 256 + 100) / (1024 * 256)) * 360 - 180;
    const lngB = ((300 * 256 + 300) / (1024 * 256)) * 360 - 180;
    const yPx = 352 * 256 + 60;
    const yPx2 = 352 * 256 + 200;
    const latTop =
      (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * yPx) / (1024 * 256)));
    const latBot =
      (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * yPx2) / (1024 * 256)));
    const bbox: BoundingBox = { minLng: lngA, maxLng: lngB, minLat: latBot, maxLat: latTop };

    const crop = cropRasterToBbox(raster, RANGE, bbox);
    expect(crop.width).toBe(200);
    expect(crop.height).toBe(140);
    // Top-left pixel of the crop should be source pixel (100, 60).
    expect(crop.data[0]).toBe(100 % 256);
    expect(crop.data[1]).toBe(60);
    // Last row/col pixel maps to source (299, 199).
    const li = ((crop.height - 1) * crop.width + (crop.width - 1)) * 4;
    expect(crop.data[li]).toBe(299 % 256);
    expect(crop.data[li + 1]).toBe(199);
  });

  it('clamps a bbox that leaks past the raster', () => {
    const raster = makeRaster();
    const bbox: BoundingBox = { minLng: -180, maxLng: 180, minLat: -80, maxLat: 80 };
    const crop = cropRasterToBbox(raster, RANGE, bbox);
    expect(crop.width).toBe(512);
    expect(crop.height).toBe(256);
  });
});

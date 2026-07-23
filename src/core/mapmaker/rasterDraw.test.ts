import { blendRgbaOver, drawPolylineRgba } from './rasterDraw';

const raster = (w: number, h: number, fill: [number, number, number, number]) => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(fill, i * 4);
  return { data, width: w, height: h };
};

describe('blendRgbaOver', () => {
  it('alpha-composites the source over the destination with a global opacity', () => {
    const dst = raster(2, 1, [100, 100, 100, 255]);
    const src = raster(2, 1, [200, 0, 0, 255]);
    // Fully transparent src pixel leaves dst alone.
    src.data[7] = 0;
    blendRgbaOver(dst.data, src.data, 0.5);
    expect(dst.data[0]).toBe(150); // 100*(1-0.5) + 200*0.5
    expect(dst.data[1]).toBe(50);
    expect(dst.data[4]).toBe(100); // untouched under transparent src
  });

  it('scales by the source pixel alpha too', () => {
    const dst = raster(1, 1, [0, 0, 0, 255]);
    const src = raster(1, 1, [255, 255, 255, 128]);
    blendRgbaOver(dst.data, src.data, 1);
    expect(dst.data[0]).toBeGreaterThan(120);
    expect(dst.data[0]).toBeLessThan(136);
  });
});

describe('drawPolylineRgba', () => {
  it('paints a horizontal line of the requested thickness', () => {
    const r = raster(9, 9, [255, 255, 255, 255]);
    drawPolylineRgba(
      r,
      [
        { x: 1, y: 4 },
        { x: 7, y: 4 },
      ],
      [255, 0, 0, 255],
      1,
    );
    const at = (x: number, y: number) => r.data[(y * 9 + x) * 4];
    expect(at(4, 4)).toBe(255);
    expect(r.data[(4 * 9 + 4) * 4 + 1]).toBe(0); // green killed on the line
    expect(at(4, 2)).toBe(255); // two rows away untouched (still white)
    expect(r.data[(2 * 9 + 4) * 4 + 1]).toBe(255);
  });

  it('clips outside points instead of wrapping', () => {
    const r = raster(5, 5, [255, 255, 255, 255]);
    drawPolylineRgba(
      r,
      [
        { x: -10, y: 2 },
        { x: 20, y: 2 },
      ],
      [0, 0, 0, 255],
      1,
    );
    // Row 2 darkened; row 1 and 3 stay white at the extremes (no wrap smear).
    expect(r.data[(2 * 5 + 0) * 4]).toBe(0);
    expect(r.data[(1 * 5 + 4) * 4]).toBe(255);
  });
});

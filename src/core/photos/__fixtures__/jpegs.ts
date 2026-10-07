import jpeg from 'jpeg-js';

/**
 * Test JPEGs (#587): a real baseline JPEG from jpeg-js, and the same with a
 * camera-style EXIF APP1 carrying an orientation and a GPS stand-in, plus a
 * Motion Photo trailer after EOI.
 */

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function seg(marker: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload];
}

/** A real 16×8 JPEG (SOI, APP0, DQT, SOF, DHT, SOS … EOI). */
export function realJpeg(seed = 7): Uint8Array {
  const w = 16;
  const h = 8;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([(i * seed) & 0xff, 255 - i, 128, 255], i * 4);
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, 90).data);
}

/** EXIF APP1 with Orientation and a GPS IFD pointer (little-endian). */
function exifWithGps(orientation: number): number[] {
  const le16 = (v: number) => [v & 0xff, v >> 8];
  const le32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24];
  const tiff = [
    0x49,
    0x49,
    ...le16(42),
    ...le32(8),
    ...le16(2),
    ...le16(0x8825),
    ...le16(4),
    ...le32(1),
    ...le32(38),
    ...le16(0x0112),
    ...le16(3),
    ...le32(1),
    ...le16(orientation),
    0,
    0,
    ...le32(0),
    ...ascii('GPS 47.6675 N 70.6132 W'),
  ];
  return seg(0xe1, [...ascii('Exif'), 0, 0, ...tiff]);
}

/** A camera-like JPEG: EXIF with GPS after APP0, and a Motion Photo MP4 after EOI. */
export function jpegWithGps(orientation = 6): Uint8Array {
  const base = realJpeg();
  const app0Len = (base[4]! << 8) | base[5]!;
  const cut = 4 + app0Len;
  return new Uint8Array([
    ...base.subarray(0, cut),
    ...exifWithGps(orientation),
    ...base.subarray(cut),
    ...ascii('ftypmp42 MotionPhoto GPS 47.6675'),
  ]);
}

/** Whether the bytes still contain the GPS stand-in or the Motion Photo trailer. */
export function hasLocation(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes);
  return b.includes(Buffer.from('GPS 47.6675')) || b.includes(Buffer.from('MotionPhoto'));
}

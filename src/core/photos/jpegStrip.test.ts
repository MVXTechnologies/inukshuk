import jpeg from 'jpeg-js';

import { orientationApp1, readExifOrientation, stripJpegMetadata } from './jpegStrip';

const seg = (marker: number, payload: number[]): number[] => {
  const len = payload.length + 2;
  return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload];
};
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** An EXIF APP1 payload with Orientation and a (fake) GPS IFD pointer, little-endian. */
function exifPayload(orientation: number, littleEndian = true): number[] {
  const le16 = (v: number) => (littleEndian ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const le32 = (v: number) =>
    littleEndian
      ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24]
      : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  const tiff = [
    ...(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...le16(42),
    ...le32(8),
    ...le16(2), // two entries
    ...le16(0x8825),
    ...le16(4),
    ...le32(1),
    ...le32(38), // GPSInfo pointer
    ...le16(0x0112),
    ...le16(3),
    ...le32(1),
    ...le16(orientation),
    0,
    0, // Orientation
    ...le32(0),
    ...ascii('GPS 47.6675 N 70.6132 W'), // stands in for the GPS IFD
  ];
  return [...ascii('Exif'), 0, 0, ...tiff];
}

/** A real 16×8 JPEG from jpeg-js (SOI, APP0, DQT, SOF, DHT, SOS … EOI). */
function realJpeg(): Uint8Array {
  const w = 16;
  const h = 8;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([i * 7, 255 - i, 128, 255], i * 4);
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, 90).data);
}

/** Insert segments right after SOI + APP0 (where cameras put EXIF). */
function withSegments(base: Uint8Array, extra: number[]): Uint8Array {
  const app0Len = (base[4]! << 8) | base[5]!;
  const cut = 4 + app0Len;
  return new Uint8Array([...base.subarray(0, cut), ...extra, ...base.subarray(cut)]);
}

const has = (bytes: Uint8Array, needle: string) => Buffer.from(bytes).includes(Buffer.from(needle));

describe('stripJpegMetadata', () => {
  const base = realJpeg();
  const dirty = withSegments(base, [
    ...seg(0xe1, exifPayload(1)),
    ...seg(0xe1, [
      ...ascii('http://ns.adobe.com/xap/1.0/\0'),
      ...ascii('<x:xmpmeta GPSLatitude="47.66"/>'),
    ]),
    ...seg(0xed, ascii('Photoshop 3.0\0IPTC Lac des Cygnes')),
    ...seg(0xfe, ascii('shot near the summit')),
    ...seg(0xe2, ascii('ICC_PROFILE\0keep me')),
    ...seg(0xe5, ascii('maker junk')),
  ]);

  it('removes EXIF, XMP, IPTC, comments and other APPn; keeps ICC; still decodes the same', () => {
    expect(has(dirty, 'GPS 47.6675')).toBe(true);
    const r = stripJpegMetadata(dirty);
    expect(r.jpeg).toBe(true);
    expect(r.removed).toBe(5);
    expect(r.orientation).toBe(1);
    for (const s of ['GPS 47.6675', 'xmpmeta', 'IPTC', 'summit', 'maker junk', 'Exif']) {
      expect(has(r.bytes, s)).toBe(false);
    }
    expect(has(r.bytes, 'ICC_PROFILE')).toBe(true);
    expect(r.bytes).toEqual(withSegments(base, seg(0xe2, ascii('ICC_PROFILE\0keep me'))));
    const a = jpeg.decode(base);
    const b = jpeg.decode(r.bytes);
    expect(Buffer.from(b.data).equals(Buffer.from(a.data))).toBe(true);
  });

  it('is a no-op on an already clean JPEG', () => {
    const r = stripJpegMetadata(base);
    expect(r.removed).toBe(0);
    expect(r.bytes).toEqual(base);
    expect(r).not.toHaveProperty('orientation');
  });

  it.each([6, 8, 3])('keeps orientation %i as a minimal APP1 after JFIF', (o) => {
    const r = stripJpegMetadata(withSegments(base, seg(0xe1, exifPayload(o, false))));
    expect(r.orientation).toBe(o);
    expect(has(r.bytes, 'GPS 47.6675')).toBe(false);
    // SOI, APP0, then the orientation-only APP1.
    const app0Len = (r.bytes[4]! << 8) | r.bytes[5]!;
    const at = 4 + app0Len;
    expect(r.bytes[at]).toBe(0xff);
    expect(r.bytes[at + 1]).toBe(0xe1);
    const len = (r.bytes[at + 2]! << 8) | r.bytes[at + 3]!;
    expect(readExifOrientation(r.bytes.subarray(at + 4, at + 2 + len))).toBe(o);
    expect(jpeg.decode(r.bytes).width).toBe(16);
  });

  it('puts the orientation right after SOI when there is no JFIF', () => {
    const noJfif = new Uint8Array([
      0xff,
      0xd8,
      ...seg(0xe1, exifPayload(6)),
      ...base.subarray(4 + ((base[4]! << 8) | base[5]!)),
    ]);
    const r = stripJpegMetadata(noJfif);
    expect([...r.bytes.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xe1]);
  });

  it('returns non-JPEG and corrupt input unchanged', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]);
    expect(stripJpegMetadata(png)).toEqual({ bytes: png, jpeg: false, removed: 0 });
    const truncated = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40, 1, 2]);
    expect(stripJpegMetadata(truncated).jpeg).toBe(false);
    const garbage = new Uint8Array([0xff, 0xd8, 0x12, 0x34]);
    expect(stripJpegMetadata(garbage).jpeg).toBe(false);
    const badLen = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01]);
    expect(stripJpegMetadata(badLen).jpeg).toBe(false);
    const noLen = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00]);
    expect(stripJpegMetadata(noLen).jpeg).toBe(false);
  });

  it('passes standalone markers, fill bytes and data after EOI through', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xd0, 0xff, 0xd9, 0xaa]);
    const r = stripJpegMetadata(bytes);
    expect(r.jpeg).toBe(true);
    expect([...r.bytes]).toEqual([0xff, 0xd8, 0xff, 0xd0, 0xff, 0xd9, 0xaa]);
    // Trailing fill bytes with no marker: kept as they were.
    const tail = new Uint8Array([0xff, 0xd8, 0xff, 0xff]);
    expect(stripJpegMetadata(tail).bytes).toEqual(tail);
  });
});

describe('readExifOrientation', () => {
  it('reads both byte orders and rejects anything else', () => {
    expect(readExifOrientation(new Uint8Array(exifPayload(6, true)))).toBe(6);
    expect(readExifOrientation(new Uint8Array(exifPayload(8, false)))).toBe(8);
    expect(readExifOrientation(new Uint8Array(exifPayload(9)))).toBeUndefined();
    expect(
      readExifOrientation(new Uint8Array(ascii('http://ns.adobe.com/xap/1.0/'))),
    ).toBeUndefined();
    const notTiff = new Uint8Array([...ascii('Exif'), 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(readExifOrientation(notTiff)).toBeUndefined();
    const bad42 = new Uint8Array([...ascii('Exif'), 0, 0, 0x49, 0x49, 41, 0, 8, 0, 0, 0]);
    expect(readExifOrientation(bad42)).toBeUndefined();
    const noTag = new Uint8Array([...ascii('Exif'), 0, 0, 0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0]);
    expect(readExifOrientation(noTag)).toBeUndefined();
    const ifdPastEnd = new Uint8Array([...ascii('Exif'), 0, 0, 0x49, 0x49, 42, 0, 0xff, 0, 0, 0]);
    expect(readExifOrientation(ifdPastEnd)).toBeUndefined();
  });

  it('round-trips the minimal segment', () => {
    const app1 = orientationApp1(5);
    expect(readExifOrientation(app1.subarray(4))).toBe(5);
  });
});

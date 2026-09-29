import { strToU8, zipSync } from 'fflate';

import { memoryByteSource } from '@core/geo/geopdf/pdfReader';

import {
  ZIP_READ_CHUNK,
  ZipFormatError,
  listZipEntries,
  looksLikeZip,
  pumpZipEntry,
  type SourceOpener,
} from './zip';

const opener =
  (bytes: Uint8Array): SourceOpener =>
  (fn) =>
    fn(memoryByteSource(bytes));

async function readAll(bytes: Uint8Array, name: string): Promise<Uint8Array> {
  const entry = listZipEntries(memoryByteSource(bytes)).find((e) => e.name === name);
  if (!entry) throw new Error(`missing ${name}`);
  const chunks: number[] = [];
  await pumpZipEntry(opener(bytes), entry, (c) => chunks.push(...c));
  return Uint8Array.from(chunks);
}

/** Hand-written stored-only ZIP writer, optionally in ZIP64 form. */
function storedZip(files: Record<string, Uint8Array>, zip64 = false): Uint8Array {
  const out: number[] = [];
  const central: number[] = [];
  const le = (v: number, n: number) => {
    const b: number[] = [];
    for (let i = 0; i < n; i++) {
      b.push(Math.floor(v / 2 ** (8 * i)) & 0xff);
    }
    return b;
  };
  const names = Object.keys(files);
  for (const name of names) {
    const data = files[name]!;
    const nameBytes = [...strToU8(name)];
    const offset = out.length;
    out.push(...le(0x04034b50, 4), ...le(20, 2), ...le(0, 2), ...le(0, 2), ...le(0, 4));
    out.push(...le(0, 4), ...le(data.length, 4), ...le(data.length, 4));
    out.push(...le(nameBytes.length, 2), ...le(0, 2), ...nameBytes, ...data);
    const extra = zip64
      ? [...le(1, 2), ...le(24, 2), ...le(data.length, 8), ...le(data.length, 8), ...le(offset, 8)]
      : [];
    const sat = (v: number) => (zip64 ? 0xffffffff : v);
    central.push(...le(0x02014b50, 4), ...le(45, 2), ...le(45, 2), ...le(0x800, 2), ...le(0, 2));
    central.push(...le(0, 4), ...le(0, 4), ...le(sat(data.length), 4), ...le(sat(data.length), 4));
    central.push(...le(nameBytes.length, 2), ...le(extra.length, 2), ...le(0, 2), ...le(0, 2));
    central.push(...le(0, 2), ...le(0, 4), ...le(sat(offset), 4), ...nameBytes, ...extra);
  }
  const cdOffset = out.length;
  out.push(...central);
  if (zip64) {
    const rec = out.length;
    out.push(...le(0x06064b50, 4), ...le(44, 8), ...le(45, 2), ...le(45, 2), ...le(0, 4));
    out.push(...le(0, 4), ...le(names.length, 8), ...le(names.length, 8));
    out.push(...le(central.length, 8), ...le(cdOffset, 8));
    out.push(...le(0x07064b50, 4), ...le(0, 4), ...le(rec, 8), ...le(1, 4));
  }
  const s16 = (v: number) => (zip64 ? 0xffff : v);
  const s32 = (v: number) => (zip64 ? 0xffffffff : v);
  out.push(...le(0x06054b50, 4), ...le(0, 4), ...le(s16(names.length), 2));
  out.push(...le(s16(names.length), 2), ...le(s32(central.length), 4), ...le(s32(cdOffset), 4));
  out.push(...le(0, 2));
  return Uint8Array.from(out);
}

describe('zip reader', () => {
  it('lists and reads stored and deflated entries', async () => {
    const zip = zipSync({
      'a/stored.txt': [strToU8('hello stored'), { level: 0 }],
      'b/deflated.txt': [strToU8('hello deflated '.repeat(200)), { level: 9 }],
      'empty.txt': [new Uint8Array(0), { level: 6 }],
    });
    expect(looksLikeZip(zip)).toBe(true);
    const entries = listZipEntries(memoryByteSource(zip));
    expect(entries.map((e) => e.name)).toEqual(['a/stored.txt', 'b/deflated.txt', 'empty.txt']);
    expect(entries[1]!.method).toBe(8);
    expect(new TextDecoder().decode(await readAll(zip, 'a/stored.txt'))).toBe('hello stored');
    expect(new TextDecoder().decode(await readAll(zip, 'b/deflated.txt'))).toBe(
      'hello deflated '.repeat(200),
    );
    expect(await readAll(zip, 'empty.txt')).toHaveLength(0);
  });

  it('pumps a large entry in several slices, yielding between them', async () => {
    const big = new Uint8Array(ZIP_READ_CHUNK * 2 + 123);
    let seed = 7;
    for (let i = 0; i < big.length; i++) {
      // xorshift32: incompressible, so the deflated form also spans slices.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      big[i] = seed & 0xff;
    }
    for (const level of [0, 1] as const) {
      const zip = zipSync({ 'big.bin': [big, { level }] });
      const entry = listZipEntries(memoryByteSource(zip))[0]!;
      let total = 0;
      const between = jest.fn(() => Promise.resolve());
      await pumpZipEntry(opener(zip), entry, (c) => (total += c.length), between);
      expect(total).toBe(big.length);
      expect(between).toHaveBeenCalled();
    }
  });

  it('reads ZIP64 archives', async () => {
    const zip = storedZip({ 'x.fit': strToU8('abc'), 'y.gpx': strToU8('defg') }, true);
    const entries = listZipEntries(memoryByteSource(zip));
    expect(entries.map((e) => [e.name, e.uncompressedSize])).toEqual([
      ['x.fit', 3],
      ['y.gpx', 4],
    ]);
    expect(new TextDecoder().decode(await readAll(zip, 'y.gpx'))).toBe('defg');
    // And the plain form of the same writer.
    expect(listZipEntries(memoryByteSource(storedZip({ 'z.tcx': strToU8('z') })))).toHaveLength(1);
  });

  it('rejects corrupt archives with a typed error', async () => {
    const zip = zipSync({ 'a.txt': strToU8('a') });
    const src = (b: Uint8Array) => memoryByteSource(b);
    expect(() => listZipEntries(src(strToU8('not a zip at all')))).toThrow(ZipFormatError);
    expect(() => listZipEntries(src(new Uint8Array(0)))).toThrow(ZipFormatError);

    const badCentral = zip.slice();
    const cd = listZipEntries(src(zip))[0]!;
    // Corrupt the central-directory signature (it follows the local entry).
    const cdAt = 30 + cd.name.length + cd.compressedSize;
    badCentral[cdAt] = 0;
    expect(() => listZipEntries(src(badCentral))).toThrow(ZipFormatError);

    const cdOut = zip.slice();
    // Point the directory offset past the end.
    const eocd = zip.length - 22;
    new DataView(cdOut.buffer).setUint32(eocd + 16, zip.length * 2, true);
    expect(() => listZipEntries(src(cdOut))).toThrow(ZipFormatError);

    const zip64NoLocator = zip.slice();
    new DataView(zip64NoLocator.buffer).setUint16(eocd + 10, 0xffff, true);
    expect(() => listZipEntries(src(zip64NoLocator))).toThrow(ZipFormatError);

    const badLocal = zip.slice();
    badLocal[0] = 0;
    await expect(pumpZipEntry(opener(badLocal), cd, () => {})).rejects.toThrow(ZipFormatError);
    await expect(
      pumpZipEntry(opener(zip), { ...cd, compressedSize: zip.length }, () => {}),
    ).rejects.toThrow(ZipFormatError);
    await expect(pumpZipEntry(opener(zip), { ...cd, flags: 1 }, () => {})).rejects.toThrow(
      /encrypted/,
    );
    await expect(pumpZipEntry(opener(zip), { ...cd, method: 12 }, () => {})).rejects.toThrow(
      /unsupported/,
    );
  });
});

/**
 * Test-only FIT *encoder* (like `@core/geo/geopdf/testUtils`) — never imported
 * by the app. Produces real-shaped FIT bytes (header, definition + data
 * messages, compressed-timestamp headers, developer fields, either byte order)
 * so the decoder can be exercised without binary fixtures in the repo.
 */

import { FIT_EPOCH_OFFSET_S } from './index';

export type FitBaseType = 'enum' | 'uint8' | 'uint16' | 'sint32' | 'uint32' | 'string';

const BASE: Record<FitBaseType, { code: number; size: number }> = {
  enum: { code: 0x00, size: 1 },
  uint8: { code: 0x02, size: 1 },
  uint16: { code: 0x84, size: 2 },
  sint32: { code: 0x85, size: 4 },
  uint32: { code: 0x86, size: 4 },
  string: { code: 0x07, size: 8 },
};

export interface FitFieldSpec {
  num: number;
  type: FitBaseType;
}

export class FitWriter {
  private readonly out: number[] = [];
  private readonly defs = new Map<
    number,
    { fields: FitFieldSpec[]; littleEndian: boolean; devSizes: number[] }
  >();

  /** Emit a definition message for `local` → `global`. */
  define(
    local: number,
    global: number,
    fields: FitFieldSpec[],
    opts: { bigEndian?: boolean; devFieldSizes?: number[] } = {},
  ): this {
    const devSizes = opts.devFieldSizes ?? [];
    const littleEndian = !opts.bigEndian;
    this.out.push(0x40 | (devSizes.length > 0 ? 0x20 : 0) | (local & 0x0f));
    this.out.push(0, littleEndian ? 0 : 1);
    this.pushInt(global, 2, littleEndian);
    this.out.push(fields.length);
    for (const f of fields) this.out.push(f.num, BASE[f.type].size, BASE[f.type].code);
    if (devSizes.length > 0) {
      this.out.push(devSizes.length);
      devSizes.forEach((size, i) => this.out.push(i, size, 0));
    }
    this.defs.set(local, { fields, littleEndian, devSizes });
    return this;
  }

  /**
   * Emit a data message. `values` are in field order (undefined = the type's
   * invalid sentinel). `compressedOffset` switches to a compressed-timestamp
   * header (local types 0–3 only).
   */
  data(local: number, values: (number | undefined)[], compressedOffset?: number): this {
    const def = this.defs.get(local);
    if (!def) throw new Error(`no definition for local ${local}`);
    this.out.push(
      compressedOffset === undefined
        ? local & 0x0f
        : 0x80 | ((local & 0x03) << 5) | (compressedOffset & 0x1f),
    );
    def.fields.forEach((f, i) => {
      const v = values[i];
      const { size } = BASE[f.type];
      if (f.type === 'string') {
        for (let b = 0; b < size; b++) this.out.push(0);
        return;
      }
      if (v === undefined) {
        const invalid = f.type === 'sint32' ? 0x7fffffff : 2 ** (8 * size) - 1;
        this.pushInt(invalid, size, def.littleEndian);
      } else {
        this.pushInt(v, size, def.littleEndian);
      }
    });
    for (const size of def.devSizes) for (let b = 0; b < size; b++) this.out.push(0xab);
    return this;
  }

  /** Raw bytes (for malformed-input tests). */
  raw(...bytes: number[]): this {
    this.out.push(...bytes);
    return this;
  }

  /** Wrap the records in a 14-byte (or 12-byte) header plus a trailing CRC placeholder. */
  build(opts: { headerSize?: 12 | 14 } = {}): Uint8Array {
    const headerSize = opts.headerSize ?? 14;
    const body = this.out;
    const bytes = new Uint8Array(headerSize + body.length + 2);
    const view = new DataView(bytes.buffer);
    bytes[0] = headerSize;
    bytes[1] = 0x20;
    view.setUint16(2, 2132, true);
    view.setUint32(4, body.length, true);
    bytes.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
    bytes.set(body, headerSize);
    return bytes;
  }

  private pushInt(value: number, size: number, littleEndian: boolean): void {
    const bytes: number[] = [];
    let v = value < 0 ? value + 2 ** (8 * size) : value;
    for (let i = 0; i < size; i++) {
      bytes.push(v % 256);
      v = Math.floor(v / 256);
    }
    this.out.push(...(littleEndian ? bytes : bytes.reverse()));
  }
}

/** Degrees → FIT semicircles. */
export const toSemicircles = (deg: number): number => Math.round((deg * 2 ** 31) / 180);

/** Unix epoch ms → FIT timestamp seconds. */
export const toFitTime = (ms: number): number => Math.floor(ms / 1000) - FIT_EPOCH_OFFSET_S;

/** Raw FIT altitude for `m` metres (scale 5, offset 500). */
export const toFitAltitude = (m: number): number => Math.round((m + 500) * 5);

export interface SimpleFitPoint {
  lat: number;
  lon: number;
  timeMs: number;
  altM?: number;
  hr?: number;
}

/**
 * A realistic small activity: file_id, session (sport/sub-sport/start), and
 * one record per point with enhanced_altitude and heart rate.
 */
export function buildSimpleFit(
  points: SimpleFitPoint[],
  opts: { sport?: number; subSport?: number; bigEndian?: boolean } = {},
): Uint8Array {
  const w = new FitWriter();
  const first = points[0];
  const start = first ? toFitTime(first.timeMs) : 0;
  w.define(0, 0, [
    { num: 0, type: 'enum' },
    { num: 4, type: 'uint32' },
  ]).data(0, [4, start]);
  w.define(
    1,
    20,
    [
      { num: 253, type: 'uint32' },
      { num: 0, type: 'sint32' },
      { num: 1, type: 'sint32' },
      { num: 78, type: 'uint32' },
      { num: 3, type: 'uint8' },
    ],
    { bigEndian: opts.bigEndian },
  );
  for (const p of points) {
    w.data(1, [
      toFitTime(p.timeMs),
      toSemicircles(p.lat),
      toSemicircles(p.lon),
      p.altM === undefined ? undefined : toFitAltitude(p.altM),
      p.hr,
    ]);
  }
  w.define(2, 18, [
    { num: 253, type: 'uint32' },
    { num: 2, type: 'uint32' },
    { num: 5, type: 'enum' },
    { num: 6, type: 'enum' },
  ]).data(2, [start, start, opts.sport, opts.subSport]);
  return w.build();
}

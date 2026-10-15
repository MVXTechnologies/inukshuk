/**
 * The /dem route's logic (./dem.ts) under the app's Jest: which source answers
 * a tile, the z16 upsample outside coverage, the PNG encoder, the headers and
 * the index parser. The R2/PMTiles reads and AWS fetches are fakes.
 */
import * as zlib from 'zlib';

import { decodeTerrariumPng } from './contourMath';
import {
  AWS_MAX_ZOOM,
  candidatePieces,
  crc32,
  demHeaders,
  demTile,
  encodeTerrariumPng,
  parseDemIndex,
  parseDemPath,
  terrariumRgb,
  tileBounds,
  upsample,
  type DemDeps,
  type DemIndex,
} from './dem';

const inflate = async (d: Uint8Array) => new Uint8Array(zlib.inflateSync(d));
const deflate = async (d: Uint8Array) => new Uint8Array(zlib.deflateSync(d));

/** A 256-px Terrarium PNG whose height is f(px, py). */
async function png(f: (px: number, py: number) => number): Promise<Uint8Array> {
  const h = new Float32Array(256 * 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) h[y * 256 + x] = f(x, y);
  return encodeTerrariumPng(h, 256, deflate);
}

// Mont-Sainte-Anne (Québec): z16 tile 19860/23030 lies in this piece.
const QUEBEC = {
  name: 'dem-quebec',
  bbox: [-71.02, 47.04, -70.84, 47.1] as [number, number, number, number],
  minzoom: 12,
  maxzoom: 16,
};
const INDEX: DemIndex = { pieces: [QUEBEC], mapterhorn: '0.0.13', built: '2026-10-16T05:00:00Z' };
const IN = [16, 19860, 23030] as const;
// Same zoom, Lac-Saint-Jean: outside every piece.
const OUT = [16, 19500, 22700] as const;

function deps(over: Partial<DemDeps> = {}) {
  const archive = new Map<string, Uint8Array>();
  const aws = new Map<string, Uint8Array>();
  const calls = { read: [] as string[], aws: [] as string[] };
  const d: DemDeps = {
    index: async () => INDEX,
    readTile: async (piece, z, x, y) => {
      calls.read.push(`${piece}:${z}/${x}/${y}`);
      return archive.get(`${piece}:${z}/${x}/${y}`);
    },
    fetchAws: async (z, x, y) => {
      calls.aws.push(`${z}/${x}/${y}`);
      return aws.get(`${z}/${x}/${y}`) ?? null;
    },
    inflate,
    deflate,
    ...over,
  };
  return { d, archive, aws, calls };
}

describe('parseDemPath', () => {
  it('accepts z0–16 tiles inside the grid', () => {
    expect(parseDemPath('/dem/16/19860/23030.png')).toEqual([16, 19860, 23030]);
    expect(parseDemPath('/dem/0/0/0.png')).toEqual([0, 0, 0]);
  });

  it('refuses tiles past z16 or off the grid, and ignores other paths', () => {
    expect(parseDemPath('/dem/17/0/0.png')).toBe('bad');
    expect(parseDemPath('/dem/3/8/0.png')).toBe('bad');
    expect(parseDemPath('/dem/3/0/8.png')).toBe('bad');
    expect(parseDemPath('/dem/3/0/0.webp')).toBeNull();
    expect(parseDemPath('/basemap/3/0/0.mvt')).toBeNull();
  });
});

describe('candidatePieces', () => {
  it('keeps the pieces whose zoom range and bbox hold the tile', () => {
    expect(candidatePieces(INDEX, ...IN)).toEqual([QUEBEC]);
    expect(candidatePieces(INDEX, ...OUT)).toEqual([]);
    // Below the piece's minzoom nothing is looked up.
    expect(candidatePieces(INDEX, 11, 620, 719)).toEqual([]);
    expect(candidatePieces(null, ...IN)).toEqual([]);
  });

  it('agrees with tileBounds', () => {
    const [w, s, e, n] = tileBounds(...IN);
    expect(w).toBeLessThan(e);
    expect(s).toBeLessThan(n);
    expect(w).toBeGreaterThan(QUEBEC.bbox[0]);
    expect(n).toBeLessThan(QUEBEC.bbox[3]);
  });
});

describe('demTile', () => {
  it('serves the LiDAR archive’s bytes as they are inside coverage', async () => {
    const { d, archive, calls } = deps();
    const bytes = await png(() => 600.5);
    archive.set(`dem-quebec:${IN.join('/')}`, bytes);
    const tile = await demTile(...IN, d);
    expect(tile).toEqual({ png: bytes, source: 'lidar', piece: 'dem-quebec' });
    expect(calls.aws).toEqual([]);
  });

  it('passes AWS through where the archive has no tile (outside the LiDAR mask)', async () => {
    const { d, aws, calls } = deps();
    const bytes = await png(() => 120);
    aws.set('15/9930/11515', bytes);
    const tile = await demTile(15, 9930, 11515, d);
    expect(tile).toEqual({ png: bytes, source: 'aws' });
    expect(calls.read).toEqual(['dem-quebec:15/9930/11515']);
  });

  it('passes AWS through before the first index is published', async () => {
    const { d, aws, calls } = deps({ index: async () => null });
    aws.set('12/1241/1439', await png(() => 1));
    expect((await demTile(12, 1241, 1439, d))?.source).toBe('aws');
    expect(calls.read).toEqual([]);
  });

  it('answers null when AWS has no tile either', async () => {
    const { d } = deps();
    expect(await demTile(10, 300, 300, d)).toBeNull();
  });

  it('makes z16 outside coverage from its AWS z15 parent, upsampled', async () => {
    const { d, aws, calls } = deps();
    // A ramp of 1 m per parent pixel eastwards and 0.5 m southwards.
    aws.set(`15/${OUT[1] >> 1}/${OUT[2] >> 1}`, await png((x, y) => 100 + x + y / 2));
    const tile = await demTile(...OUT, d);
    expect(tile?.source).toBe('aws-upsampled');
    expect(calls.aws).toEqual([`${AWS_MAX_ZOOM}/${OUT[1] >> 1}/${OUT[2] >> 1}`]);
    const dem = await decodeTerrariumPng(tile!.png, inflate);
    expect([dem.width, dem.height]).toEqual([256, 256]);
    // OUT is the parent's top-left quadrant (both coordinates even): child
    // pixel (i, j) sits at parent (i/2 − 0.25, j/2 − 0.25), clamped at 0.
    const at = (i: number, j: number) => dem.data[j * 256 + i]!;
    const expected = (i: number, j: number) =>
      100 + Math.max(i / 2 - 0.25, 0) + Math.max(j / 2 - 0.25, 0) / 2;
    for (const [i, j] of [
      [0, 0],
      [10, 20],
      [255, 255],
      [128, 3],
    ] as const) {
      expect(at(i, j)).toBeCloseTo(expected(i, j), 2);
    }
  });

  it('upsamples the right quadrant (odd x, odd y = bottom-right)', async () => {
    const { d, aws } = deps();
    aws.set('15/9750/11350', await png((x, y) => (x >= 128 && y >= 128 ? 2000 : 0)));
    const tile = await demTile(16, 19501, 22701, d);
    const dem = await decodeTerrariumPng(tile!.png, inflate);
    // Away from the left/top edge (which blends with the 0 m next to the quadrant).
    let lo = Infinity;
    for (let j = 4; j < 256; j++)
      for (let i = 4; i < 256; i++) lo = Math.min(lo, dem.data[j * 256 + i]!);
    expect(lo).toBe(2000);
    expect(dem.data[0]).toBeLessThan(2000);
  });

  it('serves z16 from the archive inside coverage (no upsample)', async () => {
    const { d, archive, calls } = deps();
    archive.set(`dem-quebec:${IN.join('/')}`, await png(() => 700));
    expect((await demTile(...IN, d))?.source).toBe('lidar');
    expect(calls.aws).toEqual([]);
  });
});

describe('upsample', () => {
  it('keeps a flat surface exactly flat', () => {
    const flat = new Float32Array(256 * 256).fill(812.25);
    expect(new Set(upsample(flat, 256, 128, 0, 128, 256))).toEqual(new Set([812.25]));
  });
});

describe('encodeTerrariumPng', () => {
  it('round-trips every height on the Terrarium grid exactly', async () => {
    const h = new Float32Array(256 * 256);
    for (let i = 0; i < h.length; i++) h[i] = -432 + i / 256; // 1/256 m steps
    h[0] = -32768;
    h[1] = 8848.86328125;
    const bytes = await encodeTerrariumPng(h, 256, deflate);
    const back = await decodeTerrariumPng(bytes, inflate);
    expect(Buffer.from(back.data.buffer).equals(Buffer.from(h.buffer))).toBe(true);
  });

  it('writes valid chunk CRCs', async () => {
    const bytes = await encodeTerrariumPng(new Float32Array(256 * 256), 256, deflate);
    let pos = 8;
    let chunks = 0;
    while (pos < bytes.length) {
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      const length = view.getUint32(pos);
      const body = bytes.subarray(pos + 4, pos + 8 + length);
      expect(view.getUint32(pos + 8 + length)).toBe(zlib.crc32(body));
      pos += 12 + length;
      chunks++;
    }
    expect(chunks).toBe(3);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('quantises to 1/256 m and clamps to the encodable range', () => {
    expect(terrariumRgb(0)).toEqual([128, 0, 0]);
    expect(terrariumRgb(808.5)).toEqual([131, 40, 128]);
    expect(terrariumRgb(-40000)).toEqual([0, 0, 0]);
    expect(terrariumRgb(1e9)).toEqual([255, 255, 255]);
  });
});

describe('demHeaders', () => {
  it('says PNG, never a Content-Encoding, and where the tile came from', () => {
    const tile = { png: new Uint8Array(1), source: 'lidar' as const, piece: 'dem-alps' };
    const h = demHeaders(
      tile,
      'public, max-age=86400',
      { 'Access-Control-Allow-Origin': '*' },
      'v',
    );
    expect(h).toEqual({
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'X-Dem-Source': 'lidar:dem-alps',
      'X-Dem-Version': 'v',
    });
    expect(demHeaders({ png: tile.png, source: 'aws' }, 'c', {}, 'v')).toEqual({
      'Content-Type': 'image/png',
      'Cache-Control': 'c',
      'X-Dem-Source': 'aws',
    });
  });
});

describe('parseDemIndex', () => {
  it('reads the index dem.py writes', () => {
    const json = {
      format: 'terrarium-png-256',
      mapterhorn: '0.0.13',
      built: '2026-10-16T05:00:00Z',
      pieces: [{ ...QUEBEC, bytes: 1, sha256: 'ab', tiles: 3, sources: ['cahrdem2'] }],
    };
    expect(parseDemIndex(json)).toEqual(INDEX);
  });

  it('treats anything malformed as no index (AWS everywhere)', () => {
    expect(parseDemIndex(null)).toBeNull();
    expect(parseDemIndex({})).toBeNull();
    expect(parseDemIndex({ pieces: [{ ...QUEBEC, name: 'basemap' }] })).toBeNull();
    expect(parseDemIndex({ pieces: [{ ...QUEBEC, bbox: [1, 2, 3] }] })).toBeNull();
    expect(parseDemIndex({ pieces: [{ ...QUEBEC, minzoom: '12' }] })).toBeNull();
    expect(parseDemIndex({ pieces: [{ ...QUEBEC, name: '../x' }] })).toBeNull();
  });
});

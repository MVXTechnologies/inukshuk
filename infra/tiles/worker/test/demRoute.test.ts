/**
 * GET /dem/{z}/{x}/{y}.png and the contours that read it, through the Worker's
 * real fetch handler (src/index.ts) with fakes for R2, the edge cache, AWS and
 * the pmtiles reader (not installed at the repo root; mocked here). Mirrors
 * what `wrangler dev` shows (README "Precise elevation (DEM)" has the probe).
 */
import * as zlib from 'zlib';

import worker from '../src/index';

jest.mock('fast-png', () => ({ decode: jest.fn() }), { virtual: true });

/** Archives the fake PMTiles reader serves: key → (z, x, y) → bytes. */
const mockArchives = new Map<
  string,
  { tileType: number; tile: (z: number, x: number, y: number) => Uint8Array | undefined }
>();

jest.mock(
  'pmtiles',
  () => {
    class PMTiles {
      private readonly key: string;
      constructor(mockSource: { getKey(): string }) {
        this.key = mockSource.getKey();
      }
      private archive() {
        const a = mockArchives.get(this.key);
        if (a === undefined) throw new Error(`missing archive ${this.key}`);
        return a;
      }
      async getHeader() {
        return { tileType: this.archive().tileType };
      }
      async getZxy(z: number, x: number, y: number) {
        const t = this.archive().tile(z, x, y);
        return t === undefined
          ? undefined
          : { data: t.buffer.slice(t.byteOffset, t.byteOffset + t.byteLength) };
      }
    }
    return {
      PMTiles,
      ResolvedValueCache: class {},
      EtagMismatch: class extends Error {},
      Compression: { Unknown: 0, None: 1, Gzip: 2 },
      TileType: { Unknown: 0, Mvt: 1, Png: 2 },
    };
  },
  { virtual: true },
);

// --- synthetic terrain -----------------------------------------------------------

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, zlib.crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Rolling hills around `base` m, continuous across tiles, as a 256-px Terrarium PNG. */
function terrainPng(z: number, x: number, y: number, base: number): Uint8Array {
  const raw = new Uint8Array(256 * (256 * 3 + 1));
  for (let py = 0; py < 256; py++) {
    for (let px = 0; px < 256; px++) {
      const s = 2 ** (14 - z);
      const wx = (x * 256 + px) * s;
      const wy = (y * 256 + py) * s;
      const h = base + 60 * Math.sin(wx / 41) + 45 * Math.cos(wy / 33);
      const v = Math.round((h + 32768) * 256);
      const o = py * (256 * 3 + 1) + 1 + px * 3;
      raw[o] = v >> 16;
      raw[o + 1] = (v >> 8) & 255;
      raw[o + 2] = v & 255;
    }
  }
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 256);
  new DataView(ihdr.buffer).setUint32(4, 256);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// Mont-Sainte-Anne: the piece covers z12–16 tiles around it.
const PIECE = {
  name: 'dem-quebec',
  bbox: [-71.02, 47.04, -70.84, 47.1],
  minzoom: 12,
  maxzoom: 16,
};
const INDEX = { mapterhorn: '0.0.13', built: '2026-10-16T05:00:00Z', pieces: [PIECE] };
const IN16 = '16/19860/23030';
const OUT12 = '12/1218/1418'; // Lac-Saint-Jean, outside the piece

// --- fakes -------------------------------------------------------------------------

let r2: Map<string, unknown>;
let r2Puts: string[];
let edge: Map<string, Response>;
let awsFetches: string[];
let pending: Promise<unknown>[];

const env = () => ({
  BUCKET: {
    get: async (key: string) => {
      const v = r2.get(key);
      return v === undefined ? null : { json: async () => v, body: JSON.stringify(v) };
    },
    put: async (key: string) => {
      r2Puts.push(key);
    },
  },
  CACHE_CONTROL: 'public, max-age=86400',
  CONTOUR_DECODE_BUDGET: '9',
});
const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;

async function get(path: string): Promise<Response> {
  const res = await worker.fetch(new Request(`https://tiles.example${path}`), env() as never, ctx);
  await Promise.all(pending);
  pending = [];
  return res;
}

const realFetch = globalThis.fetch;
const realCaches = (globalThis as { caches?: unknown }).caches;

beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url);
    if (m === null) throw new Error(`unexpected fetch ${url}`);
    awsFetches.push(`${m[1]}/${m[2]}/${m[3]}`);
    return new Response(terrainPng(Number(m[1]), Number(m[2]), Number(m[3]), 300), {
      headers: { 'Content-Type': 'image/png' },
    });
  }) as typeof fetch;
  (globalThis as { caches?: unknown }).caches = {
    default: {
      match: async (req: Request) => edge.get(req.url)?.clone(),
      put: async (req: Request, res: Response) => {
        edge.set(req.url, res);
      },
    },
  };
});

afterAll(() => {
  globalThis.fetch = realFetch;
  (globalThis as { caches?: unknown }).caches = realCaches;
});

beforeEach(() => {
  r2 = new Map([['dem.index.json', INDEX]]);
  r2Puts = [];
  edge = new Map();
  awsFetches = [];
  pending = [];
  mockArchives.clear();
  mockArchives.set('dem-quebec.pmtiles', {
    tileType: 2,
    tile: (z, x, y) => {
      // The tile's centre inside the piece's bbox stands for "in the LiDAR mask".
      const n = 2 ** z;
      const lon = ((x + 0.5) / n) * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
      const inside = lon > -71.02 && lon < -70.84 && lat > 47.04 && lat < 47.1 && z >= 12;
      return inside ? terrainPng(z, x, y, 800) : undefined;
    },
  });
});

describe('GET /dem', () => {
  it('serves the LiDAR tile inside coverage, as stored, without Content-Encoding', async () => {
    const res = await get(`/dem/${IN16}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Encoding')).toBeNull();
    expect(res.headers.get('X-Dem-Source')).toBe('lidar:dem-quebec');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
    const [z, x, y] = IN16.split('/').map(Number) as [number, number, number];
    expect(Buffer.from(await res.arrayBuffer()).equals(terrainPng(z, x, y, 800))).toBe(true);
    expect(awsFetches).toEqual([]);
  });

  it('answers a cache HIT with the same bytes (no second compression)', async () => {
    const first = Buffer.from(await (await get(`/dem/${IN16}.png`)).arrayBuffer());
    mockArchives.clear(); // a HIT never reaches R2
    const hit = await get(`/dem/${IN16}.png`);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('Content-Encoding')).toBeNull();
    expect(Buffer.from(await hit.arrayBuffer()).equals(first)).toBe(true);
  });

  it('passes AWS Terrarium through outside coverage', async () => {
    const res = await get(`/dem/${OUT12}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Dem-Source')).toBe('aws');
    expect(awsFetches).toEqual([OUT12]);
    const [z, x, y] = OUT12.split('/').map(Number) as [number, number, number];
    expect(Buffer.from(await res.arrayBuffer()).equals(terrainPng(z, x, y, 300))).toBe(true);
  });

  it('upsamples AWS z15 for z16 outside coverage', async () => {
    const res = await get('/dem/16/19500/22700.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Dem-Source')).toBe('aws-upsampled');
    expect(awsFetches).toEqual(['15/9750/11350']);
  });

  it('serves AWS everywhere while no index is published', async () => {
    r2.delete('dem.index.json');
    jest.useFakeTimers({ now: Date.now() + 3_600_000, doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const res = await get(`/dem/${IN16}.png`);
      expect(res.headers.get('X-Dem-Source')).toBe('aws-upsampled');
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses tiles past z16', async () => {
    expect((await get('/dem/17/0/0.png')).status).toBe(400);
  });
});

describe('GET /contours reads /dem', () => {
  it('draws from the LiDAR archive inside coverage and stores under contours/v4', async () => {
    // z14 contour tile over Mont-Sainte-Anne → its DEM at z13 + neighbours, region z12.
    const res = await get('/contours/14/4965/5757.mvt');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Contour-Source')).toBe('generated');
    expect(awsFetches).toEqual([]);
    expect(r2Puts).toEqual(['contours/v4/14/4965/5757.mvt']);
  });
});

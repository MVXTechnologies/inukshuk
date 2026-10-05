/**
 * Grid packs (CONVERT §3, DESIGN §3.2): PROJ-data grids cropped per province,
 * state or country on the NAS (`infra/tiles/nas/projgrids.sh`), served from
 * R2 by the tile Worker under `/proj-grids/`. PROJ finds a grid by file
 * name, and a crop keeps the name, so two packs can hold different crops of
 * the same file: the engine therefore runs each conversion with the
 * absolute path of the crop that COVERS the point (`resolveGrid`), never
 * "whichever comes first in the search path".
 */
import type { BBox } from './types';

export interface PackFile {
  name: string;
  bytes: number;
  md5: string;
  sha256: string;
  /** The crop's extent (null = the whole PROJ-data file). */
  crop: BBox | null;
  /** "PROJ-data 1.24", the source file's version. */
  source: string;
  licence: string;
}

export interface Pack {
  id: string;
  name: string;
  bbox: BBox;
  bytes: number;
  /** A whole national file set ("download national pack", Q7a). */
  national?: boolean;
  files: PackFile[];
}

export interface PackIndex {
  version: number;
  generated: string;
  packs: Pack[];
}

/** An installed file: which pack, where on disk, which crop. */
export interface InstalledGrid {
  pack: string;
  name: string;
  path: string;
  crop: BBox | null;
}

const MARGIN_DEG = 0.05;

function within(b: BBox, lon: number, lat: number, margin = 0): boolean {
  return (
    lon >= b[0] + margin && lon <= b[2] - margin && lat >= b[1] + margin && lat <= b[3] - margin
  );
}

function area(b: BBox): number {
  return (b[2] - b[0]) * (b[3] - b[1]);
}

/**
 * The installed copy of `name` whose crop covers the point (with a small
 * inner margin, so bilinear neighbours are inside), preferring a whole file.
 */
export function resolveGrid(
  installed: readonly InstalledGrid[],
  name: string,
  lon: number,
  lat: number,
): InstalledGrid | null {
  const candidates = installed.filter(
    (g) => g.name === name && (g.crop === null || within(g.crop, lon, lat, MARGIN_DEG)),
  );
  candidates.sort((a, b) =>
    a.crop === null ? -1 : b.crop === null ? 1 : area(b.crop) - area(a.crop),
  );
  return candidates[0] ?? null;
}

/** The smallest pack that provides `name` covering the point (national packs last). */
export function packFor(index: PackIndex, name: string, lon: number, lat: number): Pack | null {
  const fits = index.packs.filter((p) =>
    p.files.some(
      (f) =>
        f.name === name &&
        (f.crop === null ? within(p.bbox, lon, lat) : within(f.crop, lon, lat, MARGIN_DEG)),
    ),
  );
  fits.sort((a, b) => Number(!!a.national) - Number(!!b.national) || a.bytes - b.bytes);
  return fits[0] ?? null;
}

/** Packs for a set of missing grids at a point (deduplicated), or the names nobody provides. */
export function packsForGrids(
  index: PackIndex,
  names: readonly string[],
  lon: number,
  lat: number,
): { packs: Pack[]; unavailable: string[] } {
  const packs: Pack[] = [];
  const unavailable: string[] = [];
  for (const n of names) {
    const p = packFor(index, n, lon, lat);
    if (!p) unavailable.push(n);
    else if (!packs.some((x) => x.id === p.id)) packs.push(p);
  }
  return { packs, unavailable };
}

function intersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Regional packs to attach to an offline region (never the national ones). */
export function packsForRegion(index: PackIndex, box: BBox): Pack[] {
  return index.packs.filter((p) => !p.national && intersects(p.bbox, box));
}

/** "0.45 MB" */
export function formatBytes(n: number): string {
  if (n < 1e6) return `${Math.max(0.01, n / 1e6).toFixed(2)} MB`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
}

/** Defensive parse of the Worker's index.json (bad entries dropped). */
export function parsePackIndex(raw: unknown): PackIndex | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.packs)) return null;
  const isBox = (b: unknown): b is BBox =>
    Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === 'number');
  const packs: Pack[] = [];
  for (const p of r.packs as unknown[]) {
    const q = p as Record<string, unknown>;
    if (
      typeof q.id !== 'string' ||
      !/^[a-z0-9-]+$/.test(q.id) ||
      typeof q.name !== 'string' ||
      !isBox(q.bbox) ||
      !Array.isArray(q.files)
    )
      continue;
    const files: PackFile[] = [];
    for (const f of q.files as unknown[]) {
      const g = f as Record<string, unknown>;
      if (
        typeof g.name !== 'string' ||
        !/^[A-Za-z0-9_.-]+\.tif$/.test(g.name) ||
        typeof g.bytes !== 'number' ||
        typeof g.md5 !== 'string'
      )
        continue;
      files.push({
        name: g.name,
        bytes: g.bytes,
        md5: g.md5,
        sha256: typeof g.sha256 === 'string' ? g.sha256 : '',
        crop: isBox(g.crop) ? g.crop : null,
        source: typeof g.source === 'string' ? g.source : '',
        licence: typeof g.licence === 'string' ? g.licence : '',
      });
    }
    if (files.length === 0) continue;
    packs.push({
      id: q.id,
      name: q.name,
      bbox: q.bbox,
      bytes: files.reduce((a, f) => a + f.bytes, 0),
      ...(q.national === true ? { national: true } : {}),
      files,
    });
  }
  return {
    version: typeof r.version === 'number' ? r.version : 1,
    generated: typeof r.generated === 'string' ? r.generated : '',
    packs,
  };
}

/** Rewrite a pinned pipeline's grid names to the chosen absolute paths (the plan text itself never changes). */
export function withGridPaths(pipeline: string, paths: Readonly<Record<string, string>>): string {
  return pipeline.replace(
    /\+grids=([^ ]+)/g,
    (_m, list: string) =>
      `+grids=${list
        .split(',')
        .map((n) => paths[n] ?? n)
        .join(',')}`,
  );
}

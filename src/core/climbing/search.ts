/**
 * Crag search across the world, offline-capable (DESIGN §6.6): the small
 * index the NAS publishes (`climbing-v1.index.json`: uid, name, point,
 * region, country, routes per crag), matched on folded names, ranked by
 * match quality, then size, then distance.
 */
export interface CragIndexRow {
  uid: string;
  name: string;
  lng: number;
  lat: number;
  region: string;
  cc: string;
  routes: number;
}

export interface CragIndex {
  generated: string;
  /** The details version: /climbing/v1/d/{details}/{uid}.json. */
  details: string;
  rows: CragIndexRow[];
  /** Old or merged uids → the current uid (a saved crag keeps updating). */
  aliases: Record<string, string>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseCragIndex(raw: unknown): CragIndex | null {
  if (!isRecord(raw) || raw.schema !== 1 || typeof raw.details !== 'string') return null;
  const cols = Array.isArray(raw.cols) ? (raw.cols as unknown[]) : [];
  const at = (name: string) => cols.indexOf(name);
  const [iI, iN, iLng, iLat, iRg, iCc, iR] = ['i', 'n', 'lng', 'lat', 'rg', 'cc', 'r'].map(at);
  if ([iI, iN, iLng, iLat].some((i) => i === undefined || i < 0)) return null;
  const rows: CragIndexRow[] = [];
  for (const r of Array.isArray(raw.rows) ? (raw.rows as unknown[]) : []) {
    if (!Array.isArray(r)) continue;
    const get = (i: number | undefined) =>
      i !== undefined && i >= 0 ? (r[i] as unknown) : undefined;
    const uid = get(iI);
    const name = get(iN);
    const lng = get(iLng);
    const lat = get(iLat);
    if (typeof uid !== 'string' || typeof name !== 'string') continue;
    if (typeof lng !== 'number' || typeof lat !== 'number') continue;
    const rg = get(iRg);
    const cc = get(iCc);
    const routes = get(iR);
    rows.push({
      uid,
      name,
      lng,
      lat,
      region: typeof rg === 'string' ? rg : '',
      cc: typeof cc === 'string' ? cc : '',
      routes: typeof routes === 'number' ? routes : 0,
    });
  }
  const aliases: Record<string, string> = {};
  if (isRecord(raw.aliases)) {
    for (const [k, v] of Object.entries(raw.aliases)) if (typeof v === 'string') aliases[k] = v;
  }
  return {
    generated: typeof raw.generated === 'string' ? raw.generated : '',
    details: raw.details,
    rows,
    aliases,
  };
}

/** Lower-case, accents and punctuation off ("Montagne d'Argent" → "montagne d argent"). */
export function foldName(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface CragHit {
  row: CragIndexRow;
  score: number;
}

/**
 * Crags matching a query: whole name > name start > word start > anywhere.
 * Ties go to the bigger crag, then the nearer one.
 */
export function searchCrags(
  index: Pick<CragIndex, 'rows'>,
  query: string,
  near: { latitude: number; longitude: number } | null,
  limit = 8,
): CragHit[] {
  const q = foldName(query);
  if (q.length < 2) return [];
  const hits: CragHit[] = [];
  for (const row of index.rows) {
    const name = foldName(row.name);
    let score: number;
    if (name === q) score = 4;
    else if (name.startsWith(q)) score = 3;
    else if (name.includes(` ${q}`)) score = 2;
    else if (name.includes(q)) score = 1;
    else continue;
    hits.push({ row, score });
  }
  const dist = (r: CragIndexRow) =>
    near === null
      ? 0
      : Math.hypot(
          (r.lng - near.longitude) * Math.cos((near.latitude * Math.PI) / 180),
          r.lat - near.latitude,
        );
  const tier = (r: CragIndexRow) => (r.routes >= 50 ? 2 : r.routes >= 10 ? 1 : 0);
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      tier(b.row) - tier(a.row) ||
      dist(a.row) - dist(b.row) ||
      b.row.routes - a.row.routes,
  );
  return hits.slice(0, limit);
}

/** The current uid for a saved one (merged or renamed since the download). */
export function resolveUid(index: Pick<CragIndex, 'aliases'> | null, uid: string): string {
  return index?.aliases[uid] ?? uid;
}

/** Tile-feature filter for the Explore field: names in view matching the text. */
export function nameMatches(name: string, query: string): boolean {
  const q = foldName(query);
  return q === '' || foldName(name).includes(q);
}

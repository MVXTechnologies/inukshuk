/**
 * Cartes Plein-air listing parser (#680): https://cartespleinair.org/cartes →
 * the maps it lists.
 *
 * The site publishes no feed and its map URLs cannot be guessed, so the
 * listing page is the only index. It is a Next.js page: besides the rendered
 * table, it carries its data as a React Server Components "flight" payload in
 * `self.__next_f.push([1, "<chunk>"])` scripts. One property of that payload,
 * `"rows"`, is the whole table as JSON — one row per (map, river section):
 *
 * ```json
 * { "map": { "id": "<uuid>", "slug": "riviere-desert-charles-leduc-2023",
 *            "name": "Rivière Désert", "author": "Charles Leduc",
 *            "authoredYear": 2023, "createdAt": "…" },
 *   "regions": ["qc:07"],
 *   "section": { "id": "…", "name": "du lac Désert à Chute-Rouge", "geomLength": 78.7,
 *                "difficulty": "2",
 *                "river": { "id": "<uuid>", "name": "Désert", "regions": ["qc:07"] } } }
 * ```
 *
 * A map covering several sections appears once per section; {@link parseListing}
 * folds them into one {@link CpaMap}. Reading the JSON, not the table markup, is
 * deliberate: the markup is utility-class soup that changes with every restyle,
 * while the payload is the site's own data model.
 *
 * Contract (as every catalog parser): any string in, never throws. A row that
 * fails validation is dropped with a warning; a page with no payload at all
 * yields no maps and a warning, and the crawler refuses to publish that (see
 * `./diff`'s mass-removal guard).
 */

export interface CpaRiver {
  /** The site's stable river id (a UUID). */
  id: string;
  /** As the site names it, e.g. "Désert", "Du Nord (Dumoine)". */
  name: string;
  /** Region codes: `qc:01`…`qc:17` (Québec administrative regions), `ca:on`, `ca:nb`, `ca:nl`. */
  regions: string[];
}

export interface CpaSection {
  name: string;
  /** Section length in km, when the site gives it. */
  lengthKm?: number;
  river: CpaRiver;
}

/** One map, folded from its rows. */
export interface CpaMap {
  /** The site's map id (a UUID): our identity across slug changes. */
  id: string;
  /** URL key: https://cartespleinair.org/cartes/<slug>. */
  slug: string;
  title: string;
  /** Verbatim, e.g. "Charles Leduc", "Leduc/Boisclair", "RF Papineau-Labelle". */
  author: string;
  year?: number;
  sections: CpaSection[];
  /** Distinct rivers of the sections, in listing order. */
  rivers: CpaRiver[];
  /** Union of the rows' regions, in listing order. */
  regions: string[];
}

export interface CpaListing {
  maps: CpaMap[];
  warnings: string[];
  /** Distinct `/cartes/<slug>` links in the rendered markup (a cross-check). */
  linkedSlugs: number;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGION = /^(qc:(0[1-9]|1[0-7])|ca:[a-z]{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What the site writes when it does not know the author ("Inconnu"): no one
 * to credit, so, by the publisher's terms, no listing (2.5.2 QA). Compared
 * without case or accents.
 */
const PLACEHOLDER_AUTHORS = new Set([
  'inconnu',
  'inconnue',
  'unknown',
  'anonyme',
  'anonymous',
  'n/a',
  'na',
  'aucun',
  'none',
  '-',
  '?',
]);

/** The author to credit, or null when there is none (missing, blank or a placeholder). */
export function creditableAuthor(value: unknown): string | null {
  const author = text(value);
  if (author === null) return null;
  const key = author
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return PLACEHOLDER_AUTHORS.has(key) ? null : author;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' && !value.startsWith('$')
    ? value.trim()
    : null;
}

/**
 * The index just past the JSON value (array or object) starting at `start`,
 * or -1 when it never closes. String-aware, so brackets inside strings and
 * escaped quotes do not count.
 */
export function jsonValueEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * The flight payload: every `self.__next_f.push([1, "…"])` string chunk,
 * decoded and concatenated in page order. Empty when the page has none.
 */
export function extractFlightPayload(html: string): string {
  const marker = 'self.__next_f.push(';
  let out = '';
  let at = html.indexOf(marker);
  while (at !== -1) {
    const open = at + marker.length;
    const end = html[open] === '[' ? jsonValueEnd(html, open) : -1;
    if (end !== -1) {
      try {
        const chunk: unknown = JSON.parse(html.slice(open, end));
        if (Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === 'string') out += chunk[1];
      } catch {
        // Not a JSON array literal (e.g. a variable): not a data chunk.
      }
    }
    at = html.indexOf(marker, open);
  }
  return out;
}

/** The JSON array that follows the first `"<key>":[` in `source`, or null. */
export function extractJsonArray(source: string, key: string): unknown[] | null {
  const needle = `"${key}":[`;
  const at = source.indexOf(needle);
  if (at === -1) return null;
  const start = at + needle.length - 1;
  const end = jsonValueEnd(source, start);
  if (end === -1) return null;
  try {
    const value: unknown = JSON.parse(source.slice(start, end));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseRegions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const r of value) {
    if (typeof r === 'string' && REGION.test(r) && !out.includes(r)) out.push(r);
  }
  return out;
}

interface ParsedRow {
  map: Omit<CpaMap, 'sections' | 'rivers' | 'regions'>;
  section: CpaSection | null;
  regions: string[];
}

function parseRow(raw: unknown): ParsedRow | string {
  if (!isRecord(raw) || !isRecord(raw.map)) return 'row without a map';
  const m = raw.map;
  const id = text(m.id);
  if (id === null || !UUID.test(id)) return `map with an unusable id "${String(m.id)}"`;
  const slug = text(m.slug);
  if (slug === null || !SLUG.test(slug)) return `map ${id}: unusable slug "${String(m.slug)}"`;
  const title = text(m.name);
  if (title === null) return `map ${slug}: no name`;
  // Terms of use: every map is credited to its author. A map whose author the
  // site does not give cannot be credited, so it is not listed at all.
  const author = creditableAuthor(m.author);
  if (author === null) return `map ${slug}: no author to credit`;
  const year =
    typeof m.authoredYear === 'number' &&
    Number.isInteger(m.authoredYear) &&
    m.authoredYear >= 1800 &&
    m.authoredYear <= 2200
      ? m.authoredYear
      : undefined;

  let section: CpaSection | null = null;
  const s = raw.section;
  if (isRecord(s) && isRecord(s.river)) {
    const riverId = text(s.river.id);
    const riverName = text(s.river.name);
    if (riverId !== null && riverName !== null) {
      const lengthKm =
        typeof s.geomLength === 'number' && Number.isFinite(s.geomLength) && s.geomLength > 0
          ? Math.round(s.geomLength * 10) / 10
          : undefined;
      section = {
        name: text(s.name) ?? riverName,
        ...(lengthKm !== undefined ? { lengthKm } : {}),
        river: { id: riverId, name: riverName, regions: parseRegions(s.river.regions) },
      };
    }
  }
  return {
    map: { id, slug, title, author, ...(year !== undefined ? { year } : {}) },
    section,
    regions: parseRegions(raw.regions),
  };
}

/** Distinct `href="/cartes/<slug>"` links in the markup. */
function countLinkedSlugs(html: string): number {
  const slugs = new Set<string>();
  for (const match of html.matchAll(/href="\/cartes\/([a-z0-9][a-z0-9-]*)"/g)) {
    if (match[1] !== undefined) slugs.add(match[1]);
  }
  return slugs.size;
}

/** Parse the listing page into maps. Never throws. */
export function parseListing(html: string): CpaListing {
  const warnings: string[] = [];
  const linkedSlugs = countLinkedSlugs(html);
  const rows = extractJsonArray(extractFlightPayload(html), 'rows');
  if (rows === null) {
    return { maps: [], warnings: ['no "rows" array in the page payload'], linkedSlugs };
  }

  const byId = new Map<string, CpaMap>();
  const slugOwner = new Map<string, string>();
  for (const raw of rows) {
    const row = parseRow(raw);
    if (typeof row === 'string') {
      warnings.push(`dropped ${row}`);
      continue;
    }
    const owner = slugOwner.get(row.map.slug);
    if (owner !== undefined && owner !== row.map.id) {
      warnings.push(
        `dropped map ${row.map.id}: slug "${row.map.slug}" already belongs to ${owner}`,
      );
      continue;
    }
    slugOwner.set(row.map.slug, row.map.id);
    let map = byId.get(row.map.id);
    if (map === undefined) {
      map = { ...row.map, sections: [], rivers: [], regions: [] };
      byId.set(row.map.id, map);
    }
    if (row.section !== null) {
      map.sections.push(row.section);
      if (!map.rivers.some((r) => r.id === row.section?.river.id))
        map.rivers.push(row.section.river);
    }
    for (const region of [...row.regions, ...(row.section?.river.regions ?? [])]) {
      if (!map.regions.includes(region)) map.regions.push(region);
    }
  }

  const maps = [...byId.values()];
  if (maps.length !== linkedSlugs) {
    warnings.push(`payload lists ${maps.length} maps but the page links ${linkedSlugs}`);
  }
  return { maps, warnings, linkedSlugs };
}

/** The map's page: a stable URL that redirects to its current PDF. */
export function cpaPageUrl(slug: string): string {
  return `https://cartespleinair.org/cartes/${slug}`;
}

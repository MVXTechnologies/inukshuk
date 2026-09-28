/**
 * Strava bulk-export `activities.csv`: one row per activity with its name,
 * type and the archive path of its file (`activities/123.fit.gz`). Used to
 * name imported tracks and pick their category — optional; the import works
 * without it.
 */

export interface StravaCsvActivity {
  name?: string;
  /** Strava activity type, e.g. `Run`, `Trail Run`, `Ride`, `Hike`. */
  type?: string;
}

/** RFC 4180 CSV: quoted fields may hold commas, doubled quotes and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // BOM
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Archive-path key: the lowercased basename (`123.fit.gz`) — activity ids are unique. */
export function csvFileKey(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.trim().toLowerCase();
}

/**
 * Map each row's file (by {@link csvFileKey}) to its name and type. Columns are
 * found by header name (the first match wins — Strava repeats some headers).
 * Rows without a filename (manual entries) are dropped.
 */
export function parseStravaActivitiesCsv(text: string): Map<string, StravaCsvActivity> {
  const out = new Map<string, StravaCsvActivity>();
  const [header, ...rows] = parseCsv(text);
  if (!header) return out;
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const fileCol = col('filename');
  if (fileCol < 0) return out;
  const nameCol = col('activity name');
  const typeCol = col('activity type');
  for (const row of rows) {
    const file = row[fileCol]?.trim();
    if (!file) continue;
    const entry: StravaCsvActivity = {};
    const name = nameCol >= 0 ? row[nameCol]?.trim() : undefined;
    if (name) entry.name = name;
    const type = typeCol >= 0 ? row[typeCol]?.trim() : undefined;
    if (type) entry.type = type;
    out.set(csvFileKey(file), entry);
  }
  return out;
}

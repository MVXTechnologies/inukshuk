/**
 * Minimal RFC-4180 CSV reader for the catalog generator's bulk indexes.
 *
 * Lives in `src/core` — and is tested — because it is load-bearing for
 * correctness in a way no later check can catch: USGS's `ustopo_current.csv`
 * quotes its `county_list` field, which contains commas. A naive `split(',')`
 * shifts every column after it, so `westbc` would be read out of `state_list`
 * and 65 000 items would get plausible-looking but wrong bounding boxes. The
 * schema parser would accept every one of them.
 *
 * Scope is deliberately small: comma delimiter, `"` quoting with `""` escapes,
 * CRLF tolerated, newlines allowed inside quotes. No streaming — the generator
 * runs in Node on a whole-file string.
 */

/** Parse one CSV record into its fields. Never throws. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Split a CSV document into records, keeping quoted newlines inside their
 * field. Blank lines are dropped (they carry no record); each record is
 * returned verbatim for {@link parseCsvLine}.
 */
export function splitCsvRows(text: string): string[] {
  const rows: string[] = [];
  let current = '';
  let quoted = false;
  const push = (row: string): void => {
    const trimmed = row.replace(/\r$/, '');
    if (trimmed.trim() !== '') rows.push(trimmed);
  };
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === '\n' && !quoted) {
      push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  push(current);
  return rows;
}

/**
 * Index a header row by column name, refusing unknown columns loudly — an
 * upstream schema change must fail the generator, never silently produce a
 * manifest full of `undefined` fields.
 */
export function csvColumnIndex(
  header: readonly string[],
  names: readonly string[],
): Record<string, number> {
  const index: Record<string, number> = {};
  for (const name of names) {
    const at = header.indexOf(name);
    if (at < 0) throw new Error(`CSV has no "${name}" column — upstream format changed`);
    index[name] = at;
  }
  return index;
}

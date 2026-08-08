/**
 * National Topographic System sheet geometry — pure math, no data files.
 *
 * Southern Canada (south of 68°N) is tiled into primary quadrangles 8° of
 * longitude wide × 4° of latitude tall, numbered so that the tens digit is the
 * column west of 48°W and the units digit the row north of 40°N (e.g. 021 =
 * 64–72°W / 44–48°N, 031 = 72–80°W / 44–48°N). Each quadrangle splits into 16
 * lettered 1:250k quads (2°×1°, A–P) and each of those into 16 numbered 1:50k
 * sheets (0.5°×0.25°, 1–16); both walk a boustrophedon starting at the
 * southeast corner (east→west, then west→east on the row above, …).
 *
 * Used by the catalog generator to derive each CanTopo sheet's WGS84 bbox from
 * its id alone (the NRCan file tree carries no extents), and unit-tested here
 * so the manifest's bboxes are trustworthy. Sheets north of 60°N (quad rows
 * ≥ 5) are out of model — see the guard in {@link parseNtsSheetId}.
 */

export interface NtsSheet {
  /** Primary quadrangle number, e.g. 21 for "021". */
  quad: number;
  /** 1:250k letter A–P (uppercased). */
  letter: string;
  /** 1:50k sheet number 1–16. */
  number: number;
}

/** WGS84 [west, south, east, north]. */
export type NtsBbox = [number, number, number, number];

const LETTERS = 'ABCDEFGHIJKLMNOP';

/**
 * Parse a 1:50k sheet id like "021L14", "21l14" or "031_l_01". Null when the
 * text is not a well-formed southern-Canada sheet id.
 */
export function parseNtsSheetId(id: string): NtsSheet | null {
  const m = /^(\d{1,3})[_\s-]?([a-pA-P])[_\s-]?(\d{1,2})$/.exec(id.trim());
  if (!m) return null;
  const quad = Number(m[1]);
  const letter = (m[2] ?? '').toUpperCase();
  const number = Number(m[3]);
  if (number < 1 || number > 16) return null;
  const col = Math.floor(quad / 10);
  const row = quad % 10;
  // Row 0 does not exist. Rows above 4 reach past 60°N, where the NTS grid
  // stops being regular (1:50k sheets double in width above 62°N, primary
  // quads above 68°N) — this math models only the regular southern zone, so
  // anything else is null rather than a wrong bbox. Columns beyond 11 fall
  // off the west coast.
  if (row < 1 || row > 4 || col > 11) return null;
  return { quad, letter, number };
}

/**
 * Position of step `index` (0-based) in a boustrophedon over `cols` columns
 * starting at the southeast corner: returns 0-based (row, colFromEast).
 */
function snake(index: number, cols: number): { row: number; colFromEast: number } {
  const row = Math.floor(index / cols);
  const within = index % cols;
  return { row, colFromEast: row % 2 === 0 ? within : cols - 1 - within };
}

/**
 * WGS84 bbox of a 1:50k NTS sheet id ("021L14" → [-71.5, 46.75, -71, 47]).
 * Null when the id doesn't parse.
 */
export function ntsSheetBbox(id: string): NtsBbox | null {
  const sheet = parseNtsSheetId(id);
  if (sheet === null) return null;

  const quadEast = -48 - Math.floor(sheet.quad / 10) * 8;
  const quadSouth = 40 + (sheet.quad % 10) * 4;

  const letterPos = snake(LETTERS.indexOf(sheet.letter), 4);
  const letterEast = quadEast - letterPos.colFromEast * 2;
  const letterSouth = quadSouth + letterPos.row * 1;

  const numberPos = snake(sheet.number - 1, 4);
  const east = letterEast - numberPos.colFromEast * 0.5;
  const south = letterSouth + numberPos.row * 0.25;

  return [east - 0.5, south, east, south + 0.25];
}

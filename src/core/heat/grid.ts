/**
 * The heat grid: fixed geographic cells of ~HEAT_CELL_M real metres.
 * Rows are constant-height latitude bands; column width is cosine-corrected
 * at each row's centre latitude, so cells stay square-ish on the ground at
 * any latitude while every caller derives the identical cell for a
 * coordinate (the correction depends only on the row, never the input lat).
 */

export const HEAT_CELL_M = 25;

const M_PER_DEG_LAT = 111320;

export interface Cell {
  row: number;
  col: number;
}

function validateCellSize(cellSizeM: number): void {
  if (!Number.isFinite(cellSizeM) || cellSizeM < 1 || cellSizeM > M_PER_DEG_LAT * 180) {
    throw new RangeError('Heat cell size must be between 1 metre and half the world');
  }
}

function halfColumnsAtRow(row: number, cellSizeM: number): number {
  // Clip the final latitude band at each pole so its centre stays on Earth.
  const south = Math.max(-90, (row * cellSizeM) / M_PER_DEG_LAT);
  const north = Math.min(90, ((row + 1) * cellSizeM) / M_PER_DEG_LAT);
  const metresPerDegree = M_PER_DEG_LAT * Math.cos((((south + north) / 2) * Math.PI) / 180);
  // Fit a whole, even number of columns around Earth. Partial seam cells can
  // be arbitrarily thin and put nearby fixes several column steps apart.
  const halfColumns = Math.max(1, Math.round((180 * metresPerDegree) / cellSizeM));
  return halfColumns;
}

export function cellAt(lng: number, lat: number, cellSizeM: number = HEAT_CELL_M): Cell {
  validateCellSize(cellSizeM);
  const row = Math.floor((lat * M_PER_DEG_LAT) / cellSizeM);
  const longitude = lng === 180 ? -180 : lng;
  const col = Math.floor((longitude / 180) * halfColumnsAtRow(row, cellSizeM));
  return { row, col };
}

export function cellKey(cell: Cell): string {
  return `${cell.row},${cell.col}`;
}

/**
 * The cell and up to 8 neighbours, wrapping at the dateline. Adjacent rows
 * have different column widths, so project the centre longitude into each.
 * Polar rings omit out-of-world rows and duplicate wrapped cells.
 */
export function ringKeys(cell: Cell, cellSizeM: number = HEAT_CELL_M): string[] {
  validateCellSize(cellSizeM);
  const minRow = Math.floor((-90 * M_PER_DEG_LAT) / cellSizeM);
  const maxRow = Math.floor((90 * M_PER_DEG_LAT) / cellSizeM);
  const sourceHalfColumns = halfColumnsAtRow(cell.row, cellSizeM);
  const longitudeRatio = (cell.col + 0.5) / sourceHalfColumns;
  const keys = new Set<string>();
  for (let dr = -1; dr <= 1; dr++) {
    const row = cell.row + dr;
    if (row < minRow || row > maxRow) continue;
    const halfColumns = halfColumnsAtRow(row, cellSizeM);
    const columns = 2 * halfColumns;
    const centreCol = dr === 0 ? cell.col : Math.floor(longitudeRatio * halfColumns);
    for (let dc = -1; dc <= 1; dc++) {
      // Constant-time modulo even when a polar row has only two columns.
      const col = ((((centreCol + dc + halfColumns) % columns) + columns) % columns) - halfColumns;
      keys.add(`${row},${col}`);
    }
  }
  return [...keys];
}

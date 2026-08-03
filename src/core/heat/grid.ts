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

export function cellAt(lng: number, lat: number, cellSizeM: number = HEAT_CELL_M): Cell {
  const row = Math.floor((lat * M_PER_DEG_LAT) / cellSizeM);
  const rowCenterLat = ((row + 0.5) * cellSizeM) / M_PER_DEG_LAT;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((rowCenterLat * Math.PI) / 180);
  const col = Math.floor((lng * mPerDegLng) / cellSizeM);
  return { row, col };
}

export function cellKey(cell: Cell): string {
  return `${cell.row},${cell.col}`;
}

/** The cell plus its 8 neighbours — the 1-ring dilation / fat-finger radius. */
export function ringKeys(cell: Cell): string[] {
  const keys: string[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      keys.push(`${cell.row + dr},${cell.col + dc}`);
    }
  }
  return keys;
}

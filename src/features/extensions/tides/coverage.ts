import { parseTideCoverage, type TideCoverage } from '@core/tides/coverage';
import { datasetTileJsonUrl } from '@data/datasets';

/** Stations per source from the tide archive's TileJSON (`/tides.json`); null offline. */
export async function fetchTideCoverage(): Promise<TideCoverage | null> {
  try {
    const res = await fetch(datasetTileJsonUrl('tides'));
    return res.ok ? parseTideCoverage(await res.json()) : null;
  } catch {
    return null;
  }
}

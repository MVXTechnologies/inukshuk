import { readFileSync } from 'fs';
import { join } from 'path';

import {
  DEM_ATTRIBUTION,
  DEM_CREDITS_LINE,
  DEM_MAPTERHORN_CREDIT,
  DEM_MAPTERHORN_URL,
  DEM_SOURCES,
} from './demCredits';

/** What the tiles Worker serves (infra/tiles/nas/dem/regions.json, #725). */
const regions = JSON.parse(
  readFileSync(join(__dirname, '../../../infra/tiles/nas/dem/regions.json'), 'utf8'),
) as { regions: { label: string; sources: string[] }[] };
const served = regions.regions.flatMap((r) => r.sources);

describe('demCredits', () => {
  it('credits exactly the sources the DEM pipeline serves (regenerate with dem.py credits)', () => {
    expect(DEM_SOURCES.map((s) => s.id).sort()).toEqual([...new Set(served)].sort());
  });

  it('gives every source its licence, its producer and a link', () => {
    for (const s of DEM_SOURCES) {
      expect(s.credit.length).toBeGreaterThan(5);
      expect(s.license.length).toBeGreaterThan(2);
      expect(s.producer.length).toBeGreaterThan(2);
      expect(s.website).toMatch(/^https?:\/\//);
    }
  });

  it('uses the wording the Open Government Licence – Canada requires', () => {
    const hrdem = DEM_SOURCES.find((s) => s.id === 'cahrdem2');
    expect(hrdem?.credit).toContain(
      'Contains information licensed under the Open Government Licence – Canada',
    );
  });

  it('names Mapterhorn and the AWS fallback in the short and the long line', () => {
    expect(DEM_MAPTERHORN_CREDIT).toBe('© Mapterhorn');
    expect(DEM_MAPTERHORN_URL).toBe('https://mapterhorn.com/attribution');
    for (const line of [DEM_ATTRIBUTION, DEM_CREDITS_LINE]) {
      expect(line).toContain('© Mapterhorn');
      expect(line).toContain('AWS Terrain Tiles');
    }
    for (const s of DEM_SOURCES) expect(DEM_CREDITS_LINE).toContain(s.credit);
    for (const r of regions.regions) expect(DEM_CREDITS_LINE).toContain(r.label);
  });
});

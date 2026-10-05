import fixtures from './__fixtures__/stations.json';
import { buildTideCard, NOT_FOR_NAVIGATION } from './card';
import { parseTideStation, type TideStation } from './station';

function station(props: Record<string, unknown>): TideStation {
  const s = parseTideStation(props);
  if (!s) throw new Error('fixture did not parse');
  return s;
}

const M = '−';

describe('buildTideCard — The Battery (NOAA CO-OPS, ellipsoid confirmed by VDatum)', () => {
  const card = buildTideCard(station(fixtures.battery));

  it('has three columns: chart datum · national datum · ellipsoid (owner Q4a)', () => {
    expect(card.columns.map((c) => c.label)).toEqual(['MLLW', 'NAVD88', 'Ellipsoid']);
    expect(card.columns[2]?.sub).toBe('NAD83(2011) · epoch 2010.0');
  });

  it('shows each level as published, and the same level in NAVD88 and as h (H_X = H_CD + CD_in_X)', () => {
    const row = (code: string) => card.rows.find((r) => r.code === code);
    expect(row('MHHW')?.cells.map((c) => c?.text)).toEqual(['1.541', '0.695', `${M}31.23`]);
    expect(row('LAT')?.cells.map((c) => c?.text)).toEqual([`${M}0.465`, `${M}1.311`, `${M}33.24`]);
    const cd = card.rows[card.rows.length - 1];
    expect(cd?.datum).toBe(true);
    expect(cd?.cells.map((c) => c?.text)).toEqual(['0', `${M}0.846`, `${M}32.77`]);
    // VDatum's own MLLW → NAD83(2011) at the gauge is −32.778: our shown −32.77 is within 1 cm.
    expect(Math.abs(-32.77 - -32.778)).toBeLessThan(0.01);
  });

  it('copies every value with its datum, in ASCII', () => {
    const mhhw = card.rows.find((r) => r.code === 'MHHW');
    expect(mhhw?.cells.map((c) => c?.copy)).toEqual([
      'MHHW = 1.541 m above MLLW',
      'MHHW = 0.695 m NAVD88',
      'MHHW = -31.23 m h NAD83(2011) · epoch 2010.0',
    ]);
    expect(mhhw?.copy).toBe(
      'MHHW (Mean higher high water): 1.541 m above MLLW · 0.695 m NAVD88 · -31.23 m h NAD83(2011) · epoch 2010.0',
    );
    expect(card.cdBox.values.map((v) => v.copy)).toEqual([
      'CD (MLLW) = -0.846 m NAVD88',
      'CD (MLLW) = -32.77 m h NAD83(2011) · epoch 2010.0',
    ]);
    expect(card.position.copy).toBe('THE BATTERY (8518750): 40.700554° N, 74.014170° W');
    for (const r of card.rows) for (const c of r.cells) expect(c?.a11y).toMatch(/^Copy /);
  });

  it('copies the whole table with header, source and the navigation warning', () => {
    const lines = card.tableCopy.split('\n');
    expect(lines[0]).toBe('THE BATTERY (8518750) · NOAA CO-OPS · tidal levels, metres');
    expect(lines[1]).toBe('Level\tabove MLLW\tNAVD88\th NAD83(2011) · epoch 2010.0');
    expect(lines).toContain('MHHW\t1.541\t0.695\t-31.23');
    expect(lines).toContain('Chart datum\t0\t-0.846\t-32.77');
    expect(card.tableCopy).not.toContain('−');
    expect(lines[lines.length - 1]).toContain(NOT_FOR_NAVIGATION);
  });

  it('says how far each number is checked, and never hides the warning', () => {
    expect(card.cdBox.title).toBe('Chart datum (MLLW)');
    expect(card.cdBox.notes.join(' ')).toContain('confirmed by NOAA VDatum within 0.9 cm');
    expect(card.chips.map((c) => c.label)).toEqual([
      'Tide station',
      'Live gauge',
      'Not for navigation',
    ]);
    expect(card.credit).toContain('NOAA/NOS/CO-OPS');
    expect(card.credit).toContain('Not for navigation');
    expect(card.extremes).toBe(
      `Recorded high 4.280 (2012-10-30) · low ${M}1.307 (1976-02-02) above MLLW`,
    );
    expect(card.live).toBe('coops');
    expect(card.link.url).toBe('https://tidesandcurrents.noaa.gov/datums.html?id=8518750');
  });
});

describe('buildTideCard — other agencies', () => {
  it('Brest (SHOM): agency codes, 2-decimal levels keep 2 decimals, published zh_elli', () => {
    const card = buildTideCard(station(fixtures.brest));
    expect(card.columns.map((c) => c.label)).toEqual(['ZH', 'NGF-IGN69', 'Ellipsoid']);
    const phma = card.rows.find((r) => r.code === 'PHMA');
    expect(phma?.name).toBe('Plus haute mer astronomique (≈ HAT)');
    expect(phma?.cells.map((c) => c?.text)).toEqual(['7.93', '4.30', '54.96']);
    expect(card.cdBox.notes.join(' ')).toContain(
      'Ellipsoidal height published by Shom; agrees with IGN RAF20',
    );
    expect(card.subtitle).toBe('BREST-IROISESUDBRETAGNE · Shom · Iroise, Sud Bretagne');
    expect(card.credit).toContain('doi:10.17183/MAREE_COURANTS_RAM');
  });

  it('Bergen without an oracle-confirmed ellipsoid: two columns and the reason', () => {
    const card = buildTideCard(station(fixtures.bergen_no_ellipsoid));
    expect(card.columns.map((c) => c.label)).toEqual(['CD', 'NN2000']);
    expect(card.rows.every((r) => r.cells.length === 2)).toBe(true);
    expect(card.cdBox.notes).toContain(
      'No ellipsoidal height: no agency value confirms one at this station.',
    );
    expect(card.cdBox.notes).toContain('Land uplift 0.15 cm/yr.');
  });

  it('JMA: the tide-table datum is never called chart datum', () => {
    const card = buildTideCard(station(fixtures.wakkanai));
    expect(card.columns[0]?.label).toBe('Tide-table datum');
    expect(card.cdBox.title).toBe('Tide-table datum');
    expect(card.rows.map((r) => r.code)).toEqual(['MSL', 'Datum']);
    expect(card.rows[0]?.cells[0]?.copy).toBe('MSL = 0.180 m above the tide-table datum');
    expect(card.rows[0]?.cells[1]?.text).toBe(`${M}0.038`);
    expect(card.position.note).toBe('station position, ±1 km (as published)');
    expect(card.credit).toContain('not guaranteed equal to');
  });

  it('a secondary station shows its reference port HAT/LAT separately, labelled as the port’s own', () => {
    const card = buildTideCard(station(fixtures.secondary_with_reference_port));
    expect(card.rows.some((r) => r.code === 'HAT' || r.code === 'LAT')).toBe(false);
    expect(card.refPort?.title).toBe(
      'Reference port THE BATTERY (8518750) · its own levels above its MLLW',
    );
    expect(card.refPort?.rows.map((r) => [r.code, r.cell.text])).toEqual([
      ['HAT', '1.976'],
      ['LAT', `${M}0.465`],
    ]);
    expect(card.refPort?.rows[1]?.cell.copy).toBe(
      'LAT = -0.465 m above MLLW at reference port THE BATTERY (8518750)',
    );
    expect(card.chips[1]?.label).toBe('Secondary station');
    expect(card.live).toBeUndefined();
  });
});

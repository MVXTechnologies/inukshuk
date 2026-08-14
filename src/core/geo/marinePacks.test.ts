import type { GeoBbox } from './marineDepth';
import {
  MARINE_PACK_CELL_DEG,
  MARINE_PACK_MAX_AGE_MS,
  MARINE_PACK_MAX_CELLS,
  MARINE_PACK_MAX_VIEW_SPAN_DEG,
  MARINE_PACK_SNOOZE_MS,
  decodePackSnooze,
  encodePackSnooze,
  estimatePackBytes,
  estimatePackCellBytes,
  isPackOfferSnoozed,
  marinePackCellsForView,
  marinePackOffer,
  marinePackViewIsPartial,
  marinePackOfferMessage,
  packCellAt,
  packCellBbox,
  packCellGridDims,
  packCellIndex,
  packCellKey,
  packCellLabel,
  packsCoverView,
  parsePackCellKey,
  sanitizeMarinePackSnoozes,
  snoozedPackRegions,
  stalePackKeys,
  type MarinePackOfferInput,
  type MarinePackRecord,
} from './marinePacks';
import { marineSourceById } from './marineSources';

function around(lat: number, lon: number, span = 0.02): GeoBbox {
  return { west: lon - span, south: lat - span, east: lon + span, north: lat + span };
}

/** The Québec City ship channel — the reach the design package measured. */
const QUEBEC = around(46.805, -71.255);
const FIJI = around(-18, 178);
const NOW = 1_770_000_000_000;

describe('the 0.1° pack grid', () => {
  it('floors coordinates onto cell indices, including negatives', () => {
    expect(packCellIndex(46.85)).toBe(468);
    expect(packCellIndex(-71.25)).toBe(-713);
    expect(packCellIndex(0)).toBe(0);
    // Exactly on a boundary belongs to the cell that starts there.
    expect(packCellIndex(46.8)).toBe(468);
  });

  it('produces clean, non-overlapping cell boxes', () => {
    const box = packCellBbox(468, -713);
    expect(box).toEqual({ west: -71.3, south: 46.8, east: -71.2, north: 46.9 });
    expect(box.east - box.west).toBeCloseTo(MARINE_PACK_CELL_DEG, 9);
  });

  it('round-trips a storage key', () => {
    const key = packCellKey('nonna', 468, -713);
    expect(key).toBe('nonna:468:-713');
    const parsed = parsePackCellKey(key);
    expect(parsed?.sourceId).toBe('nonna');
    expect(parsed?.latIdx).toBe(468);
    expect(parsed?.bbox.west).toBeCloseTo(-71.3, 9);
  });

  it('labels a cell by its south-west corner in both hemispheres', () => {
    expect(packCellLabel(packCellBbox(468, -713))).toBe('46.8°N 71.3°W');
    expect(packCellLabel(packCellBbox(-180, 1780))).toBe('18.0°S 178.0°E');
  });

  it('rejects junk keys instead of inventing a cell', () => {
    expect(parsePackCellKey('nonna:468')).toBeNull();
    expect(parsePackCellKey('atlantis:1:2')).toBeNull();
    expect(parsePackCellKey('nonna:x:2')).toBeNull();
  });
});

describe('cells for a viewport', () => {
  it('covers a small viewport with the cells it touches', () => {
    const cells = marinePackCellsForView('nonna', QUEBEC);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.bbox.west).toBeLessThan(QUEBEC.east);
      expect(cell.bbox.east).toBeGreaterThan(QUEBEC.west);
    }
  });

  it('does not emit a cell for a viewport that ends exactly on its edge', () => {
    const cells = marinePackCellsForView('nonna', {
      west: -71.3,
      south: 46.8,
      east: -71.2,
      north: 46.9,
    });
    expect(cells.map((c) => c.key)).toEqual(['nonna:468:-713']);
  });

  it('clamps to a centred block when a viewport needs too many cells', () => {
    // Owner report 2026-08-10: returning [] here made the banner unreachable
    // at ordinary boating zooms. The download stays capped; the offer does
    // not vanish, and it is centred on what the user is looking at.
    const wide = marinePackCellsForView('nonna', around(46.8, -71.2, 1));
    expect(wide.length).toBeGreaterThan(0);
    expect(wide.length).toBeLessThanOrEqual(MARINE_PACK_MAX_CELLS);
    expect(marinePackViewIsPartial(around(46.8, -71.2, 1))).toBe(true);
    const centre = wide.find((c) => c.latIdx === 468 && c.lonIdx === -713);
    expect(centre).toBeDefined();
    const tight = marinePackCellsForView('nonna', around(46.8, -71.2, 0.1));
    expect(tight.length).toBeLessThanOrEqual(MARINE_PACK_MAX_CELLS);
    expect(marinePackViewIsPartial(around(46.8, -71.2, 0.1))).toBe(false);
  });

  it('refuses degenerate and antimeridian-crossing viewports', () => {
    expect(marinePackCellsForView('nonna', { west: 1, south: 1, east: 1, north: 2 })).toEqual([]);
    expect(
      marinePackCellsForView('nonna', { west: 179.9, south: 1, east: 180.1, north: 2 }),
    ).toEqual([]);
  });
});

describe('size estimates', () => {
  const nonna = marineSourceById('nonna');

  it('matches the live NONNA measurement for a Québec City cell', () => {
    // Live 2026-08-10: the 0.1° cell −71.30/46.75 → −71.20/46.85 came back
    // 583×850, and a tile-aligned request measured 1 954 210 B on the wire.
    const bbox = packCellBbox(467, -713);
    const dims = packCellGridDims(nonna, bbox);
    expect(dims.width).toBe(583);
    expect(dims.height).toBeGreaterThanOrEqual(849);
    expect(dims.height).toBeLessThanOrEqual(853);
    const bytes = estimatePackCellBytes(nonna, bbox);
    expect(bytes).toBeGreaterThan(1_900_000);
    expect(bytes).toBeLessThan(2_100_000);
  });

  it('estimates a boating reach at a few megabytes, not a few hundred', () => {
    // Four 0.1° cells ≈ 22 × 15 km ≈ 338 km² of St. Lawrence; at the measured
    // ~23 KB/km² that is ~8 MB, and the design package's 40 × 15 km reach
    // (~600 km²) lands at its quoted ~14 MB.
    const cells = marinePackCellsForView('nonna', around(46.8, -71.2, 0.02));
    expect(cells).toHaveLength(4);
    const mb = estimatePackBytes(nonna, cells) / 1e6;
    expect(mb).toBeGreaterThan(7);
    expect(mb).toBeLessThan(10);
  });

  it('caps a cell at the source grid limit instead of pulling megapixels', () => {
    const noaa = marineSourceById('noaa');
    const dims = packCellGridDims(noaa, packCellBbox(423, -710));
    expect(dims.width).toBe(noaa.grid?.maxPackDim);
    expect(dims.height).toBe(noaa.grid?.maxPackDim);
  });

  it('is zero for a source with no grid at all', () => {
    expect(estimatePackCellBytes(marineSourceById('gebco'), packCellBbox(0, 0))).toBe(0);
  });
});

describe('coverage bookkeeping', () => {
  it('reports coverage only when every needed cell is installed', () => {
    const cells = marinePackCellsForView('nonna', QUEBEC);
    const all = new Set(cells.map((c) => c.key));
    expect(packsCoverView('nonna', QUEBEC, all)).toBe(true);
    const partial = new Set([...all].slice(0, all.size - 1));
    expect(packsCoverView('nonna', QUEBEC, partial)).toBe(all.size === 1);
    expect(packsCoverView('nonna', QUEBEC, new Set())).toBe(false);
  });

  it('finds the stored cell under a tapped point', () => {
    const installed = new Set(['nonna:468:-713']);
    expect(packCellAt('nonna', 46.85, -71.25, installed)).toBe('nonna:468:-713');
    expect(packCellAt('nonna', 46.95, -71.25, installed)).toBeNull();
    expect(packCellAt('emodnet', 46.85, -71.25, installed)).toBeNull();
  });

  it('lists only packs past the 30-day refresh age', () => {
    const records: MarinePackRecord[] = [
      {
        key: 'nonna:468:-713',
        sourceId: 'nonna',
        bbox: packCellBbox(468, -713),
        bytes: 1,
        updatedAt: NOW - MARINE_PACK_MAX_AGE_MS - 1,
      },
      {
        key: 'nonna:468:-712',
        sourceId: 'nonna',
        bbox: packCellBbox(468, -712),
        bytes: 1,
        updatedAt: NOW - 1000,
      },
    ];
    expect(stalePackKeys(records, NOW)).toEqual(['nonna:468:-713']);
  });
});

describe('snooze entries', () => {
  it('round-trips through the persisted string form', () => {
    const entry = encodePackSnooze('nonna:468:-713', NOW + MARINE_PACK_SNOOZE_MS);
    expect(decodePackSnooze(entry)).toEqual({
      regionKey: 'nonna:468:-713',
      expiresAt: NOW + MARINE_PACK_SNOOZE_MS,
    });
  });

  it('drops junk and expired entries on hydration', () => {
    const live = encodePackSnooze('nonna:1:1', NOW + 1000);
    expect(
      sanitizeMarinePackSnoozes(
        [live, live, encodePackSnooze('nonna:2:2', NOW - 1), 'garbage', 42, '@5'],
        NOW,
      ),
    ).toEqual([live]);
    expect(sanitizeMarinePackSnoozes('nope', NOW)).toEqual([]);
  });

  it('answers whether a region is currently snoozed', () => {
    const entries = [encodePackSnooze('nonna:468:-713', NOW + 1000)];
    expect(isPackOfferSnoozed('nonna:468:-713', entries, NOW)).toBe(true);
    expect(isPackOfferSnoozed('nonna:468:-713', entries, NOW + 2000)).toBe(false);
    expect(isPackOfferSnoozed('nonna:1:1', entries, NOW)).toBe(false);
  });
});

describe('the low-resolution banner trigger', () => {
  const base: MarinePackOfferInput = {
    active: true,
    view: QUEBEC,
    activeSourceId: 'gebco',
    installed: new Set<string>(),
    snoozedRegions: new Set<string>(),
  };

  it('offers the NONNA pack when the chart fell through to the global grid', () => {
    const offer = marinePackOffer(base);
    expect(offer?.source.id).toBe('nonna');
    expect(offer?.reason).toBe('coarse');
    expect(offer?.bytes).toBeGreaterThan(0);
    expect(offer?.regionKey).toBe(offer?.cells[0]?.key);
  });

  it('offers offline availability when the best source is already drawing', () => {
    const offer = marinePackOffer({ ...base, activeSourceId: 'nonna' });
    expect(offer?.reason).toBe('offline');
  });

  it('says so plainly when nothing rendered at all', () => {
    const offer = marinePackOffer({ ...base, activeSourceId: null });
    expect(offer?.reason).toBe('unavailable');
    expect(marinePackOfferMessage(offer!)).toContain('unavailable');
  });

  it('stays silent when chart mode is off or the viewport is unknown', () => {
    expect(marinePackOffer({ ...base, active: false })).toBeNull();
    expect(marinePackOffer({ ...base, view: null })).toBeNull();
  });

  it('still offers at an ordinary boating zoom (the 2026-08-10 field report)', () => {
    // ~0.40 deg of latitude is a phone at z10 over Quebec City: the old
    // 0.6 deg cap plus the 12-cell refusal made this return null, so the
    // banner never appeared where a boater actually looks.
    const offer = marinePackOffer({ ...base, view: around(46.8, -71.2, 0.2) });
    expect(offer).not.toBeNull();
    expect(offer!.cells.length).toBeLessThanOrEqual(MARINE_PACK_MAX_CELLS);
    expect(offer!.partial).toBe(true);
  });

  it('stays silent above the sanity ceiling (a passage plan, not a harbour)', () => {
    const wide = around(46.8, -71.2, MARINE_PACK_MAX_VIEW_SPAN_DEG);
    expect(marinePackOffer({ ...base, view: wide })).toBeNull();
  });

  it('stays silent where no packable source exists (open Pacific)', () => {
    expect(marinePackOffer({ ...base, view: FIJI })).toBeNull();
  });

  it('stays silent once the packs are installed', () => {
    const installed = new Set(marinePackCellsForView('nonna', QUEBEC).map((c) => c.key));
    expect(marinePackOffer({ ...base, installed })).toBeNull();
  });

  it('never nags a region the user waved off, until the snooze lapses', () => {
    const offer = marinePackOffer(base);
    expect(offer).not.toBeNull();
    const entries = [encodePackSnooze(offer!.regionKey, NOW + MARINE_PACK_SNOOZE_MS)];
    // Live entry: silent.
    expect(marinePackOffer({ ...base, snoozedRegions: snoozedPackRegions(entries) })).toBeNull();
    // The clock only enters through the hydration-time prune, which is what
    // keeps the trigger itself pure enough to run during render.
    const pruned = sanitizeMarinePackSnoozes(entries, NOW + MARINE_PACK_SNOOZE_MS + 1);
    expect(pruned).toEqual([]);
    expect(marinePackOffer({ ...base, snoozedRegions: snoozedPackRegions(pruned) })).not.toBeNull();
  });

  it('maps snooze entries to region keys without consulting a clock', () => {
    const keys = snoozedPackRegions([
      encodePackSnooze('nonna:1:1', NOW + 1000),
      'junk',
      encodePackSnooze('nonna:2:2', NOW - 1),
    ]);
    expect([...keys].sort()).toEqual(['nonna:1:1', 'nonna:2:2']);
  });

  it('does not call a same-class source coarse (EMODnet under EMODnet)', () => {
    const view = around(54, 2);
    const offer = marinePackOffer({ ...base, view, activeSourceId: 'emodnet' });
    expect(offer?.source.id).toBe('emodnet');
    expect(offer?.reason).toBe('offline');
  });

  it('writes quiet copy for every reason', () => {
    for (const activeSourceId of ['gebco', 'nonna', null] as const) {
      const offer = marinePackOffer({ ...base, activeSourceId });
      expect(offer).not.toBeNull();
      const message = marinePackOfferMessage(offer!);
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toContain('!');
    }
  });
});

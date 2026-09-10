import { GEOPDF_PARSER_REVISION, georeferenceRevision, needsReparse } from '@core/geo/geopdf';
import type { GeoReference, MapDocument } from '@core/models';

import { applyReparse, planReparse } from './reparse';

const geo = (pageIndex: number, revision?: number): GeoReference =>
  ({
    pageIndex,
    source: 'adobe-geo',
    pageWidthPt: 612,
    pageHeightPt: 792,
    ...(revision === undefined ? {} : { parserRevision: revision }),
    viewport: {
      rect: { x0: 0, y0: 0, x1: 612, y1: 792 },
      corners: {
        topLeft: [-71, 46.9],
        topRight: [-70, 46.9],
        bottomRight: [-70, 46],
        bottomLeft: [-71, 46],
      },
    },
    bbox: { minLng: -71, minLat: 46, maxLng: -70, maxLat: 46.9 },
  }) as GeoReference;

const doc = (over: Partial<MapDocument> = {}): MapDocument => ({
  id: 'm1',
  name: 'Sheet',
  fileUri: 'maps/m1.pdf',
  importedAt: 1,
  pageCount: 1,
  georeferences: [geo(0, GEOPDF_PARSER_REVISION)],
  activePages: [0],
  ...over,
});

describe('georeferenceRevision', () => {
  it('treats anything unstamped as the original parser', () => {
    expect(georeferenceRevision(undefined)).toBe(1);
    expect(georeferenceRevision({})).toBe(1);
    expect(georeferenceRevision({ parserRevision: 0 })).toBe(1);
    expect(georeferenceRevision({ parserRevision: Number.NaN })).toBe(1);
    expect(georeferenceRevision({ parserRevision: 3 })).toBe(3);
  });
});

describe('needsReparse', () => {
  it('catches the maps imported before the stamp existed', () => {
    expect(needsReparse({ georeferences: [{}] })).toBe(true);
  });

  it('leaves a map produced by the current parser alone', () => {
    expect(needsReparse({ georeferences: [{ parserRevision: GEOPDF_PARSER_REVISION }] })).toBe(
      false,
    );
  });

  it('catches a map where only ONE page is stale', () => {
    expect(
      needsReparse({
        georeferences: [{ parserRevision: GEOPDF_PARSER_REVISION }, { parserRevision: 1 }],
      }),
    ).toBe(true);
  });

  // A sheet stored as "no georeferencing found" may simply have predated the
  // projection the parser has since learned (#249 for CanTopo).
  it('retries a map that stored no georeferencing at all', () => {
    expect(needsReparse({ georeferences: [] })).toBe(true);
    expect(needsReparse({})).toBe(true);
  });
});

describe('planReparse', () => {
  it('queues the stale maps in Library order and skips the current ones', () => {
    const maps = [
      doc({ id: 'fresh' }),
      doc({ id: 'stale-a', georeferences: [geo(0)] }),
      doc({ id: 'stale-b', georeferences: [geo(0, 2)] }),
    ];
    expect(planReparse(maps).map((j) => j.docId)).toEqual(['stale-a', 'stale-b']);
  });

  it('skips a map with no file to read', () => {
    expect(planReparse([doc({ id: 'nofile', fileUri: '', georeferences: [geo(0)] })])).toEqual([]);
  });
});

describe('applyReparse', () => {
  const parsedWith = (refs: GeoReference[], warnings: string[] = []) => ({
    pageCount: 1,
    georeferences: refs,
    warnings,
  });

  it('replaces the georeferences and stamps them with the current parser', () => {
    const patch = applyReparse(doc({ georeferences: [geo(0)] }), parsedWith([geo(0)]));
    expect(patch?.georeferences[0]?.parserRevision).toBe(GEOPDF_PARSER_REVISION);
    expect(patch?.georeferenceWarning).toBeUndefined();
  });

  it('keeps a page the user had switched off switched off', () => {
    const patch = applyReparse(
      doc({ georeferences: [geo(0), geo(1)], activePages: [1] }),
      parsedWith([geo(0), geo(1)]),
    );
    expect(patch?.activePages).toEqual([1]);
  });

  it('turns on a page that only the new parser can place', () => {
    // Stored: page 0 only, switched on. New parse also reads page 1.
    const patch = applyReparse(
      doc({ georeferences: [geo(0)], activePages: [0] }),
      parsedWith([geo(0), geo(1)]),
    );
    expect(patch?.activePages).toEqual([0, 1]);
  });

  // The dangerous case: a short read must never downgrade a working map.
  it('refuses to replace working georeferencing with none', () => {
    expect(applyReparse(doc(), parsedWith([], ['PDF parse failed: truncated']))).toBeNull();
  });

  it('still records a warning for a map that never had any', () => {
    const patch = applyReparse(
      doc({ georeferences: [], activePages: [], georeferenceWarning: 'old wording' }),
      parsedWith([], ['no embedded georeferencing found']),
    );
    expect(patch?.georeferences).toEqual([]);
    expect(patch?.activePages).toEqual([]);
    expect(patch?.georeferenceWarning).toBe('no embedded georeferencing found');
  });
});

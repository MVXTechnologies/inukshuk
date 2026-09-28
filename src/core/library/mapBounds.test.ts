import type { GeoReference } from '@core/models';
import { mapDocumentBounds } from './mapBounds';

const page = (pageIndex: number, minLat: number, minLng: number): GeoReference =>
  ({
    pageIndex,
    bbox: { minLat, minLng, maxLat: minLat + 0.1, maxLng: minLng + 0.1 },
  }) as GeoReference;

describe('mapDocumentBounds', () => {
  it('unions the active pages only', () => {
    const doc = { georeferences: [page(0, 50, -63), page(1, 40, -70)], activePages: [0] };
    expect(mapDocumentBounds(doc)).toEqual({
      minLat: 50,
      minLng: -63,
      maxLat: 50.1,
      maxLng: -62.9,
    });
  });

  it('falls back to every georeferenced page when none is active', () => {
    const doc = { georeferences: [page(0, 50, -63), page(1, 40, -70)], activePages: [] };
    expect(mapDocumentBounds(doc)).toEqual({
      minLat: 40,
      minLng: -70,
      maxLat: 50.1,
      maxLng: -62.9,
    });
  });

  it('is null for a map with no georeference', () => {
    expect(mapDocumentBounds({ georeferences: [], activePages: [] })).toBeNull();
  });
});

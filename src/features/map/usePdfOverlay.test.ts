import type { GeoReference, MapDocument } from '@core/models';
import { activeTargets } from './usePdfOverlay';

jest.mock('expo-file-system', () => ({ File: class {} }));
jest.mock('@data/storage', () => ({}));
jest.mock('./PdfRasterizer', () => ({ usePdfRasterizer: () => jest.fn() }));

/**
 * A US Topo / AUSTopo sheet: one page, three viewports (the map plus two
 * insets). `primaryGeoreferenceForPage` picks the largest — the map frame.
 */
const viewport = (pageIndex: number, size: number): GeoReference => ({
  pageIndex,
  source: 'adobe-geo',
  pageWidthPt: 612,
  pageHeightPt: 792,
  viewport: {
    rect: { x0: 0, y0: 0, x1: size, y1: size },
    corners: {
      topLeft: [-71, 47],
      topRight: [-70, 47],
      bottomRight: [-70, 46],
      bottomLeft: [-71, 46],
    },
  },
  bbox: { minLat: 46, maxLat: 47, minLng: -71, maxLng: -70 },
});

const mapDoc = (activePages: number[], georeferences: GeoReference[]): MapDocument => ({
  id: 'm1',
  name: 'Grand Canyon — US Topo',
  fileUri: 'file://m1.pdf',
  importedAt: 1,
  pageCount: 1,
  georeferences,
  activePages,
});

describe('activeTargets', () => {
  // Maps imported before the primary-viewport fix persisted one activePages
  // entry per viewport ([0, 0, 0]); without de-duplication the same raster is
  // drawn three times — compounded opacity and three native layers for one map.
  it('draws a page once however many times it appears in activePages', () => {
    const targets = activeTargets([mapDoc([0, 0, 0], [viewport(0, 540), viewport(0, 142)])]);
    expect(targets).toHaveLength(1);
    // …and it is the PRIMARY (largest) viewport, not the first listed.
    expect(targets[0]?.geo.viewport.rect.x1).toBe(540);
  });

  it('still draws every distinct active page', () => {
    const targets = activeTargets([mapDoc([0, 1], [viewport(0, 540), viewport(1, 540)])]);
    expect(targets.map((t) => t.geo.pageIndex)).toEqual([0, 1]);
  });

  it('skips maps with no file and pages with no georeference', () => {
    expect(activeTargets([{ ...mapDoc([0], [viewport(0, 540)]), fileUri: '' }])).toEqual([]);
    expect(activeTargets([mapDoc([7], [viewport(0, 540)])])).toEqual([]);
  });
});

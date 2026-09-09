import {
  OVERLAY_TARGET_WIDTH_PX,
  documentRevision,
  rasterCacheKey,
  rasterFileName,
} from './overlayRaster';

describe('documentRevision', () => {
  // iOS rotates the container UUID on update; the revision must survive it so
  // a relaunch finds the raster it already has (#269).
  it('ignores the directory, keys on import time and file name', () => {
    const a = documentRevision({ importedAt: 5, fileUri: 'file:///A/maps/m1.pdf' });
    const b = documentRevision({ importedAt: 5, fileUri: 'file:///B/maps/m1.pdf' });
    expect(a).toBe(b);
    expect(a.startsWith('5_')).toBe(true);
  });

  it('changes when the PDF is replaced', () => {
    const before = documentRevision({ importedAt: 5, fileUri: 'maps/m1.pdf' });
    expect(documentRevision({ importedAt: 6, fileUri: 'maps/m1.pdf' })).not.toBe(before);
    expect(documentRevision({ importedAt: 5, fileUri: 'maps/m2.pdf' })).not.toBe(before);
  });
});

describe('raster identity', () => {
  it('names the width the PNG was rendered at', () => {
    expect(rasterFileName('m1', 2, 'r')).toBe(`m1_r_2_${OVERLAY_TARGET_WIDTH_PX}`);
    expect(rasterCacheKey('m1', 2, 'r')).toBe(`m1:r:2:${OVERLAY_TARGET_WIDTH_PX}`);
  });
});

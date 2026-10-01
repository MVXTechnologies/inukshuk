import { WHITE_KEY_LEVELS } from '@core/geo/pdfWhiteKey';
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

  it('keeps the plain name for Off and a distinct one per see-through level', () => {
    expect(rasterFileName('m1', 2, 'r', 0)).toBe(rasterFileName('m1', 2, 'r'));
    expect(rasterCacheKey('m1', 2, 'r', 0)).toBe(rasterCacheKey('m1', 2, 'r'));
    const names = new Set(WHITE_KEY_LEVELS.map((level) => rasterFileName('m1', 2, 'r', level)));
    const keys = new Set(WHITE_KEY_LEVELS.map((level) => rasterCacheKey('m1', 2, 'r', level)));
    expect(names.size).toBe(5);
    expect(keys.size).toBe(5);
    expect(rasterFileName('m1', 2, 'r', 4)).toBe(`m1_r_2_${OVERLAY_TARGET_WIDTH_PX}_wk-100`);
    expect(rasterFileName('m1', 2, 'r', 1)).toBe(`m1_r_2_${OVERLAY_TARGET_WIDTH_PX}_wk-25`);
    expect(rasterCacheKey('m1', 2, 'r', 2)).toBe(`m1:r:2:${OVERLAY_TARGET_WIDTH_PX}_wk-50`);
    expect(rasterCacheKey('m1', 2, 'r', 3)).toBe(`m1:r:2:${OVERLAY_TARGET_WIDTH_PX}_wk-75`);
  });
});

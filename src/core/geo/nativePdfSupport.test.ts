import { isPageLevelUnsupported } from './nativePdfSupport';

describe('isPageLevelUnsupported', () => {
  it.each([
    'Page is not a single opaque JPEG paint',
    'Unsupported page geometry or overlays',
    'Page needs one image resource',
    'Unsupported content streams',
    'Only baseline RGB JPEG is supported',
    'Image does not fill page',
    'Content stream exceeds recognition budget',
  ])('marks the page for %j', (reason) => {
    expect(isPageLevelUnsupported(reason)).toBe(true);
  });

  it.each([
    'Invalid crop geometry',
    'Invalid crop aspect',
    'Crop is too narrow',
    'Source crop is empty',
    'Cannot decode reduced JPEG',
    'Cannot decode cropped JPEG',
    'Cannot create crop output',
    'Cannot encode crop',
    'native tile could not be keyed',
    'crop exceeds decoder budget',
    '',
  ])('keeps the per-crop rule for %j', (reason) => {
    expect(isPageLevelUnsupported(reason)).toBe(false);
  });
});

import { isPageLevelUnsupported, persistentNativeGeometryKey } from './nativePdfSupport';

describe('persistentNativeGeometryKey', () => {
  const page = {
    fileUri: 'file:///var/mobile/Containers/Data/Application/AAA/Documents/maps/abc.pdf',
    revision: '17',
    pageIndex: 0,
    widthPt: 1600,
    heightPt: 1940,
  };

  it('survives the iOS container moving', () => {
    const moved = { ...page, fileUri: page.fileUri.replace('/AAA/', '/BBB/') };
    expect(persistentNativeGeometryKey(moved, 'v1')).toBe(persistentNativeGeometryKey(page, 'v1'));
  });

  it('changes with the file, its revision, the page, its size and the layer plan', () => {
    const base = persistentNativeGeometryKey(page, 'v1');
    for (const other of [
      { ...page, fileUri: page.fileUri.replace('abc', 'abd') },
      { ...page, revision: '18' },
      { ...page, pageIndex: 1 },
      { ...page, widthPt: 1601 },
      { ...page, heightPt: 1 },
    ])
      expect(persistentNativeGeometryKey(other, 'v1')).not.toBe(base);
    expect(persistentNativeGeometryKey(page, 'v2')).not.toBe(base);
  });
});

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

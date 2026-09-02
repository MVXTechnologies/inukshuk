import { isRenderedRasterMap, looksLikeGeoTiffFile, mapFileExtension } from './mapFile';

describe('mapFileExtension', () => {
  it('reads the extension off a file uri', () => {
    expect(mapFileExtension('file:///docs/maps/abc.pdf')).toBe('pdf');
    expect(mapFileExtension('file:///docs/maps/abc.PNG')).toBe('png');
  });

  it('ignores a query string or fragment', () => {
    expect(mapFileExtension('https://x/y/sheet.tif?v=2#page')).toBe('tif');
  });

  it('is null when there is none, and unfazed by dots in directories', () => {
    expect(mapFileExtension('file:///docs/maps/abc')).toBeNull();
    expect(mapFileExtension('file:///v1.2/maps/abc')).toBeNull();
  });
});

describe('isRenderedRasterMap', () => {
  it('is true for a stored overlay image — the GeoTIFF import path', () => {
    expect(isRenderedRasterMap('file:///docs/maps/id.png')).toBe(true);
    expect(isRenderedRasterMap('file:///docs/maps/id.jpg')).toBe(true);
  });

  it('is false for a PDF, which still has to go through the rasterizer', () => {
    expect(isRenderedRasterMap('file:///docs/maps/id.pdf')).toBe(false);
  });

  it('is false for a raw TIFF: the app never stores one, and cannot draw one', () => {
    expect(isRenderedRasterMap('file:///docs/maps/id.tif')).toBe(false);
  });
});

describe('looksLikeGeoTiffFile', () => {
  it('recognizes both extensions and the real mime type', () => {
    expect(looksLikeGeoTiffFile({ name: '021l14_1_1.tif' })).toBe(true);
    expect(looksLikeGeoTiffFile({ name: 'sheet.TIFF' })).toBe(true);
    expect(looksLikeGeoTiffFile({ name: 'sheet', mimeType: 'image/tiff' })).toBe(true);
  });

  it('trusts the extension when Android types a .tif as octet-stream', () => {
    expect(looksLikeGeoTiffFile({ name: 'sheet.tif', mimeType: 'application/octet-stream' })).toBe(
      true,
    );
  });

  it('leaves PDFs and unknowns to the document importer', () => {
    expect(looksLikeGeoTiffFile({ name: 'sheet.pdf', mimeType: 'application/pdf' })).toBe(false);
    expect(looksLikeGeoTiffFile({})).toBe(false);
    expect(looksLikeGeoTiffFile({ name: null, mimeType: null })).toBe(false);
  });
});

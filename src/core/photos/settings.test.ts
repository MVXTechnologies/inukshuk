import {
  isPhotoCirclesAppear,
  isPhotoCopySize,
  MAIN_MAP_PHOTO_MIN_ZOOM,
  mainMapPhotoMinZoom,
} from './settings';

describe('photo settings', () => {
  it('recognises the circle modes and copy sizes', () => {
    expect(isPhotoCirclesAppear('zoomed')).toBe(true);
    expect(isPhotoCirclesAppear('sometimes')).toBe(false);
    expect(isPhotoCirclesAppear(undefined)).toBe(false);
    expect(isPhotoCopySize('full')).toBe(true);
    expect(isPhotoCopySize('huge')).toBe(false);
  });

  it('maps the switches to the main map layer zoom', () => {
    expect(mainMapPhotoMinZoom(false, 'always')).toBeNull();
    expect(mainMapPhotoMinZoom(true, 'trail')).toBeNull();
    expect(mainMapPhotoMinZoom(true, 'zoomed')).toBe(MAIN_MAP_PHOTO_MIN_ZOOM);
    expect(mainMapPhotoMinZoom(true, 'always')).toBe(0);
  });
});

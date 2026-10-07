import { deleteAllPhotosPrompt, describePhotoUsage } from './settingsText';

describe('describePhotoUsage', () => {
  it('counts photos, trails and size', () => {
    expect(describePhotoUsage({ photos: 33, trails: 2, bytes: 19e6 })).toBe(
      '33 photos on 2 trails · 19 MB',
    );
    expect(describePhotoUsage({ photos: 1, trails: 1, bytes: 700e3 })).toBe(
      '1 photo on 1 trail · 700 KB',
    );
  });

  it('says when there is nothing, or while counting', () => {
    expect(describePhotoUsage({ photos: 0, trails: 0, bytes: 0 })).toBe('No photo copies yet');
    expect(describePhotoUsage(null)).toBe('Counting…');
  });
});

describe('deleteAllPhotosPrompt', () => {
  it('names how many copies go and that the library is untouched', () => {
    expect(deleteAllPhotosPrompt({ photos: 33, trails: 2, bytes: 1 })).toMatch(
      /^Delete the 33 copies Inukshuk keeps .*photo library is not touched/,
    );
    expect(deleteAllPhotosPrompt({ photos: 1, trails: 1, bytes: 1 })).toMatch(/the copy /);
    expect(deleteAllPhotosPrompt(null)).toMatch(/every copy/);
  });
});

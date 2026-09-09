import * as storage from '@data/storage';

import { discardDraftPhoto, withDraftPhoto } from './waypointDraft';

jest.mock('@data/storage', () => ({ deleteFileAt: jest.fn() }));

const at = { latitude: 46.8, longitude: -71.2 };
const copied = 'file:///doc/photos/a.jpg';

describe('waypoint draft photo ownership (#306)', () => {
  it('Remove photo drops the field so Done cannot save the removed attachment', () => {
    const draft = withDraftPhoto({ ...at, photoUri: copied }, '');
    // The field is gone — not `undefined`, not the old uri: MapScreen's Done
    // path spreads `photoUri` into the store patch only when it is present.
    expect(draft).toEqual(at);
    expect('photoUri' in draft).toBe(false);
    // ...and the copy the draft owned is unlinked.
    expect(storage.deleteFileAt).toHaveBeenCalledWith(copied);
  });

  it('replacing the photo deletes the earlier copy and keeps the new one', () => {
    const draft = withDraftPhoto({ ...at, photoUri: copied }, 'file:///doc/photos/b.jpg');
    expect(draft).toEqual({ ...at, photoUri: 'file:///doc/photos/b.jpg' });
    expect(storage.deleteFileAt).toHaveBeenCalledTimes(1);
    expect(storage.deleteFileAt).toHaveBeenCalledWith(copied);
  });

  it('attaching to a photo-less draft deletes nothing; re-setting the same uri is a no-op', () => {
    expect(withDraftPhoto(at, copied)).toEqual({ ...at, photoUri: copied });
    expect(withDraftPhoto({ ...at, photoUri: copied }, copied)).toEqual({
      ...at,
      photoUri: copied,
    });
    expect(storage.deleteFileAt).not.toHaveBeenCalled();
  });

  it('discarding the draft (Delete on a not-yet-created waypoint) unlinks its photo', () => {
    discardDraftPhoto({ ...at, photoUri: copied });
    expect(storage.deleteFileAt).toHaveBeenCalledWith(copied);
    discardDraftPhoto(at);
    discardDraftPhoto(null);
    expect(storage.deleteFileAt).toHaveBeenCalledTimes(1);
  });

  it('a failing unlink never throws out of the editor action', () => {
    jest.mocked(storage.deleteFileAt).mockImplementation(() => {
      throw new Error('EPERM');
    });
    expect(() => discardDraftPhoto({ ...at, photoUri: copied })).not.toThrow();
    expect(withDraftPhoto({ ...at, photoUri: copied }, '')).toEqual(at);
  });
});

import {
  NEWER_VERSION_NOTICE,
  photoEditFailureMessage,
  photoListNotice,
  UNREADABLE_NOTICE,
} from './status';

describe('photo list notices', () => {
  it('blocks a newer-version or unreadable list with a message', () => {
    expect(photoListNotice('future')).toBe(NEWER_VERSION_NOTICE);
    expect(photoListNotice('unreadable')).toBe(UNREADABLE_NOTICE);
    expect(photoListNotice('error')).toMatch(/could not be loaded/);
  });

  it('says nothing when the list is usable or still loading', () => {
    for (const s of ['ok', 'missing', 'loading', undefined] as const) {
      expect(photoListNotice(s)).toBeNull();
    }
  });

  it('explains a refused edit from the error’s status', () => {
    const err = Object.assign(new Error('x'), { status: 'future' });
    expect(photoEditFailureMessage(err, 'Could not save')).toBe(NEWER_VERSION_NOTICE);
    expect(photoEditFailureMessage({ status: 'unreadable' }, 'Could not save')).toBe(
      UNREADABLE_NOTICE,
    );
    expect(photoEditFailureMessage(new Error('io'), 'Could not save')).toBe('Could not save');
    expect(photoEditFailureMessage(null, 'Could not save')).toBe('Could not save');
  });
});

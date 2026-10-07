import { trailPhotoFilesForArchive } from './archiveFiles';
import { writePhotoCopies } from './photoFiles';
import { writeSidecar } from './sidecarStore';
import { fakeFs } from './testUtils/testFileSystem';

jest.mock('expo-file-system', () =>
  jest
    .requireActual<typeof import('./testUtils/testFileSystem')>('./testUtils/testFileSystem')
    .createFakeFileSystem(),
);

const fs = fakeFs();
const out = { display: 'QQ==', thumb: 'QQ==', sprite: 'QQ==' };

beforeEach(() => fs.reset());

it('lists each kept trail’s display copies and its photo list, unparsed', () => {
  writePhotoCopies('t1', 'b', out);
  writePhotoCopies('t1', 'a', out);
  writeSidecar({ version: 1, trackId: 't1', photos: [], comments: [] }, 0);
  writePhotoCopies('t2', 'x', out);
  // A list from a newer app version still travels as it is.
  fs.seed('/doc/photos/t2/photos.json', '{"version":9}');
  writePhotoCopies('deleted', 'z', out);
  fs.seed('/doc/photos/note-photo.jpg', 'flat note photo');

  const files = trailPhotoFilesForArchive(new Set(['t1', 't2', 't3']));
  expect([...files.keys()].sort()).toEqual(['t1', 't2']);
  expect(files.get('t1')).toEqual({
    photos: [
      { id: 'a', file: 'file:///doc/photos/t1/a.jpg' },
      { id: 'b', file: 'file:///doc/photos/t1/b.jpg' },
    ],
    listUri: 'file:///doc/photos/t1/photos.json',
  });
  expect(files.get('t2')?.listUri).toBe('file:///doc/photos/t2/photos.json');
});

it('skips a trail folder without display copies', () => {
  writeSidecar({ version: 1, trackId: 't1', photos: [], comments: [] }, 0);
  expect(trailPhotoFilesForArchive(new Set(['t1'])).size).toBe(0);
});

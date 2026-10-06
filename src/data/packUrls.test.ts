import { deletePackUrls, readPackUrls, savePackUrls } from './packUrls';
import { readJson, writeJson } from './storage';

jest.mock('./storage', () => {
  let stored: unknown = null;
  return {
    readJson: jest.fn(async () => stored),
    writeJson: jest.fn((_name: string, value: unknown) => {
      stored = value;
    }),
    __set: (v: unknown) => {
      stored = v;
    },
  };
});

const setStored = (jest.requireMock('./storage') as { __set: (v: unknown) => void }).__set;

beforeEach(() => {
  setStored(null);
  jest.clearAllMocks();
});

it('reads nothing from a missing or malformed file', async () => {
  expect(await readPackUrls()).toEqual({});
  setStored([1]);
  expect(await readPackUrls()).toEqual({});
});

it('keeps only well-formed stamps', async () => {
  setStored({ a: { glyphs: 'g' }, b: { glyphs: 3 }, c: 'x' });
  expect(await readPackUrls()).toEqual({ a: { glyphs: 'g' } });
});

it('merges saves and deletes one stamp', async () => {
  await savePackUrls({ a: { glyphs: 'g' } });
  await savePackUrls({ b: { glyphs: 'h' } });
  expect(await readPackUrls()).toEqual({ a: { glyphs: 'g' }, b: { glyphs: 'h' } });
  expect(readJson).toHaveBeenCalledWith('offline-pack-urls.json');

  await deletePackUrls('a');
  expect(await readPackUrls()).toEqual({ b: { glyphs: 'h' } });
  (writeJson as jest.Mock).mockClear();
  await deletePackUrls('missing');
  expect(writeJson).not.toHaveBeenCalled();
});

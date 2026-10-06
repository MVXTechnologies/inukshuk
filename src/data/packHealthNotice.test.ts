import { readAnnouncedStale, saveAnnouncedStale } from './packHealthNotice';
import { writeJson } from './storage';

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
  expect(await readAnnouncedStale()).toEqual([]);
  setStored({ a: 1 });
  expect(await readAnnouncedStale()).toEqual([]);
  setStored(['a', 7, 'b']);
  expect(await readAnnouncedStale()).toEqual(['a', 'b']);
});

it('round-trips the announced ids, sorted', async () => {
  await saveAnnouncedStale(['b', 'a']);
  expect(writeJson).toHaveBeenCalledWith('offline-stale-announced.json', ['a', 'b']);
  expect(await readAnnouncedStale()).toEqual(['a', 'b']);
});

import * as storage from './storage';
import { loadSupportCosts, SUPPORT_COSTS_URL } from './supportCosts';

jest.mock('./storage', () => ({
  readJson: jest.fn(),
  writeJson: jest.fn(),
  isNetworkAllowed: jest.fn(() => true),
}));

const readJson = storage.readJson as jest.Mock;
const writeJson = storage.writeJson as jest.Mock;
const isNetworkAllowed = storage.isNetworkAllowed as jest.Mock;

// The supporter count stands in for "which copy was served".
const doc = (supporters: number) => ({
  year: 2026,
  goals: [
    { id: 'keepUp', percent: 40 },
    { id: 'features', percent: 0 },
  ],
  supporters,
  updated: '2026-09-30',
  donors: [],
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  readJson.mockResolvedValue(null);
  isNetworkAllowed.mockReturnValue(true);
});

it('fetches the public file and caches it', async () => {
  fetchMock.mockResolvedValue(ok(doc(40)));
  const result = await loadSupportCosts();
  expect(fetchMock).toHaveBeenCalledWith(SUPPORT_COSTS_URL, expect.anything());
  expect(result).toEqual({ doc: expect.objectContaining({ supporters: 40 }), fromCache: false });
  expect(writeJson).toHaveBeenCalledWith('support-costs.json', {
    fetchedAt: expect.any(Number),
    raw: doc(40),
  });
});

it('serves a fresh cached copy without the network', async () => {
  readJson.mockResolvedValue({ fetchedAt: Date.now() - 1000, raw: doc(10) });
  const result = await loadSupportCosts();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(result).toEqual({ doc: expect.objectContaining({ supporters: 10 }), fromCache: true });
});

it('refetches a stale copy, and a fresh one when forced', async () => {
  fetchMock.mockResolvedValue(ok(doc(99)));
  readJson.mockResolvedValue({ fetchedAt: Date.now() - 2 * 86_400_000, raw: doc(10) });
  expect((await loadSupportCosts())?.doc.supporters).toBe(99);
  readJson.mockResolvedValue({ fetchedAt: Date.now(), raw: doc(10) });
  expect((await loadSupportCosts({ force: true }))?.doc.supporters).toBe(99);
});

it('falls back to the cached copy when offline or the file is broken', async () => {
  readJson.mockResolvedValue({ fetchedAt: 0, raw: doc(10) });
  fetchMock.mockRejectedValue(new Error('offline'));
  expect(await loadSupportCosts()).toEqual({
    doc: expect.objectContaining({ supporters: 10 }),
    fromCache: true,
  });
  fetchMock.mockResolvedValue(ok({ junk: true }));
  expect((await loadSupportCosts())?.doc.supporters).toBe(10);
  fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);
  expect((await loadSupportCosts())?.doc.supporters).toBe(10);
});

it('returns null with nothing anywhere', async () => {
  fetchMock.mockRejectedValue(new Error('offline'));
  expect(await loadSupportCosts()).toBeNull();
});

it('ignores an unreadable or malformed cache', async () => {
  readJson.mockRejectedValue(new Error('io'));
  fetchMock.mockRejectedValue(new Error('offline'));
  expect(await loadSupportCosts()).toBeNull();
  readJson.mockResolvedValue({ raw: doc(1) });
  expect(await loadSupportCosts()).toBeNull();
});

it('makes no request while "Locally downloaded only" is on', async () => {
  isNetworkAllowed.mockReturnValue(false);
  readJson.mockResolvedValue({ fetchedAt: 0, raw: doc(10) });
  expect((await loadSupportCosts())?.doc.supporters).toBe(10);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('still returns fresh numbers when the cache write fails', async () => {
  writeJson.mockImplementation(() => {
    throw new Error('disk full');
  });
  fetchMock.mockResolvedValue(ok(doc(7)));
  expect((await loadSupportCosts())?.doc.supporters).toBe(7);
});

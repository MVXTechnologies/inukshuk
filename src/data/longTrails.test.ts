import { rawDetail, rawIndex } from '@core/trails/__fixtures__/trails';

import { DEFAULT_LONG_TRAILS_URL, loadTrailDetail, loadTrailIndex } from './longTrails';
import * as storage from './storage';

jest.mock('./storage', () => ({ readJson: jest.fn(), writeJson: jest.fn() }));

const readJson = storage.readJson as jest.Mock;
const writeJson = storage.writeJson as jest.Mock;
const INDEX_URL = `${DEFAULT_LONG_TRAILS_URL}/index.json`;

function respond(body: unknown, ok = true) {
  global.fetch = jest.fn(async () => ({
    ok,
    status: ok ? 200 : 404,
    json: async () => body,
  })) as never;
}

beforeEach(() => {
  readJson.mockResolvedValue(null);
  writeJson.mockReset();
});

describe('loadTrailIndex', () => {
  it('fetches, parses and caches the index', async () => {
    respond(rawIndex());
    const result = await loadTrailIndex();
    expect(result?.fromCache).toBe(false);
    expect(result?.index.trails).toHaveLength(4);
    expect(global.fetch).toHaveBeenCalledWith(INDEX_URL, expect.anything());
    expect(writeJson).toHaveBeenCalledWith(
      'long-trails-index.json',
      expect.objectContaining({ url: INDEX_URL }),
    );
  });

  it('serves a fresh cache without the network, a stale one when offline', async () => {
    readJson.mockResolvedValue({ fetchedAt: Date.now(), url: INDEX_URL, raw: rawIndex() });
    respond(null, false);
    expect((await loadTrailIndex())?.fromCache).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();

    readJson.mockResolvedValue({ fetchedAt: 0, url: INDEX_URL, raw: rawIndex() });
    const stale = await loadTrailIndex();
    expect(global.fetch).toHaveBeenCalled();
    expect(stale?.fromCache).toBe(true);
  });

  it('is null before the data is deployed', async () => {
    respond({ error: 'not found' }, false);
    expect(await loadTrailIndex()).toBeNull();
    respond({ schema: 9 });
    expect(await loadTrailIndex({ force: true })).toBeNull();
  });
});

describe('loadTrailDetail', () => {
  it('fetches by version and keeps a copy', async () => {
    respond(rawDetail(true));
    const d = await loadTrailDetail('r8730405', 'pilot1');
    expect(d?.stages).toHaveLength(4);
    expect(global.fetch).toHaveBeenCalledWith(
      `${DEFAULT_LONG_TRAILS_URL}/d/pilot1/r8730405.json`,
      expect.anything(),
    );
    expect(writeJson).toHaveBeenCalledWith('long-trail-r8730405.json', expect.anything());
  });

  it('uses the cached copy for the same version, and any copy offline', async () => {
    const url = `${DEFAULT_LONG_TRAILS_URL}/d/pilot1/r8730405.json`;
    readJson.mockResolvedValue({ fetchedAt: 0, url, raw: rawDetail(false) });
    respond(null, false);
    expect((await loadTrailDetail('r8730405', 'pilot1'))?.stages).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
    // A newer build is published but the phone is offline: the old copy still opens.
    expect((await loadTrailDetail('r8730405', 'pilot2'))?.id).toBe('r8730405');
    readJson.mockResolvedValue(null);
    expect(await loadTrailDetail('r8730405', 'pilot2')).toBeNull();
  });
});

import { fetchPlaces, loadPlaceRecents, PlaceSearchError, savePlaceRecents } from './placeSearch';

const mockReadJson = jest.fn();
const mockWriteJson = jest.fn();
jest.mock('./storage', () => ({
  readJson: (name: string) => mockReadJson(name) as unknown,
  writeJson: (name: string, value: unknown) => mockWriteJson(name, value) as unknown,
}));

const fetchMock = jest.fn();
const realFetch = global.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  mockReadJson.mockReset();
  mockWriteJson.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as Response;

const params = (signal = new AbortController().signal) => ({
  text: 'Mont-Sainte-Anne',
  lang: 'fr' as const,
  near: { latitude: 46.81394, longitude: -71.20821 },
  signal,
});

describe('fetchPlaces', () => {
  it('asks our Worker with the rounded location and parses the answer', async () => {
    fetchMock.mockResolvedValue(
      json({
        features: [
          {
            geometry: { coordinates: [-70.93, 47.09] },
            properties: {
              osm_type: 'N',
              osm_id: 1,
              osm_key: 'natural',
              osm_value: 'peak',
              name: 'Mont Sainte-Anne',
            },
          },
        ],
      }),
    );
    const places = await fetchPlaces(params());
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(
      /\/search\?q=Mont-Sainte-Anne&lang=fr&alt=en&limit=15&lat=46\.81&lon=-71\.21$/,
    );
    expect(url).not.toMatch(/46\.813/);
    expect(places).toEqual([expect.objectContaining({ name: 'Mont Sainte-Anne', type: 'peak' })]);
  });

  it.each<[number, string]>([
    [429, 'busy'],
    [503, 'busy'],
    [504, 'offline'],
    [500, 'failed'],
    [400, 'failed'],
  ])('maps HTTP %d to %s', async (status, reason) => {
    fetchMock.mockResolvedValue(json({ message: 'x' }, status));
    await expect(fetchPlaces(params())).rejects.toMatchObject({ reason });
  });

  it('reports a network failure as offline', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    const err = await fetchPlaces(params()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaceSearchError);
    expect(err).toMatchObject({ reason: 'offline' });
  });

  it('reports an unreadable body as failed', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('bad json')),
    });
    await expect(fetchPlaces(params())).rejects.toMatchObject({ reason: 'failed' });
  });

  it('rethrows a caller abort as is, not as offline', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        }),
    );
    const pending = fetchPlaces(params(controller.signal));
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PlaceSearchError);
  });
});

describe('recents persistence', () => {
  it('loads a sanitized list, [] on junk or errors', async () => {
    mockReadJson.mockResolvedValueOnce([
      { id: 'a', source: 'index', type: 'peak', name: 'A', latitude: 1, longitude: 2 },
      { junk: true },
    ]);
    expect(await loadPlaceRecents()).toHaveLength(1);
    mockReadJson.mockResolvedValueOnce(null);
    expect(await loadPlaceRecents()).toEqual([]);
    mockReadJson.mockRejectedValueOnce(new Error('disk'));
    expect(await loadPlaceRecents()).toEqual([]);
  });

  it('saves best-effort', () => {
    savePlaceRecents([]);
    expect(mockWriteJson).toHaveBeenCalledWith('place-search-recents.json', []);
    mockWriteJson.mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() => savePlaceRecents([])).not.toThrow();
  });
});

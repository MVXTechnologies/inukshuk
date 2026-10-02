import { uploadTrackToStrava } from './strava';

// Saved trails persist a document-relative path (`tracks/<id>.gpx`, #255).
// The upload must hand the native networking layer the ABSOLUTE uri, or
// every push dies as "could not reach Strava — check your connection".

jest.mock('@data/storage', () => ({
  resolveDocumentPath: (p: string) =>
    p.startsWith('file://') ? p : `file:///data/user/0/app/files/${p}`,
}));
jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    bytes() {
      return Promise.resolve(new Uint8Array());
    }
  },
}));
jest.mock('@data/basemapTiles', () => ({ TILE_HOST: 'https://tiles.example' }));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('@state/stravaStore', () => ({
  useStravaStore: {
    getState: () => ({
      connection: {
        accessToken: 'token',
        refreshToken: 'refresh',
        expiresAt: Date.now() / 1000 + 3600,
        athleteId: 1,
        athleteName: 'Test',
        scopes: ['activity:write'],
      },
    }),
  },
}));

type Part = { key: string; value: unknown; filename?: string };
class FakeFormData {
  parts: Part[] = [];
  append(key: string, value: unknown, filename?: string) {
    this.parts.push({ key, value, filename });
  }
}

const realFormData = global.FormData;
const realFetch = global.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  (global as unknown as { FormData: unknown }).FormData = FakeFormData;
  fetchMock = jest.fn(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ id: 7, activity_id: 42, error: null, status: 'Your activity is ready.' }),
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.FormData = realFormData;
  global.fetch = realFetch;
});

const filePartEntry = () => {
  const body = (fetchMock.mock.calls[0] as unknown[])[1] as { body: FakeFormData };
  return body.body.parts.find((p) => p.key === 'file');
};
const filePart = () => filePartEntry()?.value as { uri: string; bytes?: unknown };

it('uploads a relative stored path as an absolute file uri', async () => {
  const outcome = await uploadTrackToStrava({
    id: 'abc',
    name: 'Morning run',
    fileUri: 'tracks/abc.gpx',
  });
  expect(outcome).toEqual({ kind: 'ready' });
  expect(filePart().uri).toBe('file:///data/user/0/app/files/tracks/abc.gpx');
});

it('passes an already-absolute uri through unchanged', async () => {
  await uploadTrackToStrava({
    id: 'abc',
    name: 'Morning run',
    fileUri: 'file:///somewhere/else/abc.gpx',
  });
  expect(filePart().uri).toBe('file:///somewhere/else/abc.gpx');
});

// Expo SDK 56's fetch rejects React Native's { uri, name, type } descriptor
// ("Unsupported FormDataPart implementation", #525): the part must be a
// Blob-like object exposing bytes(), with the GPX file name.
it('sends the GPX as a bytes()-capable file part named <id>.gpx', async () => {
  await uploadTrackToStrava({ id: 'abc', name: 'Morning run', fileUri: 'tracks/abc.gpx' });
  expect(typeof filePart().bytes).toBe('function');
  expect(filePartEntry()?.filename).toBe('abc.gpx');
});

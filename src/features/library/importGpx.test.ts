import { importGpxFromUri } from './importGpx';
import * as storage from '@data/storage';

jest.mock('@data/storage', () => ({
  newId: jest.fn(() => 'import-id'),
  readFileBytes: jest.fn(),
  writeTrackGpx: jest.fn(() => 'file:///saved.gpx'),
  deleteFileAt: jest.fn(),
}));
jest.mock('expo-document-picker', () => ({}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

it.each([
  ['', 'navigation'],
  ['<time>not-a-time</time>', 'navigation'],
  ['<time>1970-01-01T00:00:00Z</time>', undefined],
  ['<time>2024-01-01T00:00:00Z</time>', undefined],
])('classifies the actual imported GPX timing: %s', async (time, category) => {
  jest
    .mocked(storage.readFileBytes)
    .mockResolvedValue(
      new TextEncoder().encode(
        `<gpx><rte><rtept lat="45" lon="-73">${time}</rtept><rtept lat="45.001" lon="-73" /></rte></gpx>`,
      ),
    );
  const result = await importGpxFromUri('file:///source.gpx', 'Route');
  expect(result.track.category).toBe(category);
  expect(result.track.points).toHaveLength(2);
  expect(result.track.stats.distanceM).toBeGreaterThan(100);
  expect(result.track.stats.durationS).toBe(0);
});

// #360, #361: iOS `File.text()` refused these ("the text encoding of its
// contents can't be determined"); the import now decodes the bytes itself.
const LATIN1_GPX =
  '<?xml version="1.0" encoding="ISO-8859-1"?>\n<gpx><trk><name>Sentier des Érables</name>' +
  '<trkseg><trkpt lat="46.8" lon="-71.2"/><trkpt lat="46.801" lon="-71.2"/></trkseg></trk></gpx>';

it('imports a Latin-1 GPX and stores it as UTF-8 that says so', async () => {
  jest.mocked(storage.readFileBytes).mockResolvedValue(Buffer.from(LATIN1_GPX, 'latin1'));
  const result = await importGpxFromUri('file:///latin1.gpx', 'Fallback');
  expect(result.track.name).toBe('Sentier des Érables');
  const stored = jest.mocked(storage.writeTrackGpx).mock.calls.at(-1)?.[1];
  expect(stored).toContain('encoding="UTF-8"');
  expect(stored).toContain('Sentier des Érables');
});

it('imports a UTF-16 GPX with a byte-order mark', async () => {
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(LATIN1_GPX.replace('ISO-8859-1', 'UTF-16'), 'utf16le'),
  ]);
  jest.mocked(storage.readFileBytes).mockResolvedValue(utf16);
  const result = await importGpxFromUri('file:///utf16.gpx', 'Fallback');
  expect(result.track.name).toBe('Sentier des Érables');
  expect(result.track.points).toHaveLength(2);
});

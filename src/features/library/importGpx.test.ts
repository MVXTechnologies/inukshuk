import { importGpxFromUri } from './importGpx';
import * as storage from '@data/storage';

jest.mock('@data/storage', () => ({
  newId: jest.fn(() => 'import-id'),
  readFileText: jest.fn(),
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
    .mocked(storage.readFileText)
    .mockResolvedValue(
      `<gpx><rte><rtept lat="45" lon="-73">${time}</rtept><rtept lat="45.001" lon="-73" /></rte></gpx>`,
    );
  const result = await importGpxFromUri('file:///source.gpx', 'Route');
  expect(result.track.category).toBe(category);
  expect(result.track.points).toHaveLength(2);
  expect(result.track.stats.distanceM).toBeGreaterThan(100);
  expect(result.track.stats.durationS).toBe(0);
});

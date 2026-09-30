import { MAP_MAX_PITCH_DEG } from '@core/map/tiltRelief';
import { raiseMapMaxPitch } from './nativeMapPitch';

const mockRequire = jest.fn();
jest.mock('expo', () => ({
  requireOptionalNativeModule: (name: string) => mockRequire(name),
}));

beforeEach(() => mockRequire.mockReset());

it('asks the native module for the app-wide max pitch', async () => {
  const setMaxPitch = jest.fn(async () => 2);
  mockRequire.mockReturnValue({ setMaxPitch });
  await expect(raiseMapMaxPitch()).resolves.toBe(2);
  expect(mockRequire).toHaveBeenCalledWith('InukshukMapPitch');
  expect(setMaxPitch).toHaveBeenCalledWith(MAP_MAX_PITCH_DEG);
});

it('is a no-op on a binary without the module (pre-2.0.2 OTA)', async () => {
  mockRequire.mockReturnValue(null);
  await expect(raiseMapMaxPitch()).resolves.toBe(0);
});

it('never throws when the native call fails', async () => {
  mockRequire.mockReturnValue({
    setMaxPitch: jest.fn(async () => {
      throw new Error('no activity');
    }),
  });
  await expect(raiseMapMaxPitch()).resolves.toBe(0);
});

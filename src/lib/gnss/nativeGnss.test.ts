import { DEFAULT_GNSS_PROFILES, HM10_SERIAL } from '@core/gnss/bleProfiles';
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

import { connectOptions, DEFAULT_BLE_MTU, getNativeGnss, gnssNativeAvailable } from './nativeGnss';

jest.mock('expo', () => ({ requireOptionalNativeModule: jest.fn(() => null) }));

const requireMock = requireOptionalNativeModule as jest.Mock;

describe('getNativeGnss', () => {
  const os = Platform.OS;
  afterEach(() => {
    Platform.OS = os;
    requireMock.mockReset().mockReturnValue(null);
  });

  it('is null on a binary without the module (pre-2.5.0 OTA targets)', () => {
    Platform.OS = 'android';
    expect(getNativeGnss()).toBeNull();
    expect(gnssNativeAvailable()).toBe(false);
    expect(requireMock).toHaveBeenCalledWith('InukshukGnss');
  });

  it('returns the module when the binary has it', () => {
    Platform.OS = 'ios';
    const mod = { getState: jest.fn() };
    requireMock.mockReturnValue(mod);
    expect(getNativeGnss()).toBe(mod);
    expect(gnssNativeAvailable()).toBe(true);
  });

  it('never looks on web', () => {
    Platform.OS = 'web';
    requireMock.mockReturnValue({});
    expect(getNativeGnss()).toBeNull();
    expect(requireMock).not.toHaveBeenCalled();
  });
});

describe('connectOptions', () => {
  it('sends the default serial profiles for BLE', () => {
    const o = connectOptions({ deviceId: 'AA:BB', transport: 'ble' });
    expect(o).toEqual({
      deviceId: 'AA:BB',
      transport: 'ble',
      profiles: [...DEFAULT_GNSS_PROFILES],
      autoReconnect: true,
      mtu: DEFAULT_BLE_MTU,
    });
  });

  it('keeps explicit choices', () => {
    const o = connectOptions({
      deviceId: 'x',
      transport: 'ble',
      profiles: [HM10_SERIAL],
      autoReconnect: false,
      mtu: 185,
    });
    expect(o).toMatchObject({ profiles: [HM10_SERIAL], autoReconnect: false, mtu: 185 });
  });

  it('sends no profiles for Classic SPP and passes the fake frames through', () => {
    expect(connectOptions({ deviceId: 'x', transport: 'spp' }).profiles).toEqual([]);
    const fake = { frames: ['JA=='], intervalMs: 100, loop: true };
    expect(connectOptions({ deviceId: 'f', transport: 'fake', fake }).fake).toBe(fake);
  });
});

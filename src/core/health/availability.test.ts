import {
  HC_SDK_AVAILABLE,
  HC_SDK_PROVIDER_UPDATE_REQUIRED,
  HC_SDK_UNAVAILABLE,
  healthConnectAvailability,
} from './availability';

describe('healthConnectAvailability', () => {
  it('maps the SDK status codes', () => {
    expect(healthConnectAvailability(HC_SDK_AVAILABLE)).toBe('available');
    expect(healthConnectAvailability(HC_SDK_PROVIDER_UPDATE_REQUIRED)).toBe('needs-install');
    expect(healthConnectAvailability(HC_SDK_UNAVAILABLE)).toBe('unavailable');
    expect(healthConnectAvailability(99)).toBe('unavailable');
  });
});

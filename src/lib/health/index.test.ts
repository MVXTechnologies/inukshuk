/**
 * The platform switch. Jest resolves `./platform` with the iOS extension
 * (jest-expo's default platform), so each case mocks it explicitly.
 */
import type { ActivitySource } from '@core/import/sources';

const source = { id: 'apple-health' } as ActivitySource;

function load(platform: unknown) {
  jest.resetModules();
  jest.doMock('./platform', () => ({ healthPlatform: platform }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./index') as typeof import('./index');
}

describe('@lib/health', () => {
  it('is inert without a platform store', async () => {
    const h = load(null);
    expect(h.healthSource()).toBeNull();
    await expect(h.healthAvailability()).resolves.toBe('unavailable');
    await expect(h.requestHealthPermissions()).resolves.toBe('denied');
    expect(h.canOpenHealthInstall()).toBe(false);
    await expect(h.openHealthInstall()).resolves.toBeUndefined();
  });

  it('delegates to the platform store', async () => {
    const openInstall = jest.fn(async () => undefined);
    const h = load({
      source,
      supported: () => true,
      availability: async () => 'needs-install',
      requestPermissions: async () => 'partial',
      openInstall,
    });
    expect(h.healthSource()).toBe(source);
    await expect(h.healthAvailability()).resolves.toBe('needs-install');
    await expect(h.requestHealthPermissions()).resolves.toBe('partial');
    expect(h.canOpenHealthInstall()).toBe(true);
    await h.openHealthInstall();
    expect(openInstall).toHaveBeenCalled();
  });

  it('hides the source on devices that can never have one', () => {
    const h = load({
      source,
      supported: () => false,
      availability: async () => 'unavailable',
      requestPermissions: async () => 'denied',
      openInstall: null,
    });
    expect(h.healthSource()).toBeNull();
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARINE_ENABLED, PARKED_LABEL, WEATHER_ENABLED } from './flags';

/**
 * The flags themselves have no logic, so what is worth testing is the
 * CONTRACT around them: the shipped state, and the promise that flipping one
 * constant is all it takes. The source-text assertions below are what make
 * the second half true — they fail if someone parks a feature by any other
 * means (an env lookup, a store read, a second copy of the flag).
 */
describe('feature flags', () => {
  const source = readFileSync(join(__dirname, 'flags.ts'), 'utf8');

  it('ships with weather and marine parked', () => {
    expect(WEATHER_ENABLED).toBe(false);
    expect(MARINE_ENABLED).toBe(false);
  });

  it('is a build-time constant, not runtime config', () => {
    // No env, no storage, no imports at all: un-parking must be a one-line
    // edit that a reviewer can see, not a deploy-time surprise.
    expect(source).not.toMatch(/\bprocess\.env\b/);
    expect(source).not.toMatch(/\bimport\b/);
    expect(source).toMatch(/export const WEATHER_ENABLED: boolean = (true|false);/);
    expect(source).toMatch(/export const MARINE_ENABLED: boolean = (true|false);/);
  });

  it('documents why each feature is parked and how to bring it back', () => {
    expect(source).toMatch(/PARKED/);
    expect(source).toMatch(/To un-park/);
  });

  it('exposes one shared label for the parked rows', () => {
    expect(PARKED_LABEL).toBe('Coming soon');
  });
});

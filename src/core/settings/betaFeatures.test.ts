import { BETA_FEATURES, BETA_FEATURES_NOTE, isBetaFeatureKey } from './betaFeatures';

describe('beta features registry', () => {
  it('lists 3D terrain first, with copy', () => {
    expect(BETA_FEATURES[0]?.key).toBe('betaTerrain3d');
    for (const f of BETA_FEATURES) {
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.description.length).toBeGreaterThan(0);
    }
    expect(BETA_FEATURES_NOTE).toMatch(/slower/);
  });

  it('has unique keys', () => {
    const keys = BETA_FEATURES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('recognises its keys only', () => {
    expect(isBetaFeatureKey('betaTerrain3d')).toBe(true);
    expect(isBetaFeatureKey('showParks')).toBe(false);
    expect(isBetaFeatureKey(undefined)).toBe(false);
  });
});

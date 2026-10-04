/**
 * Beta features — user-facing opt-ins for work that ships before it is
 * finished (Settings → Beta features). Unlike the build-time flags in
 * `@core/features/flags`, a beta is a persisted user setting: the owner ships
 * it OFF by default and the user may turn it on, accepting that it can be
 * unfinished or slower.
 *
 * To add a beta: add a boolean key (default `false`) to the settings store,
 * then one entry here. The Settings screen lists this registry in order.
 */

/** The settings keys that are beta toggles (each a boolean in the settings store). */
export type BetaFeatureKey = 'betaTerrain3d';

export interface BetaFeature {
  key: BetaFeatureKey;
  title: string;
  description: string;
}

export const BETA_FEATURES: readonly BetaFeature[] = [
  {
    key: 'betaTerrain3d',
    title: '3D terrain',
    description: 'Tilt the map with two fingers to see real mountains, with the map draped on them',
  },
];

/** Subtitle of the Settings section. */
export const BETA_FEATURES_NOTE =
  'Early features you can try before they are finished. They may be incomplete, change, or make the map slower.';

/** True when `key` names a beta toggle. */
export function isBetaFeatureKey(key: unknown): key is BetaFeatureKey {
  return BETA_FEATURES.some((f) => f.key === key);
}

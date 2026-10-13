/**
 * The iOS entitlements the App Store provisioning profile grants. An
 * entitlement outside this list makes the store build fail to sign, but only
 * at release time on EAS (2.5.0, 2026-10-13: `aps-environment` added by
 * expo-notifications' plugin). CI compares the final prebuild entitlements
 * with this list so that surfaces in the PR that adds it.
 *
 * Adding one: enable the capability on the App ID in the Apple Developer
 * portal first, let EAS regenerate the profile, then add it here.
 */
export const ALLOWED_ENTITLEMENTS = ['com.apple.developer.healthkit'];

/**
 * @param {Record<string, unknown>} entitlements the introspected ios.entitlements
 * @param {readonly string[]} allowed
 * @returns {string[]} entitlement keys the profile does not grant
 */
export function unexpectedEntitlements(entitlements, allowed = ALLOWED_ENTITLEMENTS) {
  return Object.keys(entitlements ?? {})
    .filter((key) => !allowed.includes(key))
    .sort();
}

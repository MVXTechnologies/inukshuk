// @ts-check
const { withEntitlementsPlist } = require('@expo/config-plugins');

/**
 * Keep `aps-environment` (Push Notifications) out of the iOS entitlements.
 *
 * Team mode (#589) shows LOCAL notifications only (src/data/team/
 * teamNotifications.ts): no push server, no device token. expo-notifications'
 * config plugin is applied by prebuild even though app.config.ts does not
 * list it, and it adds `aps-environment`. The App Store provisioning profile
 * has no Push capability, so the 2.5.0 iOS store build failed to sign
 * (EAS, 2026-10-13: "doesn't include the aps-environment entitlement").
 * Local notifications need no entitlement, so the right fix is to not ask
 * for push at all.
 *
 * Applied last in app.config.ts. scripts/ci/ios-entitlements.mjs checks the
 * final entitlements against an allowlist in CI.
 */

/**
 * @param {Record<string, unknown>} entitlements
 * @returns {Record<string, unknown>}
 */
function removePushEntitlement(entitlements) {
  delete entitlements['aps-environment'];
  return entitlements;
}

/** @type {import('@expo/config-plugins').ConfigPlugin} */
const withoutPushEntitlement = (config) =>
  withEntitlementsPlist(config, (c) => {
    c.modResults = /** @type {any} */ (removePushEntitlement(c.modResults));
    return c;
  });

module.exports = withoutPushEntitlement;
module.exports.removePushEntitlement = removePushEntitlement;

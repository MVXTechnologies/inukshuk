// @ts-check
const { AndroidConfig, withInfoPlist } = require('@expo/config-plugins');

/**
 * Team mesh (#589, modules/inukshuk-mesh): what the LAN / hotspot transport
 * needs declared in the native projects.
 *
 * iOS
 * - NSLocalNetworkUsageDescription: the Local Network privacy prompt. iOS
 *   shows it the first time the app browses, advertises or connects to a LAN
 *   address — i.e. only when a team session starts, never at launch (the
 *   loopback PDF server is exempt).
 * - NSBonjourServices: since iOS 14 an app may only browse or advertise the
 *   Bonjour types it lists. Ours is `_inukshuk-team._tcp`.
 * - No entitlement: Bonjour through Network.framework does not need
 *   com.apple.developer.networking.multicast (that is for raw multicast
 *   sockets), so there is no App Store Connect capability to enable first.
 *
 * Android (the module's own manifest declares them too; listing them here
 * keeps them visible in the app config). All are normal permissions, granted
 * at install, no prompt:
 * - INTERNET, ACCESS_NETWORK_STATE (Wi-Fi network routing), ACCESS_WIFI_STATE,
 *   CHANGE_WIFI_MULTICAST_STATE (the multicast lock that keeps mDNS alive on
 *   Wi-Fi drivers that filter multicast in power save).
 * - VIBRATE: a team message routed as an alert (urgent, a mention) buzzes.
 * - NOT NEARBY_WIFI_DEVICES: only Wi-Fi Direct / Aware / LocalOnlyHotspot need
 *   it, and the MVP uses none of them.
 */

const SERVICE_TYPE = '_inukshuk-team._tcp';

const LOCAL_NETWORK_USAGE =
  'Inukshuk finds your team’s phones on the same Wi-Fi or hotspot so you can share positions, waypoints, trails and messages directly between phones, without any server.';

const ANDROID_PERMISSIONS = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.ACCESS_WIFI_STATE',
  'android.permission.CHANGE_WIFI_MULTICAST_STATE',
  // The team UI buzzes for urgent messages and mentions (#589 stage 3).
  'android.permission.VIBRATE',
];

/**
 * Adds the mesh's Info.plist keys, keeping any Bonjour types and purpose
 * string something else already declared.
 * @param {Record<string, any>} plist
 * @returns {Record<string, any>}
 */
function applyTeamMeshInfoPlist(plist) {
  const existing = Array.isArray(plist.NSBonjourServices) ? plist.NSBonjourServices : [];
  return {
    ...plist,
    NSLocalNetworkUsageDescription: plist.NSLocalNetworkUsageDescription || LOCAL_NETWORK_USAGE,
    NSBonjourServices: existing.includes(SERVICE_TYPE) ? existing : [...existing, SERVICE_TYPE],
  };
}

/** @type {import('@expo/config-plugins').ConfigPlugin} */
function withTeamMesh(config) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults = /** @type {any} */ (applyTeamMeshInfoPlist(cfg.modResults));
    return cfg;
  });
  return AndroidConfig.Permissions.withPermissions(config, ANDROID_PERMISSIONS);
}

module.exports = withTeamMesh;
module.exports.applyTeamMeshInfoPlist = applyTeamMeshInfoPlist;
module.exports.SERVICE_TYPE = SERVICE_TYPE;
module.exports.ANDROID_PERMISSIONS = ANDROID_PERMISSIONS;

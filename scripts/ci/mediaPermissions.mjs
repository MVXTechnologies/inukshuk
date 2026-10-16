/**
 * Security review R-RTC-5: WebRTC is used for data channels only, so the app
 * declares no microphone, audio-routing or screen-capture access. The camera
 * stays (notes photos, invite QR scanner) with Inukshuk's own purpose string.
 *
 * Checked on the final introspected config (every config plugin applied, as
 * `expo prebuild` would write it). Library AndroidManifests merge later, at
 * build time; plugins/withWebRtcDataOnly.js blocks those with
 * tools:node="remove" entries, which this also requires.
 */

/** Purpose strings the iOS binary must not declare. */
export const FORBIDDEN_IOS_KEYS = ['NSMicrophoneUsageDescription'];

/** Purpose strings that must be present and written by us (never a library default). */
export const OWNED_IOS_KEYS = ['NSCameraUsageDescription'];

/** Library config-plugin defaults: "Allow $(PRODUCT_NAME) to access your camera". */
const GENERIC = /^Allow \$\(PRODUCT_NAME\) to /;

/** Android permissions the final manifest must block (tools:node="remove"). */
export const BLOCKED_ANDROID_PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.CAPTURE_AUDIO_OUTPUT',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_CAMERA',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
];

/** react-native-webrtc's screen-sharing service, which must be removed. */
export const REMOVED_ANDROID_SERVICES = ['com.oney.WebRTCModule.MediaProjectionService'];

/**
 * @param {{ $?: Record<string, string> }[] | undefined} nodes
 * @param {string} name
 */
function entries(nodes, name) {
  return (nodes ?? []).filter((n) => n.$?.['android:name'] === name);
}

/**
 * @param {{ infoPlist?: Record<string, unknown>, manifest?: any }} introspected
 *   `ios.infoPlist` and `_internal.modResults.android.manifest` of
 *   `expo config --type introspect --json`
 * @returns {string[]} one line per violation; empty when R-RTC-5 holds
 */
export function mediaPermissionProblems({ infoPlist, manifest }) {
  /** @type {string[]} */
  const problems = [];
  const plist = infoPlist ?? {};
  for (const key of FORBIDDEN_IOS_KEYS) {
    if (key in plist) problems.push(`iOS declares ${key}`);
  }
  for (const key of OWNED_IOS_KEYS) {
    const v = plist[key];
    if (typeof v !== 'string' || v.trim() === '') problems.push(`iOS lacks ${key}`);
    else if (GENERIC.test(v)) problems.push(`iOS ${key} is a library default: "${v}"`);
  }

  const root = manifest?.manifest;
  if (!root) {
    problems.push('no Android manifest in the introspected config');
    return problems;
  }
  const perms = root['uses-permission'];
  for (const name of BLOCKED_ANDROID_PERMISSIONS) {
    const found = entries(perms, name);
    if (found.some((p) => p.$?.['tools:node'] !== 'remove')) {
      problems.push(`Android requests ${name}`);
    } else if (found.length === 0) {
      problems.push(`Android does not block ${name} (tools:node="remove")`);
    }
  }
  const services = root.application?.[0]?.service;
  for (const name of REMOVED_ANDROID_SERVICES) {
    const found = entries(services, name);
    if (found.length === 0 || found.some((s) => s.$?.['tools:node'] !== 'remove')) {
      problems.push(`Android does not remove the ${name} service`);
    }
  }
  return problems;
}

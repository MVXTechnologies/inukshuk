// @ts-check
const { withAndroidManifest, withInfoPlist, AndroidConfig } = require('@expo/config-plugins');

/**
 * Native configuration for the external GNSS receiver module
 * (modules/inukshuk-gnss, #588).
 *
 * Android:
 *  - BLUETOOTH_SCAN with usesPermissionFlags="neverForLocation" (API 31+).
 *    Valid because nothing derives a location from scan results: we only list
 *    receivers to connect to (the positions come from the receiver's own NMEA
 *    stream, which is not a scan result). With the flag, scanning needs no
 *    location permission; some beacons are filtered out, which is irrelevant.
 *  - BLUETOOTH_CONNECT (API 31+): connecting, bonded-device list, names.
 *  - BLUETOOTH / BLUETOOTH_ADMIN capped at maxSdkVersion 30: the legacy
 *    install-time pair (Android 8–11). A BLE scan there also needs
 *    ACCESS_FINE_LOCATION, which the app already declares for the map.
 *  - uses-feature bluetooth + bluetooth_le with required="false". Declaring
 *    BLUETOOTH implies a REQUIRED android.hardware.bluetooth feature, which
 *    would hide the app on Play from devices without Bluetooth; the receiver
 *    is an optional extension.
 *  - No foreground-service type: the link runs inside the process kept alive
 *    by expo-location's `location` foreground service while recording (see
 *    GnssSession.kt).
 *
 * iOS:
 *  - NSBluetoothAlwaysUsageDescription: the permission prompt's text.
 *  - UIBackgroundModes += bluetooth-central: receiver notifications keep
 *    arriving with the screen locked, and CoreBluetooth state restoration can
 *    relaunch the app to resume the link. Appended, never replacing the
 *    existing `location` mode.
 *  - No UISupportedExternalAccessoryProtocols: MFi receivers (External
 *    Accessory) need each vendor's approval and a PPID in every App Review
 *    submission; they are deliberately not in v1. Add protocol strings here
 *    only per approved vendor.
 *
 * Option `fakeDevice` (E2E builds only, via GNSS_FAKE_DEVICE=1 in
 * app.config.ts): enables the simulated receiver in a RELEASE build, through
 * a manifest meta-data flag / an Info.plist key. Debug builds always have it;
 * store builds never set the option, and the keys are removed when it is off
 * so a stale prebuild cannot carry them over.
 *
 * Option `iosBackgroundMode: false` leaves bluetooth-central out (default:
 * in). See the module README, "Store obligations".
 *
 * @typedef {{ fakeDevice?: boolean, bluetoothPermission?: string, iosBackgroundMode?: boolean }} GnssPluginProps
 */

const BLUETOOTH_PURPOSE =
  'Inukshuk connects over Bluetooth to an external GPS/GNSS receiver you choose, for more precise positions on the map and in your recorded tracks.';

const FAKE_META = 'app.inukshuk.gnss.FAKE_DEVICE';
const FAKE_PLIST = 'InukshukGnssFakeDevice';

/**
 * The manifest entries, in order. `attrs` are written verbatim, replacing
 * whatever another plugin may have put on the same permission.
 */
const ANDROID_PERMISSIONS = [
  {
    name: 'android.permission.BLUETOOTH_SCAN',
    attrs: { 'android:usesPermissionFlags': 'neverForLocation', 'tools:targetApi': 's' },
  },
  { name: 'android.permission.BLUETOOTH_CONNECT', attrs: {} },
  { name: 'android.permission.BLUETOOTH', attrs: { 'android:maxSdkVersion': '30' } },
  { name: 'android.permission.BLUETOOTH_ADMIN', attrs: { 'android:maxSdkVersion': '30' } },
];

const ANDROID_FEATURES = ['android.hardware.bluetooth', 'android.hardware.bluetooth_le'];

/**
 * @param {any} manifest  AndroidManifest.xml as parsed by @expo/config-plugins
 * @param {GnssPluginProps} props
 */
function applyAndroidManifest(manifest, props) {
  const root = manifest.manifest;
  root.$ = root.$ ?? {};
  // tools:targetApi needs the tools namespace (the Expo template has it).
  root.$['xmlns:tools'] = root.$['xmlns:tools'] ?? 'http://schemas.android.com/tools';

  // One entry per Bluetooth permission, carrying exactly our attributes.
  const ours = new Set(ANDROID_PERMISSIONS.map((p) => p.name));
  const others = (root['uses-permission'] ?? []).filter(
    (/** @type {any} */ p) => !ours.has(p.$?.['android:name']),
  );
  root['uses-permission'] = [
    ...others,
    ...ANDROID_PERMISSIONS.map(({ name, attrs }) => ({ $: { 'android:name': name, ...attrs } })),
  ];

  const features = (root['uses-feature'] = root['uses-feature'] ?? []);
  for (const name of ANDROID_FEATURES) {
    const found = features.find((/** @type {any} */ f) => f.$?.['android:name'] === name);
    if (found) {
      found.$['android:required'] = 'false';
    } else {
      features.push({ $: { 'android:name': name, 'android:required': 'false' } });
    }
  }

  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  if (props.fakeDevice) {
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, FAKE_META, 'true');
  } else {
    AndroidConfig.Manifest.removeMetaDataItemFromMainApplication(app, FAKE_META);
  }
  return manifest;
}

/**
 * @param {Record<string, any>} plist
 * @param {GnssPluginProps} props
 */
function applyInfoPlist(plist, props) {
  plist.NSBluetoothAlwaysUsageDescription = props.bluetoothPermission ?? BLUETOOTH_PURPOSE;
  const modes = Array.isArray(plist.UIBackgroundModes) ? plist.UIBackgroundModes : [];
  if (props.iosBackgroundMode === false) {
    // Escape hatch for a release whose UI does not use the receiver yet
    // (App Review 2.5.4 questions unused modes). GnssLink.swift then skips
    // state restoration, which would otherwise raise.
    plist.UIBackgroundModes = modes.filter((m) => m !== 'bluetooth-central');
  } else {
    if (!modes.includes('bluetooth-central')) modes.push('bluetooth-central');
    plist.UIBackgroundModes = modes;
  }
  if (props.fakeDevice) {
    plist[FAKE_PLIST] = true;
  } else {
    delete plist[FAKE_PLIST];
  }
  return plist;
}

/** @type {import('@expo/config-plugins').ConfigPlugin<GnssPluginProps | void>} */
const withGnss = (config, props) => {
  const p = props ?? {};
  config = withAndroidManifest(config, (cfg) => {
    cfg.modResults = applyAndroidManifest(cfg.modResults, p);
    return cfg;
  });
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults = applyInfoPlist(cfg.modResults, p);
    return cfg;
  });
  return config;
};

module.exports = withGnss;
module.exports.applyAndroidManifest = applyAndroidManifest;
module.exports.applyInfoPlist = applyInfoPlist;
module.exports.BLUETOOTH_PURPOSE = BLUETOOTH_PURPOSE;

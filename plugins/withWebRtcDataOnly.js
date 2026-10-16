// @ts-check
/**
 * react-native-webrtc for data channels only: no camera, microphone or screen
 * capture in the binary (security review R-RTC-5), and the native WebRTC
 * builds pinned exactly (2.7.0 live sync, G4).
 *
 * Inukshuk uses WebRTC for one ordered, reliable data channel per peer
 * (team sync over the internet). It never captures media. But:
 *
 * - `@config-plugins/react-native-webrtc` (which we do NOT use) adds
 *   NSCameraUsageDescription / NSMicrophoneUsageDescription with generic
 *   "Allow $(PRODUCT_NAME) to access your …" strings and CAMERA, RECORD_AUDIO,
 *   MODIFY_AUDIO_SETTINGS, SYSTEM_ALERT_WINDOW, WAKE_LOCK, BLUETOOTH on Android.
 * - expo-image-picker adds the same generic microphone string and RECORD_AUDIO
 *   unless `microphonePermission: false` (app.config.ts sets it: photos only).
 * - react-native-webrtc's own AndroidManifest declares a MediaProjectionService
 *   (foregroundServiceType="mediaProjection") for screen sharing.
 * - react-native-webrtc depends on `org.jitsi:webrtc:<major>.+` (Gradle) and
 *   `JitsiWebRTC ~> <major>.0.0` (CocoaPods): the native WebRTC build floats.
 *
 * At prebuild this plugin:
 * 1. iOS: deletes NSMicrophoneUsageDescription, and refuses a generic library
 *    camera string (the camera stays: notes photos and the invite QR scanner
 *    own it, with Inukshuk's own text from expo-image-picker's options);
 * 2. Android: blocks (tools:node="remove") the microphone, audio-routing,
 *    overlay and media-projection permissions, whichever library adds them,
 *    and removes react-native-webrtc's MediaProjectionService;
 * 3. pins org.jitsi:webrtc and the JitsiWebRTC pod to JITSI_WEBRTC, and
 *    refuses to run if the installed react-native-webrtc is another major.
 *
 * CAMERA stays on Android for the same reason as on iOS (expo-camera's
 * library manifest declares it). scripts/ci/media-permissions.mjs checks the
 * final introspected config in CI.
 *
 * Order: Expo runs mods last-registered first, so a plugin listed BEFORE this
 * one in app.config.ts edits Info.plist / the manifest AFTER a plain
 * withInfoPlist here would (expo-image-picker re-adding the microphone string,
 * for one). The Info.plist and manifest edits therefore run post-order
 * (withFinalSay): they call the rest of the chain first and edit its result,
 * so they have the last word wherever the plugin sits in the list.
 */
const {
  AndroidConfig,
  withAppBuildGradle,
  withBaseMod,
  withPodfile,
} = require('@expo/config-plugins');

/** The native WebRTC build react-native-webrtc@155.0.0 resolves to today (Maven Central + CocoaPods trunk). */
const JITSI_WEBRTC = '155.0.0';

/** iOS purpose strings a data-only WebRTC app must not declare. */
const IOS_REMOVED_KEYS = ['NSMicrophoneUsageDescription'];

/** Generic defaults that library config plugins write; the app must never ship one. */
const GENERIC_PURPOSE = /^Allow \$\(PRODUCT_NAME\) to access your /;

/** Android permissions blocked in the final manifest, whichever library declares them. */
const ANDROID_BLOCKED_PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.CAPTURE_AUDIO_OUTPUT',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_CAMERA',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
];

/** react-native-webrtc's screen-sharing service (android/src/main/AndroidManifest.xml). */
const MEDIA_PROJECTION_SERVICE = 'com.oney.WebRTCModule.MediaProjectionService';

const TAG = 'inukshuk-webrtc-pin';
const GRADLE_BEGIN = `// @generated begin ${TAG} - plugins/withWebRtcDataOnly.js`;
const GRADLE_END = `// @generated end ${TAG}`;
const POD_BEGIN = `  # @generated begin ${TAG} - plugins/withWebRtcDataOnly.js`;
const POD_END = `  # @generated end ${TAG}`;

/**
 * @param {Record<string, unknown>} infoPlist
 * @returns {Record<string, unknown>}
 */
function stripMediaPurposeStrings(infoPlist) {
  for (const key of IOS_REMOVED_KEYS) delete infoPlist[key];
  const camera = infoPlist.NSCameraUsageDescription;
  if (typeof camera === 'string' && GENERIC_PURPOSE.test(camera)) {
    throw new Error(
      'withWebRtcDataOnly: NSCameraUsageDescription is a library default ' +
        `("${camera}"). Inukshuk's camera string comes from expo-image-picker's ` +
        '`cameraPermission` in app.config.ts; a generic one means a plugin (for example ' +
        '@config-plugins/react-native-webrtc) overrode it. App Review rejects vague purpose strings.',
    );
  }
  return infoPlist;
}

/**
 * Removes react-native-webrtc's MediaProjectionService from the merged manifest.
 * @param {import('@expo/config-plugins').AndroidConfig.Manifest.AndroidManifest} manifest
 */
function removeMediaProjectionService(manifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  const services = (app.service ?? []).filter(
    (s) => s.$['android:name'] !== MEDIA_PROJECTION_SERVICE,
  );
  services.push(
    /** @type {any} */ ({
      $: { 'android:name': MEDIA_PROJECTION_SERVICE, 'tools:node': 'remove' },
    }),
  );
  app.service = services;
  return manifest;
}

/**
 * Replaces an existing generated block (markers included), or returns null if there is none.
 * @param {string} contents
 * @param {string} begin
 * @param {string} end
 * @param {string} block
 * @returns {string | null}
 */
function replaceBlock(contents, begin, end, block) {
  const start = contents.indexOf(begin);
  if (start === -1) return null;
  const stop = contents.indexOf(end, start);
  if (stop === -1) throw new Error(`withWebRtcDataOnly: "${begin}" has no end marker`);
  return contents.slice(0, start) + block + contents.slice(stop + end.length);
}

/**
 * Forces org.jitsi:webrtc to JITSI_WEBRTC (react-native-webrtc asks for `<major>.+`).
 * Idempotent.
 * @param {string} gradle  android/app/build.gradle
 * @param {string} [version]
 */
function pinJitsiAndroid(gradle, version = JITSI_WEBRTC) {
  const block = [
    GRADLE_BEGIN,
    'configurations.configureEach {',
    `    resolutionStrategy.force 'org.jitsi:webrtc:${version}'`,
    '}',
    GRADLE_END,
  ].join('\n');
  const replaced = replaceBlock(gradle, GRADLE_BEGIN, GRADLE_END, block);
  if (replaced !== null) return replaced;
  return `${gradle.replace(/\s*$/, '')}\n\n${block}\n`;
}

/**
 * Pins the JitsiWebRTC pod to JITSI_WEBRTC (react-native-webrtc asks for `~> <major>.0.0`)
 * inside the app target, right after `use_expo_modules!`. Idempotent.
 * @param {string} podfile
 * @param {string} [version]
 */
function pinJitsiPod(podfile, version = JITSI_WEBRTC) {
  const block = [POD_BEGIN, `  pod 'JitsiWebRTC', '${version}'`, POD_END].join('\n');
  const replaced = replaceBlock(podfile, POD_BEGIN, POD_END, block);
  if (replaced !== null) return replaced;
  const anchor = /^(\s*use_expo_modules!.*)$/m;
  if (!anchor.test(podfile)) {
    throw new Error(
      'withWebRtcDataOnly: no `use_expo_modules!` line in the Podfile to pin JitsiWebRTC after',
    );
  }
  return podfile.replace(anchor, `$1\n${block}`);
}

/**
 * Refuses a react-native-webrtc whose WebRTC major is not the pinned one: the
 * pin must move with the library (its version is the WebRTC milestone).
 * @param {string | undefined} installed  react-native-webrtc's package.json version
 * @param {string} [pinned]
 */
function assertSameMajor(installed, pinned = JITSI_WEBRTC) {
  const major = (/** @type {string | undefined} */ v) => v?.split('.')[0];
  if (!installed || major(installed) !== major(pinned)) {
    throw new Error(
      `withWebRtcDataOnly: react-native-webrtc ${installed ?? '(not installed)'} does not ` +
        `match the pinned native WebRTC ${pinned}. Update JITSI_WEBRTC to the Jitsi build ` +
        "that release's podspec and build.gradle ask for.",
    );
  }
}

/** @param {string} projectRoot */
function installedWebRtcVersion(projectRoot) {
  try {
    const pkg = require.resolve('react-native-webrtc/package.json', { paths: [projectRoot] });
    return /** @type {{ version?: string }} */ (require(pkg)).version;
  } catch {
    return undefined;
  }
}

/**
 * Like withInfoPlist / withAndroidManifest, but `edit` runs AFTER every mod
 * registered before this one (the rest of the chain runs first), so no plugin
 * listed earlier in app.config.ts can undo it.
 * @param {import('@expo/config-plugins').ExportedConfig} config
 * @param {'ios' | 'android'} platform
 * @param {string} mod
 * @param {(modResults: any) => any} edit
 */
function withFinalSay(config, platform, mod, edit) {
  return withBaseMod(config, {
    platform,
    mod,
    isProvider: false,
    async action({ modRequest: { nextMod, ...modRequest }, ...rest }) {
      if (!nextMod) throw new Error(`withWebRtcDataOnly: no ${platform}.${mod} chain to wrap`);
      const results = await nextMod({ ...rest, modRequest });
      results.modResults = edit(results.modResults);
      return results;
    },
  });
}

/**
 * @param {import('@expo/config-plugins').AndroidConfig.Manifest.AndroidManifest} manifest
 */
function blockMediaInManifest(manifest) {
  const withTools = AndroidConfig.Manifest.ensureToolsAvailable(manifest);
  return removeMediaProjectionService(
    AndroidConfig.Permissions.addBlockedPermissions(withTools, ANDROID_BLOCKED_PERMISSIONS),
  );
}

/** @type {import('@expo/config-plugins').ConfigPlugin} */
const withWebRtcDataOnly = (config) => {
  // Static `android.permissions` too, so nothing re-adds them before the manifest mod.
  if (Array.isArray(config.android?.permissions)) {
    config.android.permissions = config.android.permissions.filter(
      (p) => !ANDROID_BLOCKED_PERMISSIONS.includes(p.includes('.') ? p : `android.permission.${p}`),
    );
  }
  config = withFinalSay(config, 'ios', 'infoPlist', stripMediaPurposeStrings);
  config = withFinalSay(config, 'android', 'manifest', blockMediaInManifest);
  config = withAppBuildGradle(config, (c) => {
    assertSameMajor(installedWebRtcVersion(c.modRequest.projectRoot));
    c.modResults.contents = pinJitsiAndroid(c.modResults.contents);
    return c;
  });
  config = withPodfile(config, (c) => {
    assertSameMajor(installedWebRtcVersion(c.modRequest.projectRoot));
    c.modResults.contents = pinJitsiPod(c.modResults.contents);
    return c;
  });
  return config;
};

module.exports = withWebRtcDataOnly;
module.exports.JITSI_WEBRTC = JITSI_WEBRTC;
module.exports.IOS_REMOVED_KEYS = IOS_REMOVED_KEYS;
module.exports.ANDROID_BLOCKED_PERMISSIONS = ANDROID_BLOCKED_PERMISSIONS;
module.exports.MEDIA_PROJECTION_SERVICE = MEDIA_PROJECTION_SERVICE;
module.exports.GENERIC_PURPOSE = GENERIC_PURPOSE;
module.exports.stripMediaPurposeStrings = stripMediaPurposeStrings;
module.exports.removeMediaProjectionService = removeMediaProjectionService;
module.exports.blockMediaInManifest = blockMediaInManifest;
module.exports.pinJitsiAndroid = pinJitsiAndroid;
module.exports.pinJitsiPod = pinJitsiPod;
module.exports.assertSameMajor = assertSameMajor;

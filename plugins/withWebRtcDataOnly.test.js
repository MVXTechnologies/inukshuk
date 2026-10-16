/**
 * @jest-environment node
 */
const { describe, expect, it } = require('@jest/globals');
const { AndroidConfig, IOSConfig, compileModsAsync } = require('@expo/config-plugins');
const path = require('path');

const withImagePickerModule = require('expo-image-picker/app.plugin');
const withWebRtcDataOnly = require('./withWebRtcDataOnly');

const withImagePicker = withImagePickerModule.default ?? withImagePickerModule;

/** No ios/ or android/ here, so introspection reads the SDK templates and writes nothing. */
const PROJECT_ROOT = path.resolve('plugins');
const {
  ANDROID_BLOCKED_PERMISSIONS,
  JITSI_WEBRTC,
  MEDIA_PROJECTION_SERVICE,
  assertSameMajor,
  pinJitsiAndroid,
  pinJitsiPod,
  removeMediaProjectionService,
  stripMediaPurposeStrings,
} = withWebRtcDataOnly;

const CAMERA =
  'Inukshuk uses the camera to attach photos to trail notes and to scan team invite QR codes.';

/**
 * What @config-plugins/react-native-webrtc@15.0.2 (build/withWebRTC.js,
 * build/withPermissions.js) does, reproduced so the test needs no install:
 * generic camera + microphone strings unless already set, and these Android
 * permissions. We do not use that plugin; this proves ours undoes it anyway.
 */
const withUpstreamWebRtcPlugin = (config) => {
  config = IOSConfig.Permissions.createPermissionsPlugin({
    NSCameraUsageDescription: 'Allow $(PRODUCT_NAME) to access your camera',
    NSMicrophoneUsageDescription: 'Allow $(PRODUCT_NAME) to access your microphone',
  })(config, {});
  return AndroidConfig.Permissions.withPermissions(config, [
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.CAMERA',
    'android.permission.INTERNET',
    'android.permission.MODIFY_AUDIO_SETTINGS',
    'android.permission.RECORD_AUDIO',
    'android.permission.SYSTEM_ALERT_WINDOW',
    'android.permission.WAKE_LOCK',
    'android.permission.BLUETOOTH',
  ]);
};

/** A sample config shaped like app.config.ts (the image-picker options are the app's). */
function sampleConfig() {
  return {
    name: 'Inukshuk',
    slug: 'inukshuk',
    ios: { bundleIdentifier: 'com.inukshuk.app' },
    android: { package: 'com.inukshuk.app' },
    _internal: { projectRoot: PROJECT_ROOT },
  };
}

/**
 * Runs the mods as `expo config --type introspect` does (no native project is
 * read or written: the SDK templates stand in), and returns the final iOS
 * Info.plist and Android manifest.
 */
async function introspect(config) {
  const out = await compileModsAsync(config, {
    projectRoot: PROJECT_ROOT,
    platforms: ['ios', 'android'],
    introspect: true,
  });
  const manifest = out._internal.modResults.android.manifest;
  return { infoPlist: out.ios.infoPlist, manifest };
}

/** @returns {{ name: string; remove: boolean }[]} */
function permissions(manifest) {
  return (manifest.manifest['uses-permission'] ?? []).map((p) => ({
    name: p.$['android:name'],
    remove: p.$['tools:node'] === 'remove',
  }));
}

/** Permissions the final manifest grants (declared, and not blocked). */
function granted(manifest) {
  const all = permissions(manifest);
  const blocked = new Set(all.filter((p) => p.remove).map((p) => p.name));
  return all.filter((p) => !p.remove && !blocked.has(p.name)).map((p) => p.name);
}

describe('withWebRtcDataOnly on a sample config', () => {
  it('leaves no microphone and keeps our camera string, after image-picker and the upstream WebRTC plugin', async () => {
    let config = sampleConfig();
    config = withImagePicker(config, {
      photosPermission: 'Inukshuk lets you attach photos from your library to trail notes.',
      cameraPermission: CAMERA,
      microphonePermission: false,
    });
    config = withUpstreamWebRtcPlugin(config);
    config = withWebRtcDataOnly(config);

    const { infoPlist, manifest } = await introspect(config);

    expect(infoPlist.NSMicrophoneUsageDescription).toBeUndefined();
    expect(infoPlist.NSCameraUsageDescription).toBe(CAMERA);
    const grantedPerms = granted(manifest);
    for (const p of ANDROID_BLOCKED_PERMISSIONS) expect(grantedPerms).not.toContain(p);
    expect(grantedPerms).toEqual(
      expect.arrayContaining([
        'android.permission.INTERNET',
        'android.permission.ACCESS_NETWORK_STATE',
        'android.permission.CAMERA',
      ]),
    );
    // Library manifests merge later: the blocks must be explicit tools:node="remove".
    const blocked = permissions(manifest)
      .filter((p) => p.remove)
      .map((p) => p.name);
    expect(blocked).toEqual(expect.arrayContaining(ANDROID_BLOCKED_PERMISSIONS));
    expect(manifest.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');
    const services = manifest.manifest.application?.[0]?.service ?? [];
    expect(services).toContainEqual({
      $: { 'android:name': MEDIA_PROJECTION_SERVICE, 'tools:node': 'remove' },
    });
  });

  it('strips the microphone string even when image-picker still asks for one', async () => {
    let config = sampleConfig();
    config = withImagePicker(config, { cameraPermission: CAMERA });
    config = withWebRtcDataOnly(config);
    const { infoPlist, manifest } = await introspect(config);
    expect(infoPlist.NSMicrophoneUsageDescription).toBeUndefined();
    expect(granted(manifest)).not.toContain('android.permission.RECORD_AUDIO');
  });

  it('has the last word wherever it sits in the plugin list', async () => {
    // Listed FIRST: every other plugin's Info.plist / manifest edit is registered later.
    let config = withWebRtcDataOnly(sampleConfig());
    config = withImagePicker(config, { cameraPermission: CAMERA });
    config = withUpstreamWebRtcPlugin(config);
    const { infoPlist, manifest } = await introspect(config);
    expect(infoPlist.NSMicrophoneUsageDescription).toBeUndefined();
    expect(infoPlist.NSCameraUsageDescription).toBe(CAMERA);
    const grantedPerms = granted(manifest);
    for (const p of ANDROID_BLOCKED_PERMISSIONS) expect(grantedPerms).not.toContain(p);
  });

  it('keeps blocked permissions out of the static android.permissions list', () => {
    const config = withWebRtcDataOnly({
      ...sampleConfig(),
      android: { package: 'a.b', permissions: ['RECORD_AUDIO', 'android.permission.CAMERA'] },
    });
    expect(config.android.permissions).toEqual(['android.permission.CAMERA']);
  });

  it('refuses a generic library camera string (no app-owned camera text)', async () => {
    let config = sampleConfig();
    config = withUpstreamWebRtcPlugin(config);
    config = withWebRtcDataOnly(config);
    await expect(introspect(config)).rejects.toThrow(
      /NSCameraUsageDescription is a library default/,
    );
  });

  it('registers the Podfile and app build.gradle pins (prebuild-only mods)', () => {
    const config = withWebRtcDataOnly(sampleConfig());
    expect(config.mods?.ios?.podfile).toBeDefined();
    expect(config.mods?.android?.appBuildGradle).toBeDefined();
  });
});

describe('stripMediaPurposeStrings', () => {
  it('deletes the microphone string and keeps everything else', () => {
    expect(
      stripMediaPurposeStrings({
        NSMicrophoneUsageDescription: 'x',
        NSCameraUsageDescription: CAMERA,
        NSLocalNetworkUsageDescription: 'team',
      }),
    ).toEqual({ NSCameraUsageDescription: CAMERA, NSLocalNetworkUsageDescription: 'team' });
  });

  it('accepts an Info.plist without a camera string', () => {
    expect(stripMediaPurposeStrings({})).toEqual({});
  });
});

describe('removeMediaProjectionService', () => {
  it('replaces a declared service with a tools:node="remove" entry, keeping others', () => {
    const manifest = {
      manifest: {
        $: {},
        application: [
          {
            $: { 'android:name': '.MainApplication' },
            service: [
              { $: { 'android:name': MEDIA_PROJECTION_SERVICE } },
              { $: { 'android:name': 'expo.modules.location.services.LocationTaskService' } },
            ],
          },
        ],
      },
    };
    const services = removeMediaProjectionService(manifest).manifest.application[0].service;
    expect(services).toEqual([
      { $: { 'android:name': 'expo.modules.location.services.LocationTaskService' } },
      { $: { 'android:name': MEDIA_PROJECTION_SERVICE, 'tools:node': 'remove' } },
    ]);
  });
});

describe('native WebRTC pins', () => {
  const GRADLE = "apply plugin: 'com.android.application'\n\ndependencies {\n}\n";
  const PODFILE = [
    "target 'Inukshuk' do",
    '  use_expo_modules!',
    '  config = use_native_modules!(config_command)',
    'end',
    '',
  ].join('\n');

  it('forces org.jitsi:webrtc once, idempotently', () => {
    const once = pinJitsiAndroid(GRADLE);
    expect(once).toContain(`resolutionStrategy.force 'org.jitsi:webrtc:${JITSI_WEBRTC}'`);
    expect(pinJitsiAndroid(once)).toBe(once);
    expect(pinJitsiAndroid(once, '156.0.0')).toContain("'org.jitsi:webrtc:156.0.0'");
    expect(pinJitsiAndroid(once, '156.0.0')).not.toContain(JITSI_WEBRTC);
  });

  it('pins the JitsiWebRTC pod inside the app target, idempotently', () => {
    const once = pinJitsiPod(PODFILE);
    const lines = once.split('\n');
    expect(lines.indexOf(`  pod 'JitsiWebRTC', '${JITSI_WEBRTC}'`)).toBe(
      lines.indexOf('  use_expo_modules!') + 2,
    );
    expect(pinJitsiPod(once)).toBe(once);
  });

  it('refuses a Podfile without use_expo_modules! or with a broken block', () => {
    expect(() => pinJitsiPod("target 'X' do\nend\n")).toThrow(/use_expo_modules!/);
    expect(() =>
      pinJitsiPod('  # @generated begin inukshuk-webrtc-pin - plugins/withWebRtcDataOnly.js\n'),
    ).toThrow(/no end marker/);
  });

  it('matches the react-native-webrtc version pinned in package.json', () => {
    const pkg = require('../package.json');
    const pinned = pkg.dependencies['react-native-webrtc'];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/); // exact, no range
    expect(() => assertSameMajor(pinned)).not.toThrow();
  });

  it('refuses another WebRTC major, or no react-native-webrtc at all', () => {
    expect(() => assertSameMajor('124.0.8')).toThrow(/does not match/);
    expect(() => assertSameMajor(undefined)).toThrow(/not installed/);
  });
});

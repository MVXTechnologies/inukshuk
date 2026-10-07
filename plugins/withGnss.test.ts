import { applyAndroidManifest, applyInfoPlist, BLUETOOTH_PURPOSE } from './withGnss';

type Attrs = Record<string, string>;
interface Manifest {
  manifest: {
    $: Attrs;
    'uses-permission'?: { $: Attrs }[];
    'uses-feature'?: { $: Attrs }[];
    application: { $: Attrs; 'meta-data'?: { $: Attrs }[] }[];
  };
}

function baseManifest(): Manifest {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      'uses-permission': [
        { $: { 'android:name': 'android.permission.ACCESS_FINE_LOCATION' } },
        // As another library might declare it: no flags.
        { $: { 'android:name': 'android.permission.BLUETOOTH_SCAN' } },
      ],
      'uses-feature': [
        { $: { 'android:name': 'android.hardware.bluetooth', 'android:required': 'true' } },
      ],
      application: [{ $: { 'android:name': '.MainApplication' } }],
    },
  };
}

function perm(m: Manifest, name: string): Attrs[] {
  return (m.manifest['uses-permission'] ?? [])
    .filter((p) => p.$['android:name'] === `android.permission.${name}`)
    .map((p) => p.$);
}

describe('withGnss — Android manifest', () => {
  it('declares the Android 12+ Bluetooth permissions, scan without location', () => {
    const m = applyAndroidManifest(baseManifest(), {}) as Manifest;
    expect(perm(m, 'BLUETOOTH_SCAN')).toEqual([
      {
        'android:name': 'android.permission.BLUETOOTH_SCAN',
        'android:usesPermissionFlags': 'neverForLocation',
        'tools:targetApi': 's',
      },
    ]);
    expect(perm(m, 'BLUETOOTH_CONNECT')).toEqual([
      { 'android:name': 'android.permission.BLUETOOTH_CONNECT' },
    ]);
    expect(m.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');
  });

  it('caps the legacy permissions at Android 11 and keeps unrelated ones', () => {
    const m = applyAndroidManifest(baseManifest(), {}) as Manifest;
    expect(perm(m, 'BLUETOOTH')[0]?.['android:maxSdkVersion']).toBe('30');
    expect(perm(m, 'BLUETOOTH_ADMIN')[0]?.['android:maxSdkVersion']).toBe('30');
    expect(perm(m, 'ACCESS_FINE_LOCATION')).toHaveLength(1);
  });

  it('marks Bluetooth hardware optional so Play does not filter devices', () => {
    const m = applyAndroidManifest(baseManifest(), {}) as Manifest;
    const features = (m.manifest['uses-feature'] ?? []).map((f) => f.$);
    expect(features).toEqual([
      { 'android:name': 'android.hardware.bluetooth', 'android:required': 'false' },
      { 'android:name': 'android.hardware.bluetooth_le', 'android:required': 'false' },
    ]);
  });

  it('is idempotent (prebuild run twice)', () => {
    const once = applyAndroidManifest(baseManifest(), {}) as Manifest;
    const twice = applyAndroidManifest(JSON.parse(JSON.stringify(once)), {}) as Manifest;
    expect(twice).toEqual(once);
  });

  it('adds the simulated-receiver flag only when asked, and removes it otherwise', () => {
    const on = applyAndroidManifest(baseManifest(), { fakeDevice: true }) as Manifest;
    const meta = () => on.manifest.application[0]?.['meta-data'] ?? [];
    expect(meta()).toEqual([
      { $: { 'android:name': 'app.inukshuk.gnss.FAKE_DEVICE', 'android:value': 'true' } },
    ]);
    applyAndroidManifest(on, {});
    expect(meta()).toEqual([]);
  });
});

describe('withGnss — iOS Info.plist', () => {
  it('adds the purpose string and bluetooth-central next to location', () => {
    const plist = applyInfoPlist({ UIBackgroundModes: ['location'] }, {});
    expect(plist.NSBluetoothAlwaysUsageDescription).toBe(BLUETOOTH_PURPOSE);
    expect(plist.UIBackgroundModes).toEqual(['location', 'bluetooth-central']);
    expect(plist.InukshukGnssFakeDevice).toBeUndefined();
  });

  it('is idempotent and creates the modes array when missing', () => {
    const plist = applyInfoPlist(applyInfoPlist({}, {}), {});
    expect(plist.UIBackgroundModes).toEqual(['bluetooth-central']);
  });

  it('never declares External Accessory protocols (MFi is not in v1)', () => {
    const plist = applyInfoPlist({}, { fakeDevice: true });
    expect(plist.UISupportedExternalAccessoryProtocols).toBeUndefined();
    expect(plist.UIBackgroundModes).not.toContain('external-accessory');
  });

  it('can leave the Bluetooth background mode out', () => {
    const plist = applyInfoPlist(
      { UIBackgroundModes: ['location', 'bluetooth-central'] },
      {
        iosBackgroundMode: false,
      },
    );
    expect(plist.UIBackgroundModes).toEqual(['location']);
  });

  it('toggles the simulated-receiver key', () => {
    const plist = applyInfoPlist({}, { fakeDevice: true });
    expect(plist.InukshukGnssFakeDevice).toBe(true);
    expect(applyInfoPlist(plist, {}).InukshukGnssFakeDevice).toBeUndefined();
  });

  it('explains the purpose in user terms', () => {
    expect(BLUETOOTH_PURPOSE).toMatch(/receiver/);
    expect(BLUETOOTH_PURPOSE.length).toBeLessThan(200);
  });
});

const { describe, expect, it } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

const withIosSceneLifecycle = require('./withIosSceneLifecycle');
const withTeamMesh = require('./withTeamMesh');

const { applyTeamMeshInfoPlist, SERVICE_TYPE, ANDROID_PERMISSIONS } = withTeamMesh;

describe('withTeamMesh', () => {
  it('declares the Bonjour type and the Local Network purpose string', () => {
    const plist = applyTeamMeshInfoPlist({ CFBundleName: 'Inukshuk' });
    expect(plist.NSBonjourServices).toEqual(['_inukshuk-team._tcp']);
    expect(plist.NSLocalNetworkUsageDescription).toMatch(/team/);
    expect(plist.CFBundleName).toBe('Inukshuk');
  });

  it('keeps other Bonjour types and an existing purpose string, without duplicates', () => {
    const plist = applyTeamMeshInfoPlist({
      NSBonjourServices: ['_other._tcp', SERVICE_TYPE],
      NSLocalNetworkUsageDescription: 'Custom',
    });
    expect(plist.NSBonjourServices).toEqual(['_other._tcp', SERVICE_TYPE]);
    expect(plist.NSLocalNetworkUsageDescription).toBe('Custom');
  });

  it('matches the native service type (a DNS-SD name of at most 15 characters)', () => {
    expect(SERVICE_TYPE).toBe('_inukshuk-team._tcp');
    expect('inukshuk-team'.length).toBeLessThanOrEqual(15);
  });

  it('asks for normal Android permissions only', () => {
    expect(ANDROID_PERMISSIONS).not.toContain('android.permission.NEARBY_WIFI_DEVICES');
    expect(ANDROID_PERMISSIONS).toContain('android.permission.CHANGE_WIFI_MULTICAST_STATE');
    expect(ANDROID_PERMISSIONS).toContain('android.permission.VIBRATE');
  });

  it('adds the iOS and Android mods to an Expo config', () => {
    const config = withTeamMesh({ name: 'Inukshuk', slug: 'inukshuk' });
    expect(config.mods?.ios?.infoPlist).toBeDefined();
    expect(config.android?.permissions).toEqual(expect.arrayContaining(ANDROID_PERMISSIONS));
  });

  it('coexists with the iOS 27 scene manifest in either order', () => {
    const { addSceneManifest, SCENE_MANIFEST, SCENE_DELEGATE_SOURCE } = withIosSceneLifecycle;
    const base = { NSBonjourServices: ['_other._tcp'] };
    for (const plist of [
      addSceneManifest(applyTeamMeshInfoPlist(base)),
      applyTeamMeshInfoPlist(addSceneManifest(base)),
    ]) {
      expect(plist.UIApplicationSceneManifest).toEqual(SCENE_MANIFEST);
      expect(plist.NSBonjourServices).toEqual(['_other._tcp', SERVICE_TYPE]);
      expect(plist.NSLocalNetworkUsageDescription).toMatch(/team/);
    }
    // The mesh's listener refresh rides on the app-level lifecycle. Under
    // scenes, Expo raises it from the UIApplication notifications (which UIKit
    // still posts), the module also observes the UIScene notifications, and
    // the scene delegate forwards the same transitions to the app delegate.
    expect(SCENE_DELEGATE_SOURCE).toMatch(
      /sceneDidEnterBackground[\s\S]*?applicationDidEnterBackground/,
    );
    expect(SCENE_DELEGATE_SOURCE).toMatch(
      /sceneWillEnterForeground[\s\S]*?applicationWillEnterForeground/,
    );
  });

  it('is registered after GNSS and before the scene plugin', () => {
    const source = fs.readFileSync(path.resolve('app.config.ts'), 'utf8');
    const gnss = source.indexOf("'./plugins/withGnss'");
    const mesh = source.indexOf("'./plugins/withTeamMesh'");
    const scene = source.indexOf("'./plugins/withIosSceneLifecycle'");
    expect(gnss).toBeGreaterThan(-1);
    expect(gnss).toBeLessThan(mesh);
    expect(mesh).toBeLessThan(scene);
  });

  it('the native module observes both lifecycle sources', () => {
    const swift = fs.readFileSync(
      path.resolve('modules/inukshuk-mesh/ios/InukshukMeshModule.swift'),
      'utf8',
    );
    for (const hook of [
      'OnAppEntersBackground',
      'OnAppEntersForeground',
      'UIScene.didEnterBackgroundNotification',
      'UIScene.willEnterForegroundNotification',
    ]) {
      expect(swift).toContain(hook);
    }
  });
});

/**
 * @jest-environment node
 */
const { describe, expect, it } = require('@jest/globals');

const withIosSceneLifecycle = require('./withIosSceneLifecycle');

const { addSceneManifest, updateAppDelegate, SCENE_MANIFEST, SCENE_DELEGATE_SOURCE } =
  withIosSceneLifecycle;

/** The AppDelegate.swift that Expo SDK 56's prebuild template generates (body excerpt). */
const SDK56_APP_DELEGATE = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }
}
`;

describe('withIosSceneLifecycle', () => {
  describe('Info.plist', () => {
    it('declares a single-scene manifest whose delegate is the generated class', () => {
      const plist = addSceneManifest({ CFBundleName: 'Inukshuk' });
      expect(plist.CFBundleName).toBe('Inukshuk');
      expect(plist.UIApplicationSceneManifest).toEqual({
        UIApplicationSupportsMultipleScenes: false,
        UISceneConfigurations: {
          UIWindowSceneSessionRoleApplication: [
            {
              UISceneConfigurationName: 'Default Configuration',
              UISceneDelegateClassName: 'InukshukSceneDelegate',
            },
          ],
        },
      });
    });

    it('is idempotent and refuses to overwrite a foreign manifest', () => {
      const once = addSceneManifest({});
      expect(addSceneManifest(once)).toEqual(once);
      expect(() =>
        addSceneManifest({ UIApplicationSceneManifest: { UISceneConfigurations: {} } }),
      ).toThrow(/different UIApplicationSceneManifest/);
    });
  });

  describe('AppDelegate.swift', () => {
    it('only starts React Native in didFinishLaunching on a background relaunch', () => {
      const out = updateAppDelegate(SDK56_APP_DELEGATE);
      expect(out).not.toContain('#if os(iOS) || os(tvOS)');
      // Location (TaskManager recording) and CoreBluetooth state restoration
      // (the GNSS link) relaunch the app with no scene.
      expect(out).toContain(
        'let backgroundRelaunchKeys: [UIApplication.LaunchOptionsKey] = [.location, .bluetoothCentrals]',
      );
      expect(out).toMatch(
        /if backgroundRelaunchKeys\.contains\(where: \{ launchOptions\?\[\$0\] != nil \}\) \{\n\s+window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s+factory\.startReactNative\(/,
      );
      // super still runs, so subscribers (InukshukGnss's CoreBluetooth
      // restoration) see the launch options.
      expect(out).toContain(
        'return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
      );
      // The factory and the URL overrides the scene delegate forwards to stay.
      expect(out).toContain('reactNativeFactory = factory');
      expect(out).toContain('RCTLinkingManager.application(app, open: url, options: options)');
    });

    it('is idempotent', () => {
      const once = updateAppDelegate(SDK56_APP_DELEGATE);
      expect(updateAppDelegate(once)).toBe(once);
    });

    it('fails loudly on a template it does not know (SDK upgrade)', () => {
      expect(() => updateAppDelegate('class AppDelegate: ExpoAppDelegate {}')).toThrow(
        /not the Expo SDK 56 template/,
      );
    });
  });

  describe('SceneDelegate.swift', () => {
    it('exports the Objective-C name the scene manifest points at', () => {
      const className =
        SCENE_MANIFEST.UISceneConfigurations.UIWindowSceneSessionRoleApplication[0]
          .UISceneDelegateClassName;
      expect(SCENE_DELEGATE_SOURCE).toContain(`@objc(${className})`);
      expect(SCENE_DELEGATE_SOURCE).toContain('UIWindowSceneDelegate');
    });

    it('creates the window from the scene, mirrors it on the app delegate and starts RN', () => {
      expect(SCENE_DELEGATE_SOURCE).toContain('UIWindow(windowScene: windowScene)');
      expect(SCENE_DELEGATE_SOURCE).toContain('appDelegate.window = window');
      expect(SCENE_DELEGATE_SOURCE).toContain('factory.startReactNative(');
      // Adopts a window React Native already started in (background relaunch).
      expect(SCENE_DELEGATE_SOURCE).toContain('existing.windowScene = windowScene');
      // Cold-start links reach Linking.getInitialURL() through launch options.
      expect(SCENE_DELEGATE_SOURCE).toContain('UIApplicationLaunchOptionsURLKey');
    });

    it.each([
      ['openURLContexts URLContexts', 'application(UIApplication.shared, open: context.url'],
      ['continue userActivity', 'continue: userActivity, restorationHandler'],
      ['sceneDidBecomeActive', 'applicationDidBecomeActive(UIApplication.shared)'],
      ['sceneWillResignActive', 'applicationWillResignActive(UIApplication.shared)'],
      ['sceneWillEnterForeground', 'applicationWillEnterForeground(UIApplication.shared)'],
      ['sceneDidEnterBackground', 'applicationDidEnterBackground(UIApplication.shared)'],
      ['performActionFor shortcutItem', 'performActionFor: shortcutItem'],
    ])('forwards %s to the ExpoAppDelegate', (sceneCallback, forwarded) => {
      expect(SCENE_DELEGATE_SOURCE).toContain(sceneCallback);
      expect(SCENE_DELEGATE_SOURCE).toContain(forwarded);
    });
  });

  it('registers the Info.plist, AppDelegate, file and Xcode project mods', () => {
    const config = withIosSceneLifecycle({ name: 'Inukshuk', slug: 'inukshuk' });
    const ios = config.mods?.ios ?? {};
    expect(Object.keys(ios).sort()).toEqual(
      ['appDelegate', 'dangerous', 'infoPlist', 'xcodeproj'].sort(),
    );
  });
});

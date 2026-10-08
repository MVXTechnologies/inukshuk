/**
 * @jest-environment node
 */
const { describe, expect, it } = require('@jest/globals');

const { clearSplashExitListener } = require('./withSplashNoExitTransfer');

/** MainActivity.kt as SDK 56's prebuild leaves it after expo-splash-screen's mod (excerpt). */
const SDK56_MAIN_ACTIVITY = `package com.inukshuk.app
import expo.modules.splashscreen.SplashScreenManager

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // setTheme(R.style.AppTheme);
    // @generated begin expo-splashscreen - expo prebuild (DO NOT MODIFY) sync-f3ff59a738c56c9a6119210cb55f0b613eb8b6af
    SplashScreenManager.registerOnActivity(this)
    // @generated end expo-splashscreen
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;

describe('withSplashNoExitTransfer', () => {
  it('clears the exit-animation listener right after super.onCreate, on API 31+ only', () => {
    const out = clearSplashExitListener(SDK56_MAIN_ACTIVITY);
    const lines = out.split('\n');
    const register = lines.findIndex((l) => l.includes('registerOnActivity(this)'));
    const superCall = lines.findIndex((l) => l.includes('super.onCreate(null)'));
    const clear = lines.findIndex((l) => l.includes('splashScreen.clearOnExitAnimationListener()'));
    // expo-splash-screen installs the listener before super.onCreate; ours
    // must come after both, and before onCreate returns (resume reads it).
    expect(register).toBeGreaterThan(-1);
    expect(superCall).toBeGreaterThan(register);
    expect(clear).toBeGreaterThan(superCall);
    expect(lines.slice(superCall, clear).join('\n')).toContain(
      'Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S',
    );
    const onCreateEnd = lines.findIndex((l, i) => i > clear && l === '  }');
    expect(onCreateEnd).toBeGreaterThan(clear);
  });

  it('is idempotent', () => {
    const once = clearSplashExitListener(SDK56_MAIN_ACTIVITY);
    expect(clearSplashExitListener(once)).toBe(once);
    expect(once.match(/clearOnExitAnimationListener/g)).toHaveLength(1);
  });

  it('fails the prebuild when the template has no super.onCreate call', () => {
    expect(() =>
      clearSplashExitListener(SDK56_MAIN_ACTIVITY.replace('super.onCreate(null)', '')),
    ).toThrow(/no super\.onCreate/);
  });
});

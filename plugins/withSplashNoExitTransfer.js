// @ts-check
const { withMainActivity } = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

/**
 * Android 12+: let the system remove the splash screen itself, instead of
 * handing ("transferring") it to the app for a custom exit animation (#643).
 *
 * expo-splash-screen registers `setOnExitAnimationListener` on every launch
 * (SplashScreenManager.configureSplashScreen: a 400 ms alpha fade). With a
 * listener registered, the activity reports `handleSplashScreenExit` when it
 * resumes, and on its first drawn frame WindowManager asks the app's MAIN
 * thread to take a copy of the splash view. If the main thread does not answer
 * within the transfer timeout, WindowManager gives up ("Activity transferring
 * splash screen timeout"), starts its own `starting_reveal` animation — and the
 * copy then arrives late, the app fades and removes it anyway, and that reveal
 * animation never completes. From then on every synchronous input injection
 * waits 5 s for animations (`Timed out waiting for animations to complete,
 * animationType=starting_reveal`), for the life of the window.
 *
 * On CI that is the store.yaml flake: each Maestro tap (down + up) costs 10 s,
 * each key 10 s, and `eraseText: 50` blows the driver's 120 s deadline. On a
 * phone, the same late launch (first frame + WebView start-up on the main
 * thread, a 3.6 s frame on the emulator) can leave the window in that state.
 *
 * Without a listener there is no transfer, no timeout to race, and nothing for
 * the app's main thread to answer: the system's default splash exit is used.
 * Clearing it after `super.onCreate` (where expo-splash-screen installed it)
 * and before the activity resumes is what the platform reads. Below API 31 the
 * androidx compat splash is an in-app view with no transfer, so it is left as is.
 */

const TAG = 'inukshuk-splash-no-exit-transfer';

const CLEAR_LISTENER_KOTLIN = [
  '    // #643: no splash hand-off to the app (see plugins/withSplashNoExitTransfer.js).',
  '    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {',
  '      splashScreen.clearOnExitAnimationListener()',
  '    }',
].join('\n');

/**
 * Inserts the listener reset right after `super.onCreate(...)` in the Kotlin
 * MainActivity. Idempotent (tagged block). Throws when the anchor is missing,
 * so a template change fails the prebuild instead of silently dropping the fix.
 * @param {string} contents
 * @returns {string}
 */
function clearSplashExitListener(contents) {
  const anchor = /super\.onCreate\([^)]*\)/;
  if (!anchor.test(contents)) {
    throw new Error(`${TAG}: no super.onCreate(...) call found in MainActivity`);
  }
  return mergeContents({
    src: contents,
    newSrc: CLEAR_LISTENER_KOTLIN,
    tag: TAG,
    anchor,
    offset: 1,
    comment: '    //',
  }).contents;
}

/** @type {import('@expo/config-plugins').ConfigPlugin} */
function withSplashNoExitTransfer(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      throw new Error(`${TAG}: expected a Kotlin MainActivity, got ${cfg.modResults.language}`);
    }
    cfg.modResults.contents = clearSplashExitListener(cfg.modResults.contents);
    return cfg;
  });
}

module.exports = withSplashNoExitTransfer;
module.exports.clearSplashExitListener = clearSplashExitListener;

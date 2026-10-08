// @ts-check
const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * Drop androidx.emoji2's startup initializer (#643).
 *
 * androidx.appcompat pulls in emoji2, whose `EmojiCompatInitializer` runs at
 * every launch through androidx.startup and asks Google Play services'
 * downloadable-fonts provider (content://com.google.android.gms.fonts) for
 * "Noto Color Emoji Compat" (seen on CI ~60 ms after "Running main"). Holding
 * that provider ties our process to GMS: when Play services restarts or
 * updates, Android kills its provider clients, so the app dies with it.
 *
 * It is not the only client: the Android System WebView in our process (the
 * pdf.js rasterizer, the photo resize host) queries the same provider for
 * Google Sans and Noto Color Emoji Compat ~1-3 s after it loads, and on CI
 * that alone still got the app killed (#643, run 37719332961). This removes
 * the launch-time, app-owned query; the WebView one is out of our hands.
 *
 * The app does not need it: React Native draws <Text> with its own layout (no
 * EmojiCompat), the system emoji font covers what users type, and appcompat
 * treats an unconfigured EmojiCompat as "use the platform font". The cost is
 * only that emoji newer than the phone's Android version show as the system
 * renders them, in text fields, on old phones.
 */

const STARTUP_PROVIDER = 'androidx.startup.InitializationProvider';
const EMOJI_INITIALIZER = 'androidx.emoji2.text.EmojiCompatInitializer';

/**
 * Adds `<meta-data android:name="…EmojiCompatInitializer" tools:node="remove"/>`
 * under the androidx.startup provider (declared `tools:node="merge"`), so the
 * manifest merger removes the library's entry. Idempotent.
 * @param {any} manifest the parsed AndroidManifest.xml (xml2js shape)
 * @returns {any}
 */
function removeEmojiCompatInitializer(manifest) {
  const root = manifest.manifest;
  root.$ = root.$ || {};
  root.$['xmlns:tools'] = root.$['xmlns:tools'] || 'http://schemas.android.com/tools';
  const application = root.application && root.application[0];
  if (!application) throw new Error('withoutEmojiCompatInitializer: no <application> element');

  application.provider = application.provider || [];
  let provider = application.provider.find(
    (/** @type {any} */ p) => p.$ && p.$['android:name'] === STARTUP_PROVIDER,
  );
  if (!provider) {
    provider = {
      $: {
        'android:name': STARTUP_PROVIDER,
        'android:authorities': '${applicationId}.androidx-startup',
        'android:exported': 'false',
        'tools:node': 'merge',
      },
    };
    application.provider.push(provider);
  }
  provider['meta-data'] = provider['meta-data'] || [];
  const existing = provider['meta-data'].find(
    (/** @type {any} */ m) => m.$ && m.$['android:name'] === EMOJI_INITIALIZER,
  );
  if (existing) {
    existing.$['tools:node'] = 'remove';
  } else {
    provider['meta-data'].push({
      $: { 'android:name': EMOJI_INITIALIZER, 'tools:node': 'remove' },
    });
  }
  return manifest;
}

/** @type {import('@expo/config-plugins').ConfigPlugin} */
function withoutEmojiCompatInitializer(config) {
  return withAndroidManifest(config, (cfg) => {
    cfg.modResults = removeEmojiCompatInitializer(cfg.modResults);
    return cfg;
  });
}

module.exports = withoutEmojiCompatInitializer;
module.exports.removeEmojiCompatInitializer = removeEmojiCompatInitializer;

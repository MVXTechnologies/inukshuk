/**
 * @jest-environment node
 */
const { describe, expect, it } = require('@jest/globals');

const { removeEmojiCompatInitializer } = require('./withoutEmojiCompatInitializer');

const EMOJI = 'androidx.emoji2.text.EmojiCompatInitializer';

function manifest(application = {}) {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      application: [{ $: { 'android:name': '.MainApplication' }, ...application }],
    },
  };
}

function startupProvider(out) {
  return out.manifest.application[0].provider.find(
    (p) => p.$['android:name'] === 'androidx.startup.InitializationProvider',
  );
}

describe('withoutEmojiCompatInitializer', () => {
  it('declares the startup provider as a merge and removes the emoji2 initializer', () => {
    const out = removeEmojiCompatInitializer(manifest());
    expect(out.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');
    const provider = startupProvider(out);
    expect(provider.$).toMatchObject({
      'android:authorities': '${applicationId}.androidx-startup',
      'android:exported': 'false',
      'tools:node': 'merge',
    });
    expect(provider['meta-data']).toEqual([
      { $: { 'android:name': EMOJI, 'tools:node': 'remove' } },
    ]);
  });

  it('keeps other providers and other startup initializers', () => {
    const other = { $: { 'android:name': 'expo.modules.OtherProvider' } };
    const lifecycle = { $: { 'android:name': 'androidx.lifecycle.ProcessLifecycleInitializer' } };
    const out = removeEmojiCompatInitializer(
      manifest({
        provider: [
          other,
          {
            $: { 'android:name': 'androidx.startup.InitializationProvider' },
            'meta-data': [lifecycle],
          },
        ],
      }),
    );
    expect(out.manifest.application[0].provider).toContain(other);
    expect(startupProvider(out)['meta-data']).toEqual([
      lifecycle,
      { $: { 'android:name': EMOJI, 'tools:node': 'remove' } },
    ]);
  });

  it('is idempotent', () => {
    const once = removeEmojiCompatInitializer(manifest());
    const twice = removeEmojiCompatInitializer(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});

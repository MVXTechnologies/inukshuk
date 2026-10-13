/**
 * @jest-environment node
 */
const { describe, expect, it } = require('@jest/globals');

const { removePushEntitlement } = require('./withoutPushEntitlement');

describe('withoutPushEntitlement', () => {
  it('removes aps-environment and keeps every other entitlement', () => {
    expect(
      removePushEntitlement({
        'aps-environment': 'development',
        'com.apple.developer.healthkit': true,
      }),
    ).toEqual({ 'com.apple.developer.healthkit': true });
  });

  it('is a no-op without aps-environment', () => {
    expect(removePushEntitlement({ 'com.apple.developer.healthkit': true })).toEqual({
      'com.apple.developer.healthkit': true,
    });
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ALLOWED_ENTITLEMENTS, unexpectedEntitlements } from './iosEntitlements.mjs';

describe('unexpectedEntitlements', () => {
  it('accepts the entitlements the profile grants', () => {
    assert.deepEqual(unexpectedEntitlements({ 'com.apple.developer.healthkit': true }), []);
    assert.deepEqual(unexpectedEntitlements({}), []);
    assert.deepEqual(unexpectedEntitlements(undefined), []);
  });

  it('names every entitlement the profile does not grant (push, 2.5.0)', () => {
    assert.deepEqual(
      unexpectedEntitlements({
        'com.apple.developer.healthkit': true,
        'aps-environment': 'development',
        'com.apple.developer.associated-domains': [],
      }),
      ['aps-environment', 'com.apple.developer.associated-domains'],
    );
  });

  it('allows HealthKit, which 2.0+ store builds already sign with', () => {
    assert.ok(ALLOWED_ENTITLEMENTS.includes('com.apple.developer.healthkit'));
  });

  it('allows time-sensitive notifications (Team SOS, #708), never push', () => {
    assert.deepEqual(
      unexpectedEntitlements({ 'com.apple.developer.usernotifications.time-sensitive': true }),
      [],
    );
    assert.ok(!ALLOWED_ENTITLEMENTS.includes('aps-environment'));
  });
});

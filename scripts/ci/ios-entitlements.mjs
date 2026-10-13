/**
 * Fails when the final iOS entitlements (after every config plugin, as
 * `expo prebuild` would write them) include one the App Store provisioning
 * profile does not grant. See iosEntitlements.mjs.
 *
 *   node scripts/ci/ios-entitlements.mjs
 */
import { execFileSync } from 'node:child_process';

import { ALLOWED_ENTITLEMENTS, unexpectedEntitlements } from './iosEntitlements.mjs';

const json = execFileSync('npx', ['expo', 'config', '--type', 'introspect', '--json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
  maxBuffer: 64 * 1024 * 1024,
});
const entitlements = JSON.parse(json).ios?.entitlements ?? {};
process.stdout.write(`iOS entitlements: ${JSON.stringify(entitlements)}\n`);
const extra = unexpectedEntitlements(entitlements);
if (extra.length > 0) {
  process.stdout.write(
    `::error title=iOS entitlement not in the provisioning profile::${extra.join(', ')} ` +
      `(allowed: ${ALLOWED_ENTITLEMENTS.join(', ')}). The store build would fail to sign; ` +
      'see scripts/ci/iosEntitlements.mjs.\n',
  );
  process.exitCode = 1;
}

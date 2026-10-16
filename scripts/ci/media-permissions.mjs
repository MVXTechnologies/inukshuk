/**
 * Fails when the final config (after every config plugin, as `expo prebuild`
 * would write it) declares microphone, audio-routing or screen-capture access,
 * or a library-default camera string (security review R-RTC-5). See
 * mediaPermissions.mjs.
 *
 *   node scripts/ci/media-permissions.mjs
 */
import { execFileSync } from 'node:child_process';

import { mediaPermissionProblems } from './mediaPermissions.mjs';

const json = execFileSync('npx', ['expo', 'config', '--type', 'introspect', '--json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
  maxBuffer: 64 * 1024 * 1024,
});
const config = JSON.parse(json);
const problems = mediaPermissionProblems({
  infoPlist: config.ios?.infoPlist,
  manifest: config._internal?.modResults?.android?.manifest,
});
if (problems.length > 0) {
  for (const p of problems) {
    process.stdout.write(`::error title=Media permission (R-RTC-5)::${p}\n`);
  }
  process.stdout.write('See plugins/withWebRtcDataOnly.js and scripts/ci/mediaPermissions.mjs.\n');
  process.exitCode = 1;
} else {
  process.stdout.write('No microphone or screen-capture access declared; camera string is ours.\n');
}

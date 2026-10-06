/**
 * OTA runtime-match check (.github/workflows/runtime-check.yml).
 *
 * An EAS Update reaches only the binaries whose runtime (the native
 * fingerprint, app.config.ts `runtimeVersion.policy: 'fingerprint'`) equals
 * the fingerprint of the commit it was published from. So once a merge
 * changes the fingerprint, OTAs published from main stop reaching the
 * latest store build until the next store release. That is often right
 * (native changes are legitimate) — but the release process must KNOW. This
 * module turns the fingerprints (PR head, PR base) and the latest finished
 * production builds from EAS into that message. It warns; it never fails.
 */

export const PLATFORMS = /** @type {const} */ (['ios', 'android']);
export const COMMENT_MARKER = '<!-- runtime-check -->';

const LABEL = { ios: 'iOS', android: 'Android' };

/** "2.3.0 (build 18)" / "2.3.0 (versionCode 61)" from an `eas build:list --json` entry. */
export function buildLabel(platform, build) {
  const number = platform === 'ios' ? 'build' : 'versionCode';
  return `${build.appVersion ?? '?'} (${number} ${build.appBuildVersion ?? '?'})`;
}

/**
 * The newest entry of an `eas build:list --json` result, with its runtime
 * under `runtimeVersion`, or null. eas-cli changed the shape: up to v20 it is
 * a top-level `runtimeVersion` string, from v24 an object `runtime.version`
 * (with the same value as `fingerprint.hash` under the fingerprint policy).
 */
export function latestBuild(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const build = list[0];
  if (!build || typeof build !== 'object') return null;
  const runtimeVersion = [
    build.runtimeVersion,
    build.runtime?.version,
    build.fingerprint?.hash,
  ].find((v) => typeof v === 'string' && v !== '');
  return runtimeVersion ? { ...build, runtimeVersion } : null;
}

/** Fingerprint sources that differ between two `fingerprint:generate` results. */
export function changedSources(before, after) {
  const key = (s) => `${s.type}:${s.filePath ?? s.id ?? '?'}`;
  const index = (fp) => new Map((fp?.sources ?? []).map((s) => [key(s), s.hash]));
  const a = index(before);
  const b = index(after);
  const changed = [];
  for (const [k, hash] of b) if (a.get(k) !== hash) changed.push(k);
  for (const k of a.keys()) if (!b.has(k)) changed.push(k);
  return changed.sort();
}

/**
 * How a store build that main's OTAs no longer reach still gets fixes: OTAs
 * published (ota-update.yml) from a hotfix branch cut at the build's own
 * commit — by convention hotfix/<major>.<minor>.x (hotfix/2.3.x is 17cfebb,
 * iOS 2.3.0 build 18's commit). docs/DEPLOYMENT.md › "Field updates without a
 * store release".
 */
export function hotfixRemedy(build) {
  const mm = /^(\d+)\.(\d+)\./.exec(build.appVersion ?? '');
  const branch = mm ? `hotfix/${mm[1]}.${mm[2]}.x` : 'a hotfix branch';
  const commit = typeof build.gitCommitHash === 'string' ? build.gitCommitHash.slice(0, 7) : null;
  return (
    ` Until then, fixes reach it as OTAs published from ${branch}` +
    `${commit ? ` (cut at its commit ${commit})` : ' (cut at its commit)'}: run ota-update.yml on that branch.`
  );
}

const short = (hash) => (hash ? hash.slice(0, 12) : 'n/a');

/**
 * @param {{
 *   event: 'pull_request' | 'push' | string,
 *   head: Record<'ios'|'android', {hash: string, sources?: object[]}>,
 *   base?: Record<'ios'|'android', {hash: string, sources?: object[]}> | null,
 *   store?: Record<'ios'|'android', object | null> | null,
 * }} input
 * @returns {{ prChangesRuntime: boolean, warnings: string[], markdown: string }}
 */
export function assessRuntime({ event, head, base = null, store = null }) {
  const isPr = event === 'pull_request';
  const warnings = [];
  const rows = [];
  const notes = [];
  let prChangesRuntime = false;

  for (const p of PLATFORMS) {
    const headHash = head[p].hash;
    const baseHash = base?.[p]?.hash ?? null;
    const build = store?.[p] ?? null;
    const storeHash = build?.runtimeVersion ?? null;
    const label = build ? buildLabel(p, build) : null;
    const changesHere = isPr && baseHash !== null && baseHash !== headHash;
    if (changesHere) prChangesRuntime = true;

    let status;
    if (isPr) {
      if (!changesHere) {
        status = 'unchanged by this PR';
        if (storeHash && baseHash && baseHash !== storeHash) {
          status += `; main already differs from store ${label}`;
          notes.push(
            `${LABEL[p]}: main (not this PR) already differs from store ${label}, so OTAs from main ` +
              `do not reach it.${hotfixRemedy(build)}`,
          );
        }
      } else if (!storeHash) {
        status = 'CHANGED by this PR (latest store build unknown)';
        warnings.push(
          `${LABEL[p]}: this PR changes the native runtime. The latest store build could not be read ` +
            '(no EXPO_TOKEN or EAS unavailable), so which installs stop receiving OTAs is unknown.',
        );
      } else if (baseHash === storeHash) {
        status = `CHANGED by this PR; store ${label} is on main's current runtime`;
        warnings.push(
          `${LABEL[p]}: this PR changes the native runtime; OTAs from main will no longer reach ` +
            `store ${label} until the next store release.${hotfixRemedy(build)}`,
        );
      } else if (headHash === storeHash) {
        status = `CHANGED by this PR, back to store ${label}'s runtime`;
        notes.push(
          `${LABEL[p]}: this PR brings main back to the runtime of store ${label}, so OTAs from main ` +
            'reach it again after merge.',
        );
      } else {
        status = `CHANGED by this PR; main had already diverged from store ${label}`;
        warnings.push(
          `${LABEL[p]}: this PR changes the native runtime again. main had already diverged from ` +
            `store ${label}, so OTAs from main already do not reach it; the next store release picks up both.` +
            hotfixRemedy(build),
        );
      }
    } else if (!storeHash) {
      status = 'latest store build unknown';
    } else if (headHash === storeHash) {
      status = `matches store ${label}: OTAs from here reach it`;
    } else {
      status = `differs from store ${label}`;
      warnings.push(
        `${LABEL[p]}: this commit's native runtime differs from store ${label}; OTAs published from ` +
          `main no longer reach it until the next store release.${hotfixRemedy(build)}`,
      );
    }
    rows.push(
      `| ${LABEL[p]} | \`${short(baseHash)}\` | \`${short(headHash)}\` | ` +
        `${build ? `\`${short(storeHash)}\` ${label}` : 'n/a'} | ${status} |`,
    );
    if (changesHere) {
      const changed = changedSources(base?.[p], head[p]);
      if (changed.length > 0) {
        const shown = changed.slice(0, 15).map((c) => `\`${c}\``);
        if (changed.length > shown.length) shown.push(`… ${changed.length - shown.length} more`);
        notes.push(`${LABEL[p]} fingerprint sources that changed: ${shown.join(', ')}`);
      }
    }
  }

  const title = prChangesRuntime
    ? '### This PR changes the native runtime'
    : '### Native runtime (OTA reach)';
  const lines = [
    COMMENT_MARKER,
    title,
    '',
    ...warnings.map((w) => `> [!WARNING]\n> ${w}\n`),
    `| Platform | ${isPr ? 'Base' : '—'} | ${isPr ? 'This PR' : 'This commit'} | Latest store build | Status |`,
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...notes.map((n) => `- ${n}`),
    ...(notes.length > 0 ? [''] : []),
    'Not a failure: native changes are legitimate. It means the release process needs a store ' +
      'build before installed apps can take OTA updates from main again. See docs/CI.md › ' +
      '"OTA runtime-match check".',
  ];
  return { prChangesRuntime, warnings, markdown: `${lines.join('\n')}\n` };
}

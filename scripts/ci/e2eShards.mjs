/**
 * The Android E2E shard plan (.maestro/shards.json): which flow runs on which
 * emulator, in which order. Pure functions over the parsed manifest so the
 * rules are unit-tested (e2eShards.test.mjs) and shared by the CLI
 * (e2e-shards.mjs) that the workflow and the runner script call.
 */

/**
 * Shard names, in manifest order, optionally narrowed to `only` (names
 * separated by commas or spaces; empty or "all" keeps every shard).
 * Unknown names are an error: a typo in a manual dispatch must not run
 * nothing and report green.
 */
export function shardNames(manifest, only = '') {
  const all = Object.keys(manifest.shards);
  const wanted = only
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== 'all');
  if (wanted.length === 0) return all;
  const unknown = wanted.filter((s) => !all.includes(s));
  if (unknown.length > 0) {
    throw new Error(`unknown shard(s): ${unknown.join(', ')} (known: ${all.join(', ')})`);
  }
  return all.filter((s) => wanted.includes(s));
}

/** The flows of one shard, in run order. */
export function shardFlows(manifest, shard) {
  const flows = manifest.shards[shard];
  if (!flows) {
    throw new Error(`unknown shard: ${shard} (known: ${Object.keys(manifest.shards).join(', ')})`);
  }
  return [...flows];
}

/** Does this flow's launchApp wipe the app's data (`clearState: true`)? */
export function clearsState(flowSource) {
  return /^\s*-?\s*clearState:\s*true\b/m.test(flowSource);
}

/**
 * The Maestro config `tags` of a flow (its header, before `---`), in either
 * YAML form: `tags: [a, b]` or a `tags:` line followed by `  - a` items.
 */
export function flowTags(flowSource) {
  const header = flowSource.split(/^---\s*$/m)[0] ?? '';
  const lines = header.split('\n');
  const at = lines.findIndex((line) => /^tags:/.test(line));
  if (at < 0) return [];
  const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, '');
  const inline = /^tags:\s*\[(.*)\]\s*$/.exec(lines[at] ?? '');
  if (inline) return (inline[1] ?? '').split(',').map(unquote).filter(Boolean);
  const tags = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (!item) break;
    tags.push(unquote(item[1] ?? ''));
  }
  return tags;
}

/**
 * Does the flow drive the device location itself? Declared with the tag
 * `own-location`. The runner then pauses its background geo-fix loop for that
 * flow, so the follow-camera stays exactly where the flow put the user.
 */
export function ownsLocation(flowSource) {
  return flowTags(flowSource).includes('own-location');
}

/**
 * Does the flow start from a clean app? Declared with the tag `clean-state`.
 * The runner clears the app's data before EVERY attempt (a retry included,
 * so it never inherits a half-done first attempt), then waits for Android to
 * finish removing the old task before Maestro launches the app. Maestro's own
 * `clearState: true` launches at once, and on the API 34 emulator the pending
 * task removal killed the new process ("Destroy timeout of remove-task …
 * start not valid"), which then only started 30 s later (E2E run 37909729348).
 * Like `clearState`, it wipes what earlier flows left: last of its shard.
 */
export function startsClean(flowSource) {
  return flowTags(flowSource).includes('clean-state');
}

/**
 * Every problem with the plan, as human-readable strings (empty = valid).
 * `flowFiles` is the list of .yaml files in .maestro/, `sources` maps each
 * to its text.
 */
export function validateShards(manifest, flowFiles, sources) {
  const problems = [];
  const parked = manifest.parked ?? {};
  const requires = manifest.requires ?? {};
  const last = manifest.last ?? {};
  const where = new Map();
  for (const [shard, flows] of Object.entries(manifest.shards)) {
    if (flows.length === 0) problems.push(`shard ${shard} is empty`);
    flows.forEach((flow, index) => {
      if (where.has(flow)) {
        problems.push(`${flow} is in both ${where.get(flow).shard} and ${shard}`);
      } else {
        where.set(flow, { shard, index });
      }
      if (!flowFiles.includes(flow)) problems.push(`${flow} (shard ${shard}) does not exist`);
      if (flow in parked) problems.push(`${flow} is both parked and in shard ${shard}`);
    });
  }
  for (const flow of flowFiles) {
    if (!where.has(flow) && !(flow in parked)) {
      problems.push(
        `${flow} is in no shard and not parked: add it to a shard (or park it, with why)`,
      );
    }
  }
  for (const [flow, reason] of Object.entries(parked)) {
    if (!flowFiles.includes(flow)) problems.push(`parked ${flow} does not exist`);
    if (typeof reason !== 'string' || reason.trim() === '') {
      problems.push(`parked ${flow} needs a reason`);
    }
  }
  for (const [flow, deps] of Object.entries(requires)) {
    const at = where.get(flow);
    if (!at) {
      problems.push(`requires: ${flow} is in no shard`);
      continue;
    }
    for (const dep of deps) {
      const d = where.get(dep);
      if (!d || d.shard !== at.shard || d.index >= at.index) {
        problems.push(`${flow} requires ${dep} earlier in the same shard (${at.shard})`);
      }
    }
  }
  const mustBeLast = new Set(Object.keys(last));
  for (const flow of flowFiles) {
    const source = sources[flow] ?? '';
    if (clearsState(source) || startsClean(source)) mustBeLast.add(flow);
  }
  for (const flow of mustBeLast) {
    const at = where.get(flow);
    if (!at) continue;
    const flows = manifest.shards[at.shard];
    if (at.index !== flows.length - 1) {
      // Two "last" flows in one shard can never both be satisfied.
      problems.push(`${flow} must be the last flow of shard ${at.shard}`);
    }
  }
  return problems;
}

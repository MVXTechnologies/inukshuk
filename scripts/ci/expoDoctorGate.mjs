/**
 * The rules behind the Expo Doctor gate (#338), separated from the process so
 * they can be tested without running `expo-doctor`.
 */

/**
 * Turn a JSONC file into JSON: drop `//` and block comments and the trailing
 * commas Prettier adds, leaving anything inside strings alone.
 */
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  // Trailing commas: legal in JSONC, and Prettier writes them.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Read `expo-doctor`'s report.
 *
 * Its output is one `✖ <check name>` line per failure, then a
 * `N/M checks passed. K checks failed.` summary. Both are needed: the names
 * to match acknowledgements, the totals to notice that a previously failing
 * check now passes.
 */
export function parseDoctorOutput(output) {
  const failed = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('✖')) continue;
    const name = line.slice(1).trim();
    if (name.length > 0) failed.push(name);
  }
  const summary = /(\d+)\/(\d+) checks passed/.exec(output);
  return {
    failed,
    passed: summary ? Number(summary[1]) : null,
    total: summary ? Number(summary[2]) : null,
    // No summary line at all means doctor did not get far enough to check
    // anything — a crash, a network failure, a bad install.
    ran: summary !== null,
  };
}

const matches = (ack, checkName) => checkName.toLowerCase().includes(ack.check.toLowerCase());

/**
 * Decide whether the gate passes.
 *
 * Fails when an unacknowledged check failed, when an acknowledgement has
 * expired, or when an acknowledged check has started passing — an accepted
 * finding must be re-argued on a date, and a spent entry must be removed
 * rather than left to hide the next real failure.
 */
export function decideDoctorGate({ report, acknowledgements, today }) {
  const problems = [];
  const notes = [];

  if (!report.ran) {
    return {
      ok: false,
      notes,
      problems: ['expo-doctor did not produce a report — treating that as a failure'],
    };
  }

  for (const ack of acknowledgements) {
    if (!ack.check || !ack.reason || !ack.exitPlan || !ack.until) {
      problems.push(
        `acknowledgement ${JSON.stringify(ack.check ?? '(unnamed)')} needs check, reason, exitPlan and until`,
      );
      continue;
    }
    const stillFailing = report.failed.some((name) => matches(ack, name));
    if (!stillFailing) {
      problems.push(
        `"${ack.check}" passes now — remove its acknowledgement so it can fail the gate again`,
      );
      continue;
    }
    if (ack.until < today) {
      problems.push(
        `the acknowledgement of "${ack.check}" expired on ${ack.until} — fix it or argue for a new date (exit plan: ${ack.exitPlan})`,
      );
      continue;
    }
    notes.push(`accepting "${ack.check}" until ${ack.until} — ${ack.reason}`);
  }

  const unacknowledged = report.failed.filter(
    (name) => !acknowledgements.some((ack) => matches(ack, name)),
  );
  for (const name of unacknowledged) problems.push(`unacknowledged check failed: ${name}`);

  if (problems.length === 0 && report.passed !== null) {
    notes.push(`${report.passed}/${report.total} checks passed`);
  }
  return { ok: problems.length === 0, notes, problems };
}

#!/usr/bin/env node
/**
 * CLI over the ANR-dialog detector (anrDialog.mjs). Reads a UI hierarchy
 * (uiautomator XML or Maestro JSON) on stdin.
 *
 *   node scripts/ci/anr-dialog.mjs [appLabel]
 *
 * No dialog: prints nothing, exit 1. Dialog: prints one line
 *   <own|other> <closeX> <closeY> <title>
 * (`-` for a missing button centre), exit 0.
 */
import { readFileSync } from 'node:fs';

import { findAnrDialog } from './anrDialog.mjs';

try {
  const found = findAnrDialog(readFileSync(0, 'utf8'), process.argv[2] ?? 'Inukshuk');
  if (!found) {
    process.exitCode = 1;
  } else {
    const [cx, cy] = found.close ?? ['-', '-'];
    process.stdout.write(`${found.ownApp ? 'own' : 'other'} ${cx} ${cy} ${found.title}\n`);
  }
} catch (err) {
  process.stderr.write(`anr-dialog: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
}

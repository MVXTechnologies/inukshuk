/**
 * Display size (#760) coverage guard: every module-level StyleSheet in a
 * screen is read through `useScaledStyles` (the codemod's `xSheet` naming),
 * so a new screen can't silently stay at 100 %. Files the rollout reaches
 * after the 2.7.0 integration are listed in eslint's DISPLAY_SCALE_PENDING.
 *
 * Fix a failure by running `node scripts/codemods/display-scale.mjs <file>`.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

function pending(): Set<string> {
  const config = fs.readFileSync(path.join(ROOT, 'eslint.config.js'), 'utf8');
  const block = /const DISPLAY_SCALE_PENDING = \[([\s\S]*?)\];/.exec(config)?.[1] ?? '';
  return new Set([...block.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? ''));
}

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== '__snapshots__') sources(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

it('every screen sheet is scaled (or pending the 2.7.0 integration)', () => {
  const skip = pending();
  const offenders: string[] = [];
  for (const file of [
    ...sources(path.join(ROOT, 'src/features')),
    ...sources(path.join(ROOT, 'app')),
  ]) {
    const rel = path.relative(ROOT, file);
    if (skip.has(rel)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^(?:export )?const (\w+) = StyleSheet\.create\(/gm)) {
      const name = m[1] ?? '';
      if (!name.endsWith('Sheet')) offenders.push(`${rel}: ${name}`);
    }
  }
  expect(offenders).toEqual([]);
});

it('the pending list only names files that exist', () => {
  for (const rel of pending()) expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
});

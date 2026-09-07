import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * #235 — the regression fence.
 *
 * The bug was never one bad field; it was that nothing in the codebase said a
 * text field must offer a way out. On iOS there is no "hide keyboard" key, so
 * a field the user cannot escape is a soft-lock, and the next field somebody
 * adds would reintroduce it silently. This test reads the source tree and
 * fails the build for any `TextInput`/`Searchbar` that has no exit:
 *
 * - **multiline** — Return types a newline, so the ONLY exit is the shared
 *   accessory bar: it must carry `inputAccessoryViewID`.
 * - **everything else** (single line, number pads included) — it must declare
 *   `returnKeyType`. On a normal keyboard that IS the Return key; on a number
 *   pad, which has no Return key, `returnKeyType` is what makes RN synthesise
 *   its own Done toolbar (`setDefaultInputAccessoryView`) — which it refuses
 *   to do if the field also carries an `inputAccessoryViewID`, so number pads
 *   must NOT have one.
 *
 * A field may of course have both. If this test fails on a field you just
 * added, the fix is one prop — see `KeyboardDoneBar.tsx`.
 */

// Resolved from this file so the scan does not depend on jest's cwd.
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const ROOTS = ['src/features', 'app'].map((r) => join(REPO_ROOT, r));
/** Props that hand a field the shared iOS accessory bar / a Return exit. */
const ACCESSORY = 'inputAccessoryViewID';
const RETURN_KEY = 'returnKeyType';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

interface Field {
  file: string;
  line: number;
  tag: string;
  props: string;
}

/**
 * Collect each `<TextInput …>` / `<Searchbar …>` element with its prop text.
 * A regex is enough because every call site in this repo is a plain JSX
 * element: we scan from the opening tag to the matching `>` at depth 0 of
 * `{}` nesting, which keeps inline arrow bodies (`onSubmitEditing={() => …}`)
 * from ending the element early.
 */
/** Drop `//` and block comments so prose never counts as a prop. */
function stripComments(jsx: string): string {
  return jsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function fieldsIn(file: string): Field[] {
  const src = readFileSync(file, 'utf8');
  const found: Field[] = [];
  const opener = /<(TextInput|Searchbar)(\s|\n|\/|>)/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(src)) !== null) {
    const tag = m[1] ?? '';
    let depth = 0;
    let i = m.index + 1 + tag.length;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    found.push({
      file: file.slice(REPO_ROOT.length + 1),
      line: src.slice(0, m.index).split('\n').length,
      tag,
      // Comments are stripped: several of these fields carry a note ABOUT
      // `inputAccessoryViewID` explaining why they must not have one, and a
      // scanner that reads prose would take that as the prop itself.
      props: stripComments(src.slice(m.index, i)),
    });
  }
  return found;
}

const fields = ROOTS.flatMap((r) => sourceFiles(r)).flatMap(fieldsIn);

describe('every text field can be escaped on iOS (#235)', () => {
  it('finds the app’s text fields at all (guards the scanner itself)', () => {
    // A silently-empty scan would make every assertion below vacuous.
    expect(fields.length).toBeGreaterThanOrEqual(10);
    expect(fields.some((f) => /multiline/.test(f.props))).toBe(true);
  });

  it.each(fields.map((f) => [`${f.file}:${f.line} <${f.tag}>`, f] as const))(
    '%s offers a way out',
    (_name, field) => {
      const hasAccessory = field.props.includes(ACCESSORY);
      const hasReturnKey = field.props.includes(RETURN_KEY);
      const multiline = /(^|\s)multiline(\s|=|\/|$)/m.test(field.props);
      const numberPad = /keyboardType=["'{](numeric|decimal-pad|number-pad|phone-pad)/.test(
        field.props,
      );

      if (multiline) {
        // Return types a newline here, so the shared bar is the only exit.
        expect(hasAccessory).toBe(true);
      } else {
        expect(hasReturnKey).toBe(true);
        // An accessory id on a number pad suppresses RN's own Done toolbar.
        if (numberPad) expect(hasAccessory).toBe(false);
      }
    },
  );
});

#!/usr/bin/env node
/**
 * Display size codemod (#760). Re-runnable and idempotent: run it again after
 * a rebase brings in new screens.
 *
 *   node scripts/codemods/display-scale.mjs [--dry] [files…]
 *
 * With no files it walks `src/` and `app/` (tests excluded). Two rewrites:
 *
 * 1. Paper comes from `@ui/paper` (the scaled wrappers), not
 *    `react-native-paper`. `src/ui/paper.tsx` and `src/ui/theme.ts` keep the
 *    real import.
 * 2. A module-level `const NAME = StyleSheet.create({…})` becomes
 *    `const NAMESheet = StyleSheet.create({…})`, and every component or hook
 *    that reads NAME gets `const NAME = useScaledStyles(NAMESheet);` as its
 *    first statement. A reference outside any component or hook (a module
 *    helper, a class) reads `NAMESheet` (unscaled) and is listed on stdout
 *    for a hand fix.
 *
 * A component or hook is a function whose name starts with a capital or
 * `use` + capital: a function declaration, or a function / arrow assigned to
 * such a const, directly or through memo() / forwardRef().
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const explicit = args.filter((a) => !a.startsWith('--'));
// --imported-sheets=a,b: exported sheets other modules import by name.
const importedArg = args.find((a) => a.startsWith('--imported-sheets='));
const IMPORTED_SHEETS = new Set(
  importedArg ? importedArg.slice('--imported-sheets='.length).split(',') : [],
);
// --exclude=<file listing repo-relative paths, one per line>: leave these alone.
const excludeArg = args.find((a) => a.startsWith('--exclude='));
const EXCLUDE = new Set(
  excludeArg
    ? fs
        .readFileSync(excludeArg.slice('--exclude='.length), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    : [],
);

const KEEP_PAPER = new Set(['src/ui/paper.tsx', 'src/ui/theme.ts']);
const SKIP_SHEETS = new Set(['src/ui/displayScale.tsx']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__snapshots__') continue;
      walk(p, out);
    } else if (
      /\.tsx?$/.test(e.name) &&
      !/\.test\.tsx?$/.test(e.name) &&
      !/\.d\.ts$/.test(e.name)
    ) {
      out.push(p);
    }
  }
  return out;
}

const files = explicit.length
  ? explicit.map((f) => path.resolve(ROOT, f))
  : [...walk(path.join(ROOT, 'src'), []), ...walk(path.join(ROOT, 'app'), [])];

const COMPONENT = /^(?:[A-Z]|use[A-Z])/;
const report = [];
let changed = 0;

function fnName(fn) {
  if (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) {
    if (fn.name && COMPONENT.test(fn.name.text)) return fn.name.text;
  }
  // const X = () => …  /  const X = memo(() => …)  /  forwardRef(function X(…) {…})
  let node = fn.parent;
  while (node && ts.isCallExpression(node)) node = node.parent;
  if (node && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    if (COMPONENT.test(node.name.text)) return node.name.text;
  }
  if (node && ts.isExportAssignment(node) && fn.parent !== node) return 'default';
  return null;
}

function isFn(n) {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);
}

function transform(file) {
  const rel = path.relative(ROOT, file);
  if (EXCLUDE.has(rel)) return;
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = []; // { start, end, text }

  // 1. Paper imports.
  if (!KEEP_PAPER.has(rel)) {
    for (const st of sf.statements) {
      if (
        (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) &&
        st.moduleSpecifier &&
        ts.isStringLiteral(st.moduleSpecifier) &&
        st.moduleSpecifier.text === 'react-native-paper'
      ) {
        edits.push({
          start: st.moduleSpecifier.getStart(sf),
          end: st.moduleSpecifier.getEnd(),
          text: "'@ui/paper'",
        });
      }
    }
  }

  // 2. Module-level sheets.
  const sheets = [];
  if (!SKIP_SHEETS.has(rel)) {
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          !d.name.text.endsWith('Sheet') && // already converted
          d.initializer &&
          ts.isCallExpression(d.initializer) &&
          d.initializer.expression.getText(sf) === 'StyleSheet.create'
        ) {
          sheets.push(d.name);
        }
      }
    }
    // Sheets another module exports (and this codemod renamed there).
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || st.importClause?.isTypeOnly) continue;
      const nb = st.importClause?.namedBindings;
      if (!nb || !ts.isNamedImports(nb)) continue;
      for (const spec of nb.elements) {
        if (!spec.propertyName && IMPORTED_SHEETS.has(spec.name.text)) sheets.push(spec.name);
        else if (spec.propertyName && IMPORTED_SHEETS.has(spec.propertyName.text)) {
          // { exported as local }: the export was renamed; so is the local.
          edits.push({
            start: spec.propertyName.getStart(sf),
            end: spec.propertyName.getEnd(),
            text: `${spec.propertyName.text}Sheet`,
          });
          sheets.push(spec.name);
        }
      }
    }
  }

  const inserts = new Map(); // fn body node -> Set(names)
  let usesHook = false;
  for (const nameNode of sheets) {
    const name = nameNode.text;
    const sheetName = `${name}Sheet`;
    // Bail on shadowing: any other binding of the same name in the file.
    let shadowed = false;
    const refs = [];
    const visit = (n) => {
      if (ts.isIdentifier(n) && n.text === name && n !== nameNode) {
        const p = n.parent;
        const isProp =
          (ts.isPropertyAccessExpression(p) && p.name === n) ||
          (ts.isPropertyAssignment(p) && p.name === n) ||
          (ts.isPropertySignature(p) && p.name === n) ||
          ts.isImportSpecifier(p) ||
          ts.isJsxAttribute(p);
        const isDecl =
          (ts.isVariableDeclaration(p) && p.name === n) ||
          (ts.isParameter(p) && p.name === n) ||
          (ts.isBindingElement(p) && p.name === n) ||
          (ts.isFunctionDeclaration(p) && p.name === n);
        if (isDecl) shadowed = true;
        else if (ts.isShorthandPropertyAssignment(p)) refs.push(n);
        else if (!isProp) refs.push(n);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (shadowed) {
      report.push(`${rel}: '${name}' is shadowed; skipped`);
      continue;
    }
    edits.push({ start: nameNode.getStart(sf), end: nameNode.getEnd(), text: sheetName });
    for (const ref of refs) {
      // Nearest enclosing component / hook.
      let fn = null;
      for (let p = ref.parent; p; p = p.parent) {
        if (isFn(p) && fnName(p)) {
          fn = p;
          break;
        }
      }
      if (fn === null) {
        const line = sf.getLineAndCharacterOfPosition(ref.getStart(sf)).line + 1;
        report.push(`${rel}:${line}: '${name}' outside a component; reads ${sheetName} unscaled`);
        const shorthand = ts.isShorthandPropertyAssignment(ref.parent);
        edits.push({
          start: ref.getStart(sf),
          end: ref.getEnd(),
          text: shorthand ? `${name}: ${sheetName}` : sheetName,
        });
        continue;
      }
      if (!inserts.has(fn)) inserts.set(fn, new Set());
      inserts.get(fn).add(name);
    }
  }

  for (const [fn, names] of inserts) {
    usesHook = true;
    const decls = [...names].map((n) => `const ${n} = useScaledStyles(${n}Sheet);`).join('\n');
    const body = fn.body;
    if (ts.isBlock(body)) {
      edits.push({
        start: body.getStart(sf) + 1,
        end: body.getStart(sf) + 1,
        text: `\n${decls}\n`,
      });
    } else {
      // Expression-bodied arrow: give it a block.
      edits.push({
        start: body.getStart(sf),
        end: body.getStart(sf),
        text: `{\n${decls}\nreturn (`,
      });
      edits.push({ start: body.getEnd(), end: body.getEnd(), text: ');\n}' });
    }
  }

  if (usesHook && !/from '@ui\/displayScale'/.test(src)) {
    const lastImport = [...sf.statements].filter(ts.isImportDeclaration).pop();
    const at = lastImport ? lastImport.getEnd() : 0;
    edits.push({
      start: at,
      end: at,
      text: "\nimport { useScaledStyles } from '@ui/displayScale';",
    });
  } else if (
    usesHook &&
    !/\buseScaledStyles\b/.test(
      src
        .split('\n')
        .filter((l) => l.startsWith('import'))
        .join('\n'),
    )
  ) {
    report.push(`${rel}: add useScaledStyles to its @ui/displayScale import by hand`);
  }

  if (edits.length === 0) return;
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (out !== src) {
    changed++;
    if (!dry) fs.writeFileSync(file, out);
  }
}

for (const f of files) transform(f);
for (const r of report) console.log(r);
console.log(`${dry ? '[dry] ' : ''}${changed} file(s) changed, ${report.length} note(s)`);

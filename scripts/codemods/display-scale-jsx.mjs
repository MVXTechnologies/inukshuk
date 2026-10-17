#!/usr/bin/env node
/**
 * Display size codemod, part 2 (#760): numeric size props on components that
 * take a size in dp (glyphs, raw vector icons, Svg canvases, thumbnails,
 * hold buttons). `size={22}` becomes `size={sz(22)}`, and the enclosing
 * component or hook gets `const { sz } = useDisplayScale();`. An `<Svg>`
 * whose width and height are literals and that has no viewBox gets
 * `viewBox="0 0 W H"`, so its drawing scales with it instead of cropping.
 *
 *   node scripts/codemods/display-scale-jsx.mjs [--dry] [--exclude=<list>] [files…]
 *
 * Idempotent (a prop already reading sz(…) is not a literal). Paper's own
 * components are scaled by `@ui/paper` and are not touched here.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
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
const explicit = args.filter((a) => !a.startsWith('--'));

/** Tags whose size props are dp at 100 %. */
const TAGS = new Set([
  'InukshukGlyph',
  'MaterialCommunityIcons',
  'Svg',
  'SourceTile',
  'CopyValueButton',
  'LocatorThumb',
  'MapPreview',
  'CoverageMap',
  'HoldButton',
  'RegionPreviewThumb',
  'Badge',
  'MemberAvatar',
  'BandAvatar',
  'FaceStack',
]);
const PROPS = new Set(['size', 'width', 'height', 'radius', 'diameter']);
const COMPONENT = /^(?:[A-Z]|use[A-Z])/;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = explicit.length
  ? explicit.map((f) => path.resolve(ROOT, f))
  : [...walk(path.join(ROOT, 'src/features'), []), ...walk(path.join(ROOT, 'app'), [])];

function isFn(n) {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);
}
function isComponent(fn) {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) {
    if (COMPONENT.test(fn.name.text)) return true;
  }
  let node = fn.parent;
  while (node && ts.isCallExpression(node)) node = node.parent;
  return !!(
    node &&
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    COMPONENT.test(node.name.text)
  );
}

const report = [];
let changed = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  if (EXCLUDE.has(rel)) continue;
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const fns = new Set();
  const visit = (n) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText(sf);
      if (TAGS.has(tag)) {
        const attrs = n.attributes.properties.filter(ts.isJsxAttribute);
        const lit = (name) => {
          const a = attrs.find((x) => x.name.getText(sf) === name);
          const ex =
            a?.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : null;
          return ex && ts.isNumericLiteral(ex) ? ex.text : null;
        };
        let touched = false;
        for (const a of attrs) {
          const name = a.name.getText(sf);
          if (!PROPS.has(name) || !a.initializer || !ts.isJsxExpression(a.initializer)) continue;
          const ex = a.initializer.expression;
          if (ex && ts.isNumericLiteral(ex)) {
            edits.push({ start: ex.getStart(sf), end: ex.getEnd(), text: `sz(${ex.text})` });
            touched = true;
          }
        }
        if (touched && tag === 'Svg' && !attrs.some((x) => x.name.getText(sf) === 'viewBox')) {
          const w = lit('width');
          const h = lit('height');
          if (w && h) {
            edits.push({
              start: n.tagName.getEnd(),
              end: n.tagName.getEnd(),
              text: ` viewBox="0 0 ${w} ${h}"`,
            });
          }
        }
        if (touched) {
          let fn = null;
          for (let p = n.parent; p; p = p.parent) {
            if (isFn(p) && isComponent(p)) {
              fn = p;
              break;
            }
          }
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          if (fn === null) report.push(`${rel}:${line}: <${tag}> outside a component; fix by hand`);
          else fns.add(fn);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (fns.size === 0) continue;
  if (/\bconst \{ sz \} = useDisplayScale\(\)/.test(src)) {
    // Already converted once: only new literals; the hooks are there.
  } else if (/\bsz\b/.test(src)) {
    report.push(`${rel}: already has an 'sz' binding; skipped`);
    continue;
  }
  for (const fn of fns) {
    const body = fn.body;
    if (!ts.isBlock(body)) {
      edits.push({
        start: body.getStart(sf),
        end: body.getStart(sf),
        text: '{\nconst { sz } = useDisplayScale();\nreturn (',
      });
      edits.push({ start: body.getEnd(), end: body.getEnd(), text: ');\n}' });
    } else if (!body.getText(sf).includes('const { sz } = useDisplayScale()')) {
      edits.push({
        start: body.getStart(sf) + 1,
        end: body.getStart(sf) + 1,
        text: '\nconst { sz } = useDisplayScale();\n',
      });
    }
  }
  const imp = sf.statements.find(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === '@ui/displayScale',
  );
  if (!imp) {
    const lastImport = [...sf.statements].filter(ts.isImportDeclaration).pop();
    const at = lastImport ? lastImport.getEnd() : 0;
    edits.push({
      start: at,
      end: at,
      text: "\nimport { useDisplayScale } from '@ui/displayScale';",
    });
  } else if (!/\buseDisplayScale\b/.test(imp.getText(sf))) {
    const nb = imp.importClause?.namedBindings;
    if (nb && ts.isNamedImports(nb) && nb.elements.length) {
      const last = nb.elements[nb.elements.length - 1];
      edits.push({ start: last.getEnd(), end: last.getEnd(), text: ', useDisplayScale' });
    }
  }
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (out !== src) {
    changed++;
    if (!dry) fs.writeFileSync(file, out);
  }
}
for (const r of report) console.log(r);
console.log(`${dry ? '[dry] ' : ''}${changed} file(s) changed, ${report.length} note(s)`);

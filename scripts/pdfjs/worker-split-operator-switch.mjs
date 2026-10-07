#!/usr/bin/env node
/**
 * Android System WebView 112/113 (V8 11.2/11.3) miscompiles pdf.js 6's
 * `getOperatorList`. Once TurboFan optimizes its `promiseBody` (the operator
 * loop with its ~50-case switch), the renderer aborts with a V8 fatal error,
 * reported later in font code (`_simpleFontToUnicode`). It hits every 2024
 * US Topo sheet there. Chromium 114 is fine, and so are 112/113 when only
 * that function stays unoptimized (`--turbo-filter`), or with either
 * `--no-turbo-allocation-folding` or `--no-turbo-cf-optimization`.
 *
 * This moves the switch, unchanged, into its own function, called once per
 * operator from the loop. V8 then compiles the loop and the switch as two
 * graphs, and 112/113 no longer crash. Inside the moved switch:
 * - `continue` (next operator) becomes `return 1`;
 * - `return` (pdf.js waits for an async step, then resumes) becomes `return 2`;
 * - `break`, and the end of the switch, return 0 and hand back the
 *   operator's `fn`/`args` (`r`/`e`), which the switch may have rewritten.
 *
 * The loop then continues, returns, or adds the operator. Everything else in
 * the switch reads `promiseBody`'s own state through the closure, as before.
 * So the worker does exactly the same work.
 *
 * Run it after `sync-assets.mjs` on a pdf.js bump. `assets.test.mjs` pins the
 * source and result hashes. `src/core/geo/pdfWorkerPatch.ts` anchors its
 * layer filter on the call this writes.
 *
 *   node scripts/pdfjs/worker-split-operator-switch.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const parser = require('@babel/parser');

/** The call the loop makes; `pdfWorkerPatch.ts` anchors on it. */
export const OPERATOR_SWITCH_CALL = 'const __inkStep=__inkOperatorSwitch(e,r);';

const LOOP_HEAD = 'const i={};let o,q,v,S;for(;!(o=k.check());){';
const BEFORE_SWITCH = 'i.args=null;if(!j.read(i))break;let e=i.args,r=i.fn;';
const AFTER_SWITCH = 'a.addOp(r,e)}if(o)next(';
const LOOPS = new Set([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
]);
const FUNCTIONS = new Set([
  'FunctionExpression',
  'FunctionDeclaration',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);

function children(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) out.push(...value.filter((v) => v && typeof v.type === 'string'));
    else if (value && typeof value.type === 'string') out.push(value);
  }
  return out;
}

function unique(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + 1) >= 0) {
    throw new Error(`anchor not unique or missing: ${needle}`);
  }
  return at;
}

export function splitOperatorSwitch(source) {
  const head = unique(source, LOOP_HEAD + BEFORE_SWITCH + 'switch(0|r){case Ir:');
  const switchAt = head + LOOP_HEAD.length + BEFORE_SWITCH.length;
  const ast = parser.parse(source, { sourceType: 'module' });
  let sw = null;
  (function find(node) {
    if (sw) return;
    if (node.type === 'SwitchStatement' && node.start === switchAt) sw = node;
    else children(node).forEach(find);
  })(ast.program);
  if (!sw) throw new Error('operator switch not found');
  if (!source.startsWith(AFTER_SWITCH, sw.end)) throw new Error('unexpected code after the switch');

  const edits = [];
  (function walk(node, inLoop, inFunction) {
    if (!inFunction) {
      if (node.type === 'LabeledStatement') throw new Error('labelled statement in the switch');
      if (node.type === 'ThisExpression') throw new Error('`this` in the switch');
      if (node.type === 'Identifier' && node.name === 'arguments') throw new Error('`arguments`');
      if (node.type === 'YieldExpression' || node.type === 'AwaitExpression') {
        throw new Error('yield/await in the switch');
      }
      if (node.type === 'ContinueStatement' && !inLoop) edits.push([node, 'return 1;']);
      if (node.type === 'ReturnStatement') {
        if (node.argument) throw new Error('return with a value in the switch');
        edits.push([node, 'return 2;']);
      }
    }
    const loop = inLoop || LOOPS.has(node.type);
    const fn = inFunction || FUNCTIONS.has(node.type);
    children(node).forEach((c) => walk(c, loop, fn));
  })(sw, false, false);

  let body = source.slice(sw.start, sw.end);
  for (const [node, text] of edits.sort((a, b) => b[0].start - a[0].start)) {
    body = body.slice(0, node.start - sw.start) + text + body.slice(node.end - sw.start);
  }
  const fn =
    'let __inkE,__inkR;' +
    `const __inkOperatorSwitch=function(e,r){${body}__inkE=e;__inkR=r;return 0};`;
  const call = `${OPERATOR_SWITCH_CALL}if(__inkStep===1)continue;if(__inkStep===2)return;e=__inkE;r=__inkR;`;
  return source.slice(0, head) + fn + source.slice(head, sw.start) + call + source.slice(sw.end);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const from = join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs');
  const to = join(root, 'assets/pdfjs/pdf.worker.legacy.min.mjs.pdfjs');
  const out = splitOperatorSwitch(readFileSync(from, 'utf8'));
  parser.parse(out, { sourceType: 'module' }); // still valid
  writeFileSync(to, out);
  console.log(`${to}: operator switch split out`);
}

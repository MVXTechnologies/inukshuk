#!/usr/bin/env node
/**
 * pdf.js 6's JPEG 2000 decoder (`pdfjs-dist/wasm/openjpeg.wasm`) uses two
 * WebAssembly *relaxed SIMD* instructions, which no Safari/WKWebView
 * supports (MDN: relaxed-SIMD "iOS: no"; verified on the iOS 26.3 simulator:
 * "relaxed simd instructions not supported"). There, the whole module fails
 * to compile and pdf.js falls back to its plain-JS decoder, about 2× slower
 * than pdf.js 3.11's own JPX decoder — and that fallback is only reachable
 * by URL, so inline mode could not decode JPX on iOS at all.
 *
 * This rewrites the module to plain (fixed-width) SIMD, which iOS has had
 * since 16.4, choosing for each instruction one of the behaviours the
 * relaxed-SIMD spec already allows an engine to pick:
 *
 * - `f32x4.relaxed_madd(a, b, c)` → `f32x4.add(f32x4.mul(a, b), c)` (the
 *   unfused result; engines without FMA return exactly this);
 * - `i32x4.relaxed_trunc_f32x4_s` → `i32x4.trunc_sat_f32x4_s` (the
 *   saturating result, which every engine returns for in-range lanes).
 *
 * So the rewritten decoder computes what a conforming engine may compute
 * with the original. Needs wabt (`brew install wabt`) — run it after
 * `sync-assets.mjs` on a pdf.js bump; `assets.test.mjs` pins the source hash
 * and the absence of relaxed SIMD in the result.
 *
 *   node scripts/pdfjs/openjpeg-no-relaxed-simd.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const source = join(root, 'node_modules/pdfjs-dist/wasm/openjpeg.wasm');
const target = join(root, 'assets/pdfjs/openjpeg.wasm.pdfjs');
const work = mkdtempSync(join(tmpdir(), 'openjpeg-'));
try {
  const wat = join(work, 'openjpeg.wat');
  execFileSync('wasm2wat', ['--enable-all', source, '-o', wat]);
  const lines = readFileSync(wat, 'utf8').split('\n');
  const out = [];
  let funcStart = -1;
  let needsLocal = false;
  const flush = () => {
    if (funcStart >= 0 && needsLocal) {
      // The scratch local goes after the function's own locals (indices of
      // params and existing locals are unchanged).
      let at = funcStart + 1;
      while (at < out.length && /^\s*\((param|result|local)\b/.test(out[at] ?? '')) at += 1;
      out.splice(at, 0, '    (local $__ink_c v128)');
    }
    needsLocal = false;
  };
  let madd = 0;
  let trunc = 0;
  for (const line of lines) {
    if (/^\s*\(func\b/.test(line)) {
      flush();
      funcStart = out.length;
    }
    if (/\bf32x4\.relaxed_madd\b/.test(line)) {
      const indent = /^\s*/.exec(line)?.[0] ?? '';
      if (line.trim() !== 'f32x4.relaxed_madd') throw new Error(`unexpected form: ${line}`);
      out.push(
        `${indent}local.set $__ink_c`,
        `${indent}f32x4.mul`,
        `${indent}local.get $__ink_c`,
        `${indent}f32x4.add`,
      );
      needsLocal = true;
      madd += 1;
      continue;
    }
    if (/\bi32x4\.relaxed_trunc_f32x4_s\b/.test(line)) {
      out.push(line.replace('i32x4.relaxed_trunc_f32x4_s', 'i32x4.trunc_sat_f32x4_s'));
      trunc += 1;
      continue;
    }
    if (/relaxed_/.test(line))
      throw new Error(`unhandled relaxed SIMD instruction: ${line.trim()}`);
    out.push(line);
  }
  flush();
  writeFileSync(wat, out.join('\n'));
  const wasm = join(work, 'openjpeg.wasm');
  execFileSync('wat2wasm', ['--disable-relaxed-simd', wat, '-o', wasm]);
  // Valid WITHOUT relaxed SIMD: what iOS can compile.
  execFileSync('wasm-validate', ['--disable-relaxed-simd', wasm]);
  writeFileSync(target, readFileSync(wasm));
  console.log(
    `openjpeg.wasm: ${madd} relaxed_madd and ${trunc} relaxed_trunc rewritten -> ${target}`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

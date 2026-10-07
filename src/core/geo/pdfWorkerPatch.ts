import { PDF_LAYER_RUNTIME_SOURCE } from './pdfLayers';

/**
 * Teach the bundled pdf.js 6.4.299 worker to skip content hidden by optional
 * content (see `pdfLayers.ts` for why: hidden US Topo imagery costs seconds of
 * JPEG decoding per render). pdf.js 6 still decodes hidden content while
 * building the operator list and hides it only when painting, as 3.11 did:
 * the visibility config never reaches the worker.
 *
 * The worker ships minified (`assets/pdfjs/pdf.worker.legacy.min.mjs.pdfjs`,
 * see PdfRasterizer.README), so this is a handful of exact-text insertions
 * into its evaluator, each anchored on a snippet that occurs exactly once. It
 * is all-or-nothing: if any anchor is missing or ambiguous (a different
 * pdf.js build), the source is returned untouched and rendering simply keeps
 * paying for hidden content. The runtime (`__inkOC`) is prepended, so the
 * patched code can never run without it.
 *
 * Minified names in `getOperatorList` (6.4.299): `w` = the call's
 * StateManager (one per call, so a form XObject's nested call has its own;
 * the preprocessor `j` would do too, but a `const j` inside the operator
 * switch shadows it there), `r` = op code, `y` = pdf.js' marked-content
 * depth, `Ir` = `OPS.paintXObject`; `p` / `u` = the parsed `/OC` of an image
 * / form XObject.
 *
 * The shipped worker has its operator switch moved into
 * `__inkOperatorSwitch` (scripts/pdfjs/worker-split-operator-switch.mjs, for
 * Android WebView 112/113), so insertion 1 anchors on the loop's call to it.
 *
 * Insertions:
 * 1. Before the call to the evaluator's operator switch: drop image/form XObjects, inline
 *    images and shading fills inside hidden sections, before anything is
 *    fetched or decoded. The depth is pdf.js' own counter.
 * 2. Where pdf.js adds a parsed `/OC` section: record its visibility at the
 *    depth it opened.
 * 3/4. Image and form XObjects carrying their own `/OC`: return before
 *    decoding when hidden.
 */

interface Insertion {
  label: string;
  anchor: string;
  /** Text inserted immediately before (`before`) or after the anchor. */
  text: string;
  position: 'before' | 'after';
}

export const PDF_WORKER_INSERTIONS: readonly Insertion[] = [
  {
    label: 'operator switch',
    anchor: 'const __inkStep=__inkOperatorSwitch(e,r);',
    text: 'if(__inkOC.op(w,r,y))continue;',
    position: 'before',
  },
  {
    label: 'optional content section',
    anchor: 'next(f.parseMarkedContentProps(e[1],n).then(e=>{',
    text: '__inkOC.push(w,e,y);',
    position: 'after',
  },
  {
    label: 'image XObject /OC',
    anchor: 'c.has("OC")&&(p=await this.parseMarkedContentProps(c.get("OC"),e));',
    text: 'if(void 0!==p&&!__inkOC.visible(p))return;',
    position: 'after',
  },
  {
    label: 'form XObject /OC',
    anchor: 'l.has("OC")&&(u=await this.parseMarkedContentProps(l.get("OC"),e));',
    text: 'if(void 0!==u&&!__inkOC.visible(u))return;',
    position: 'after',
  },
];

export interface PatchedWorker {
  source: string;
  /** False when the source was returned unchanged. */
  patched: boolean;
  /** Labels of insertions whose anchor was missing or not unique. */
  unmatched: string[];
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    count += 1;
    if (count > 1) break;
  }
  return count;
}

/** Apply every insertion, or none. Idempotent: an already-patched source is returned as is. */
export function patchPdfWorkerSource(source: string): PatchedWorker {
  if (source.startsWith(PDF_LAYER_RUNTIME_SOURCE)) {
    return { source, patched: true, unmatched: [] };
  }
  const unmatched = PDF_WORKER_INSERTIONS.filter((p) => occurrences(source, p.anchor) !== 1).map(
    (p) => p.label,
  );
  if (unmatched.length > 0) return { source, patched: false, unmatched };
  let out = source;
  for (const p of PDF_WORKER_INSERTIONS) {
    const replacement = p.position === 'before' ? p.text + p.anchor : p.anchor + p.text;
    // A function replacer: `$` sequences in the minified text stay literal.
    out = out.replace(p.anchor, () => replacement);
  }
  return { source: `${PDF_LAYER_RUNTIME_SOURCE}\n;${out}`, patched: true, unmatched: [] };
}

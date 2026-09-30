import { PDF_LAYER_RUNTIME_SOURCE } from './pdfLayers';

/**
 * Teach the bundled pdf.js 3.11.174 worker to skip content hidden by optional
 * content (see `pdfLayers.ts` for why: hidden US Topo imagery costs seconds of
 * JPEG decoding per render).
 *
 * The worker ships minified (`assets/pdfjs/pdf.worker.legacy.min.js.pdfjs`,
 * pinned — see PdfRasterizer.README "Why pdfjs-dist 3.11.174"), so this is a
 * handful of exact-text insertions into its evaluator, each anchored on a
 * snippet that occurs exactly once. It is all-or-nothing: if any anchor is
 * missing or ambiguous (a different pdf.js build), the source is returned
 * untouched and rendering simply keeps paying for hidden content. The runtime
 * (`__inkOC`) is prepended, so the patched code can never run without it.
 *
 * Insertions (minified names: `t` = op fn, `e` = op args, `s` = operator
 * list, `r` = pdf.js util, `i` = primitives, `l` = XObject dict):
 * 1. Before the evaluator's operator switch: track marked-content nesting and
 *    drop image/form XObjects, inline images and shading fills inside hidden
 *    sections — before anything is fetched or decoded.
 * 2. Where pdf.js adds an `/OC` section: record its visibility.
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
    anchor: 'switch(0|t){case r.OPS.paintXObject:D=e[0]instanceof i.Name;',
    text: 'if(__inkOC.op(s,t,e,r.OPS,i.Name))continue;',
    position: 'before',
  },
  {
    label: 'optional content section',
    anchor: 's.addOp(r.OPS.beginMarkedContentProps,["OC",e])',
    text: '__inkOC.push(s,e);',
    position: 'before',
  },
  {
    label: 'image XObject /OC',
    anchor: 'l.has("OC")&&(g=await this.parseMarkedContentProps(l.get("OC"),t));',
    text: 'if(void 0!==g&&!__inkOC.visible(g))return;',
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

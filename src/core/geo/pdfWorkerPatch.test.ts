import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { PDF_LAYER_RUNTIME_SOURCE } from './pdfLayers';
import { PDF_WORKER_INSERTIONS, patchPdfWorkerSource } from './pdfWorkerPatch';
import { moduleAsScript } from './pdfjsRealm.testUtils';

/** A stand-in worker containing every anchor once, with filler between. */
const SYNTHETIC = PDF_WORKER_INSERTIONS.map((p, i) => `/*${i}*/${p.anchor}`).join('\n');

describe('patchPdfWorkerSource', () => {
  it('prepends the runtime and inserts every hook next to its anchor', () => {
    const out = patchPdfWorkerSource(SYNTHETIC);
    expect(out.patched).toBe(true);
    expect(out.unmatched).toEqual([]);
    expect(out.source.startsWith(PDF_LAYER_RUNTIME_SOURCE)).toBe(true);
    for (const p of PDF_WORKER_INSERTIONS) {
      const expected = p.position === 'before' ? p.text + p.anchor : p.anchor + p.text;
      expect(out.source).toContain(expected);
    }
  });

  it('returns the source untouched when any anchor is missing (all or nothing)', () => {
    const [first, ...rest] = PDF_WORKER_INSERTIONS;
    const source = rest.map((p) => p.anchor).join('\n');
    expect(patchPdfWorkerSource(source)).toEqual({
      source,
      patched: false,
      unmatched: [first?.label],
    });
  });

  it('refuses an ambiguous anchor', () => {
    const doubled = `${SYNTHETIC}\n${PDF_WORKER_INSERTIONS[1]?.anchor}`;
    const out = patchPdfWorkerSource(doubled);
    expect(out.patched).toBe(false);
    expect(out.source).toBe(doubled);
    expect(out.unmatched).toEqual([PDF_WORKER_INSERTIONS[1]?.label]);
  });

  it('leaves an empty source (assets not loaded) alone', () => {
    expect(patchPdfWorkerSource('').patched).toBe(false);
  });

  it('is idempotent', () => {
    const once = patchPdfWorkerSource(SYNTHETIC).source;
    expect(patchPdfWorkerSource(once)).toEqual({ source: once, patched: true, unmatched: [] });
  });

  it('keeps `$` sequences in the worker literal', () => {
    const source = `${SYNTHETIC}\nconst s = "$&$1$$";`;
    expect(patchPdfWorkerSource(source).source).toContain('const s = "$&$1$$";');
  });
});

describe('the bundled pdf.js worker', () => {
  // The asset the app ships. If pdf.js is ever rebuilt or bumped, this is the
  // test that says the layer filter silently stopped applying.
  const asset = readFileSync(
    join(__dirname, '../../../assets/pdfjs/pdf.worker.legacy.min.mjs.pdfjs'),
    'utf8',
  );

  it('patches cleanly', () => {
    const out = patchPdfWorkerSource(asset);
    expect(out.unmatched).toEqual([]);
    expect(out.patched).toBe(true);
    expect(out.source.length).toBeGreaterThan(asset.length);
  });

  it('still parses as a JavaScript module once patched', () => {
    const out = patchPdfWorkerSource(asset);
    // Parsing only, as the module body the test realm runs (pdfjsRealm.testUtils).
    expect(() => new vm.Script(moduleAsScript(out.source, 'pdf.worker.mjs'))).not.toThrow();
  });
});

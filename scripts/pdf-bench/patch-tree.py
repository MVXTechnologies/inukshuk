#!/usr/bin/env python3
"""Inject the PDF bench probe into an OLDER source tree (for bisecting).

  patch-tree.py HARNESS_TREE TARGET_TREE

Copies the probe and the harness hook from HARNESS_TREE (this branch) and
patches TARGET_TREE's rasterizer, detail hook and map screen at the same
points this branch instruments. Works on v1.6.0 .. main.
"""
import re
import shutil
import sys

src, dst = sys.argv[1], sys.argv[2]
for f in ['src/lib/pdfBenchProbe.ts', 'src/features/map/hooks/usePdfBench.ts']:
    shutil.copyfile(f'{src}/{f}', f'{dst}/{f}')


def edit(path, fn):
    p = f'{dst}/{path}'
    s = open(p).read()
    t = fn(s)
    assert t != s, path
    open(p, 'w').write(t)


# --- rasterizer: wrap the public rasterize ---------------------------------
def raster(s):
    if 'pdfBenchEmit' in s:
        return s + ' '
    s = s.replace("import { reportError } from '@lib/errorReporting';",
                  "import { reportError } from '@lib/errorReporting';\nimport { PDF_BENCH, pdfBenchEmit, pdfBenchId } from '@lib/pdfBenchProbe';", 1)
    start = s.index('  const rasterize = useCallback<RasterizeFn>(')
    end = s.index('    [replaceEngine],\n  );\n', start) + len('    [replaceEngine],\n  );\n')
    body = s[start:end].replace('const rasterize = ', 'const enqueue = ', 1)
    wrapper = open(f'{src}/src/features/map/PdfRasterizer.tsx').read()
    w0 = wrapper.index('  const rasterize = useCallback<RasterizeFn>(\n    (args) => {\n      if (!PDF_BENCH)')
    w1 = wrapper.index('    [enqueue],\n  );\n', w0) + len('    [enqueue],\n  );\n')
    return s[:start] + body + '\n' + wrapper[w0:w1] + s[end:]


edit('src/features/map/PdfRasterizer.tsx', raster)


# --- detail hook: report visible/covered on each publish + on bounds moves --
def details(s):
    s = s.replace("import { reportError } from '@lib/errorReporting';",
                  "import { reportError } from '@lib/errorReporting';\nimport { PDF_BENCH, pdfBenchEmit } from '@lib/pdfBenchProbe';", 1)
    has_prefetch = 'prefetch: boolean' in s
    vis = '(w.desired as { prefetch?: boolean; key: string }[]).filter((t) => !t.prefetch)'
    anchor = '      w.pinned = new Set(current.map((detail) => detail.imageUri));\n'
    assert anchor in s
    emit = f'''      if (PDF_BENCH) {{
        const visible = {vis};
        const keys = new Set(current.map((d) => d.cacheKey));
        pdfBenchEmit({{
          kind: 'details',
          at: Date.now(),
          bounds: benchBoundsKey,
          visible: visible.length,
          covered: visible.filter((t) => keys.has(t.key){' || (w as { covered?: Set<string> }).covered?.has(t.key)' if has_prefetch else ''}).length,
          shown: current.map((detail) => detail.imageUri),
        }});
      }}
'''
    s = s.replace(anchor, anchor + emit, 1)
    # The bounds the targets were planned for, and a report when only the
    # bounds moved (old hooks do not re-publish then).
    s = s.replace('  const key = JSON.stringify(targets);\n',
                  '''  const key = JSON.stringify(targets);
  const benchBoundsKey = bounds ? JSON.stringify(bounds) : '';
  useEffect(() => {
    if (!PDF_BENCH) return;
    const w = worker.current;
    const visible = %s;
    const keys = new Set(displayed.map((d) => d.cacheKey));
    pdfBenchEmit({
      kind: 'details',
      at: Date.now(),
      bounds: benchBoundsKey,
      visible: visible.length,
      covered: visible.filter((t) => keys.has(t.key) || w.cache.has(t.key)).length,
      shown: displayed.map((detail) => detail.imageUri),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [benchBoundsKey]);
''' % vis, 1)
    return s


edit('src/features/map/usePdfDetails.ts', details)


# --- map screen: mount the harness and count frames ------------------------
def screen(s):
    s = s.replace("import { usePdfDetails } from './usePdfDetails';",
                  "import { usePdfDetails } from './usePdfDetails';\nimport { usePdfBench } from './hooks/usePdfBench';\nimport { PDF_BENCH } from '@lib/pdfBenchProbe';", 1)
    m = re.search(r'  const pdfDetails = usePdfDetails\([\s\S]*?\n  \);\n', s)
    hook = '''  const benchFramesRef = useRef(0);
  usePdfBench({
    cameraRef,
    settledBounds,
    overlays,
    details: pdfDetails,
    renderedFramesRef,
    framesRef: benchFramesRef,
  });
'''
    s = s[:m.end()] + hook + s[m.end():]
    m = re.search(r'\n( +)onDidFinishRenderingFrameFully=\{\(\) => \{\n +renderedFramesRef\.current \+= 1;\n +\}\}', s)
    assert m
    ind = m.group(1)
    s = s[:m.end()] + (f'\n{ind}onDidFinishRenderingFrame={{\n{ind}  PDF_BENCH\n{ind}    ? () => {{\n'
                       f'{ind}        benchFramesRef.current += 1;\n{ind}      }}\n{ind}    : undefined\n{ind}}}') + s[m.end():]
    return s


edit('src/features/map/MapScreen.tsx', screen)
print('patched', dst)

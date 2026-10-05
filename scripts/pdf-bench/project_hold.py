#!/usr/bin/env python3
"""Projection, NOT a measurement: what time-to-sharp would be on Android if
the native renderer kept the page open between crops (a store build).

For every measured step, the native calls' own `loadMs` (opening the PDF and
parsing the page, measured inside the module) is removed from the step's
measured time-to-sharp, except once per map at the start of the run (the
first open still happens). Everything else (render, PNG encode, JS, MapLibre)
is the measured value.

  project_hold.py RUN_DIR
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from report import pct  # noqa: E402

run = sys.argv[1]
rows = []
for line in open(os.path.join(run, 'results.jsonl')):
    d = json.loads(line)
    if d.get('_kind') == 'result' and d.get('kind') == 'step' and d.get('sharpMs') is not None:
        saved = sum(r.get('loadMs') or 0 for r in d['rasters']
                    if r.get('priority') != 'background' and r.get('path') == 'file' and r.get('at', 0) <= d['sharpMs'])
        rows.append((d['map'], round(d['level']), d['sharpMs'], max(0, d['sharpMs'] - saved)))
groups = {}
for m, lvl, ms, proj in rows:
    groups.setdefault((m, lvl), []).append((ms, proj))
print(f"{'map':32} {'z+':>3} {'n':>3} {'meas p50':>9} {'proj p50':>9} {'proj p95':>9} {'proj max':>9}")
for (m, lvl), v in sorted(groups.items()):
    meas = [a for a, _ in v]
    proj = [b for _, b in v]
    print(f"{m[:32]:32} {lvl:>3} {len(v):>3} {round(pct(meas, .5)):>9} {round(pct(proj, .5)):>9} {round(pct(proj, .95)):>9} {max(proj):>9}")
allp = [b for *_, b in rows]
print(f"ALL projected n={len(allp)} p50={round(pct(allp, .5))} p95={round(pct(allp, .95))} max={max(allp)} over1s={sum(1 for x in allp if x > 1000)}")

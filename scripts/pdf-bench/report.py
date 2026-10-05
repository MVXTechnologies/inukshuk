#!/usr/bin/env python3
"""Summarise bench runs: time-to-sharp p50/p95/max per map x zoom level.

  report.py RUN_DIR [RUN_DIR ...]          one table per run
  report.py --compare BEFORE_DIR AFTER_DIR  side by side

Rows group steps by map and zoom level above "whole sheet" (z+0 = fit). A
step that timed out counts as its timeout. `first` columns cover the first
visit to a view (open, jumps, walk steps onto new ground); the walk's
returns to ground already rendered are listed separately as `revisit`.
"""
import json
import os
import sys


def pct(v, p):
    v = sorted(v)
    if not v:
        return None
    k = (len(v) - 1) * p
    lo, hi = int(k), min(len(v) - 1, int(k) + 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


REVISIT = {'walk-out-z+4', 'walk-out-z+2', 'walk-out-fit', 'walk-fit'}


def load(run):
    rows = []
    for line in open(os.path.join(run, 'results.jsonl')):
        d = json.loads(line)
        if d.get('_kind') == 'result' and d.get('kind') == 'step':
            rows.append(d)
    return rows


def ms(d):
    return d['sharpMs'] if d['sharpMs'] is not None else 90000


def table(rows):
    groups = {}
    for d in rows:
        cls = 'revisit' if d['step'] in REVISIT else 'first'
        lvl = round(d['level'])
        groups.setdefault((d['map'], lvl, cls), []).append(d)
    out = []
    for (m, lvl, cls), ds in sorted(groups.items()):
        v = [ms(d) for d in ds]
        out.append({
            'map': m, 'level': lvl, 'class': cls, 'n': len(v),
            'p50': round(pct(v, .5)), 'p95': round(pct(v, .95)), 'max': max(v),
            'over1s': sum(1 for x in v if x > 1000), 'timeouts': sum(1 for d in ds if d['timedOut']),
            'renders': round(sum(len([r for r in d['rasters'] if r.get('priority') != 'background']) for d in ds) / len(ds), 1),
            'density': min((d['density'] for d in ds if d.get('density') is not None), default=None),
        })
    return out


def show(run):
    rows = load(run)
    print(f'## {os.path.basename(run.rstrip("/"))}  ({len(rows)} steps)')
    print(f"{'map':32} {'z+':>3} {'class':7} {'n':>3} {'p50':>6} {'p95':>6} {'max':>6} {'>1s':>4} {'rend':>5} {'dens':>5}")
    for r in table(rows):
        dens = '-' if r['density'] is None else f"{r['density']:.2f}"
        print(f"{r['map'][:32]:32} {r['level']:>3} {r['class']:7} {r['n']:>3} {r['p50']:>6} {r['p95']:>6} {r['max']:>6} {r['over1s']:>4} {r['renders']:>5} {dens:>5}")
    for line in open(os.path.join(run, 'results.jsonl')):
        d = json.loads(line)
        if d.get('kind') == 'import':
            print(f"  import {d['map']}: download {d.get('downloadMs')} ms, parse {d.get('parseMs')} ms, "
                  f"first overview {d.get('overviewMs', '?')} ms")
    allv = [ms(d) for d in rows]
    print(f"ALL n={len(allv)} p50={round(pct(allv,.5))} p95={round(pct(allv,.95))} max={max(allv)} over1s={sum(1 for x in allv if x>1000)}")


def compare(a, b):
    ta = {(r['map'], r['level'], r['class']): r for r in table(load(a))}
    tb = {(r['map'], r['level'], r['class']): r for r in table(load(b))}
    print(f"{'map':32} {'z+':>3} {'class':7} | {'before p50/p95/max':>20} | {'after p50/p95/max':>20}")
    for k in sorted(set(ta) | set(tb)):
        fa = ta.get(k)
        fb = tb.get(k)
        f = lambda r: f"{r['p50']}/{r['p95']}/{r['max']}" if r else '-'
        print(f"{k[0][:32]:32} {k[1]:>3} {k[2]:7} | {f(fa):>20} | {f(fb):>20}")


if __name__ == '__main__':
    if sys.argv[1] == '--compare':
        compare(sys.argv[2], sys.argv[3])
    else:
        for r in sys.argv[1:]:
            show(r)

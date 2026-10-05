#!/usr/bin/env python3
"""Freeze the Convert tool's official-tool reference suite into the repo.

    scripts/convert-fixtures.py [path/to/reference_points.json]

Reads the Phase-1 validation study (`research/validation/reference_points.json`,
1,794 points over 114 pairs, each expected value from an agency tool) and
writes `src/core/convert/fixtures/reference.json`: the same pairs, pinned
pipelines, tolerances and points, minus the bulky provenance (URLs, raw
responses), plus the manual official-tool runs that are not in the JSON yet
(IGN Circé 5.5.0, validation-notes §9).

Consumers (all assert the same thing):
- Jest (`src/core/convert/suite.test.ts`): graph.ts emits these exact
  pipelines; lite.ts reproduces every grid-free point;
- the host runner (`modules/inukshuk-proj/tests/run-host.sh`);
- the on-device self-test (`scripts/convert-native-suite.sh`, iOS sim +
  Android emulator), through the real PROJ module.

Rule per point (CONVERT.md §5.5): `pass` points must match `expected` within
the pair tolerance; `fail-known` points (a diagnosed disagreement with the
agency) must reproduce the frozen PROJ value `proj` to 1e-6 m, so a PROJ or
grid update that moves a known gap fails too. `informational` is skipped.
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT = os.path.expanduser('~/Documents/inukshuk-saved/chart-datum-convert/research/validation/reference_points.json')
OUT = os.path.join(HERE, '..', 'src', 'core', 'convert', 'fixtures', 'reference.json')


def dms(d, m, s):
    return d + m / 60 + s / 3600


def lcc_cc(zone):
    y0 = (zone - 41) * 1_000_000 + 200_000
    return ('+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=lcc '
            f'+lat_0={zone} +lon_0=3 +lat_1={zone - 0.75} +lat_2={zone + 0.75} +x_0=1700000 +y_0={y0} '
            '+ellps=GRS80 +units=m')


CIRCE = {
    'tool': 'IGN Circé France 5.5.0 (circeFR.exe, circelib 1.3.0, DataFRnew.txt, RAF20.tac)',
    'version': '5.5.0',
    'date': '2026-10-05',
    'how': 'manual: IGN Circé 5.5.0 under Wine on the NAS, validation-notes §9',
}
# 31555A-09 Toulouse, 34301H-01 Sète, 1300412-05 Arles (MANUAL_CHECKS M1 inputs).
CIRCE_POINTS = [
    ('31555A-09', dms(43, 33, 24.00884), dms(1, 28, 51.52071), 194.778,
     (577224.8519, 6274247.8954), (44, 1577275.2444, 3151876.3012), 145.9135),
    ('34301H-01', dms(43, 23, 58.95586), dms(3, 42, 7.14775), 51.118,
     (756895.9132, 6255873.8464), (43, 1756863.9938, 2244640.5755), 1.6298),
    ('1300412-05', dms(43, 35, 24.11470), dms(4, 29, 39.07607), 51.341,
     (820697.9984, 6277916.9461), (44, 1820651.4269, 3155545.5599), 2.0703),
]
L93 = ('+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=lcc +lat_0=46.5 +lon_0=3 '
       '+lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m')
RAF20 = ('+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +inv +proj=vgridshift '
         '+grids=fr_ign_RAF20.tif +multiplier=1 +step +proj=unitconvert +xy_in=rad +xy_out=deg')


def circe_pairs():
    src = dict(CIRCE)
    l93 = {'id': 'FR-L93-Circe', 'title': 'RGF93 v2b → Lambert-93 vs IGN Circé 5.5.0', 'status': 'validated-by-official-tool',
           'group': 'France', 'pipeline': L93, 'compute': None, 'epsg': ['EPSG:9794'], 'io': {'input': ['lon_deg', 'lat_deg'], 'output': ['E_m', 'N_m']},
           'compare': ['x', 'y'], 'tol': {'h': 0.001, 'v': None}, 'known': None, 'points': []}
    raf = {'id': 'FR-RAF20-Circe', 'title': 'RGF93 v2b h → NGF-IGN69 (RAF20) vs IGN Circé 5.5.0', 'status': 'validated-by-official-tool',
           'group': 'France', 'pipeline': RAF20, 'compute': None, 'epsg': ['EPSG:9876'], 'io': {'input': ['lon_deg', 'lat_deg', 'h_m'], 'output': ['lon_deg', 'lat_deg', 'H_m']},
           'compare': ['none', 'none', 'h'], 'tol': {'h': None, 'v': 0.003}, 'known': None, 'points': []}
    out = [l93, raf]
    for zone in (43, 44):
        out.append({'id': f'FR-CC{zone}-Circe', 'title': f'RGF93 v2b → CC{zone} vs IGN Circé 5.5.0', 'status': 'validated-by-official-tool',
                    'group': 'France', 'pipeline': lcc_cc(zone), 'compute': None, 'epsg': [f'EPSG:{9800 + zone}'],
                    'io': {'input': ['lon_deg', 'lat_deg'], 'output': ['E_m', 'N_m']}, 'compare': ['x', 'y'],
                    'tol': {'h': 0.001, 'v': None}, 'known': None, 'points': []})
    for pid, lat, lon, h, l93xy, cc, alt in CIRCE_POINTS:
        l93['points'].append({'id': pid, 'input': [lon, lat], 'expected': list(l93xy), 'status': 'pass', 'source': src})
        raf['points'].append({'id': pid, 'input': [lon, lat, h], 'expected': [None, None, alt], 'status': 'pass', 'source': src})
        z, e, n = cc
        nxt = next(p for p in out if p['id'] == f'FR-CC{z}-Circe')
        nxt['points'].append({'id': pid, 'input': [lon, lat], 'expected': [e, n], 'status': 'pass', 'source': src})
    return out


N5 = 'us_noaa_nadcon5_'


def nadcon5_reverse(to27):
    """NAD27 / NAD83(1986) → NAD83(2011): the grids applied forward, in order."""
    steps = []
    if to27:
        steps.append(f'+step +proj=gridshift +grids={N5}nad27_nad83_1986_conus.tif')
    steps += [
        f'+step +proj=gridshift +grids={N5}nad83_1986_nad83_harn_conus.tif',
        f'+step +proj=gridshift +no_z_transform +grids={N5}nad83_harn_nad83_fbn_conus.tif',
        f'+step +proj=gridshift +no_z_transform +grids={N5}nad83_fbn_nad83_2007_conus.tif',
        f'+step +proj=gridshift +no_z_transform +grids={N5}nad83_2007_nad83_2011_conus.tif',
    ]
    return ' '.join(['+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad', *steps,
                     '+step +proj=unitconvert +xy_in=rad +xy_out=deg'])


def ncat_reverse_pairs():
    """The reverse NADCON5 directions, validated against NCAT (convert-collect-ncat-reverse.py)."""
    path = os.path.join(HERE, 'convert-extra-references.json')
    if not os.path.exists(path):
        return []
    extra = json.load(open(path))
    out = []
    for fwd_id, rows in extra['pairs'].items():
        to27 = fwd_id.endswith('NAD27')
        src = 'NAD27' if to27 else 'NAD83_1986'
        pts = []
        for r in rows:
            js = r['response']
            pts.append({'id': r['id'], 'input': r['input'], 'expected': [float(js['destLon']), float(js['destLat'])],
                        'status': 'pass', 'source': {'tool': extra['tool'], 'version': f"NCAT REST, NADCON {js.get('nadconVersion')}",
                                                     'date': extra['collected']}})
        out.append({'id': f'US-NADCON5-{src}-to-NAD83_2011', 'title': f'{src} → NAD83(2011) (NADCON5 CONUS) vs NOAA NCAT',
                    'status': 'validated-by-API', 'group': 'United States', 'pipeline': nadcon5_reverse(to27), 'compute': None,
                    'epsg': ['NAD27_TO_NAD83_2011_CONUS' if to27 else 'NAD83_TO_NAD83_2011_CONUS'],
                    'io': {'input': ['lon_deg', 'lat_deg'], 'output': ['lon_deg', 'lat_deg']}, 'compare': ['lon', 'lat'],
                    'tol': {'h': 0.001, 'v': None}, 'known': None, 'points': pts})
    return out


def clean_num(v):
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    ref = json.load(open(path))
    pairs = []
    for p in ref['pairs']:
        po = p['pinned_operation']
        kd = p.get('known_disagreement') or None
        q = {
            'id': p['pair_id'],
            'title': p['title'],
            'status': p.get('status'),
            'group': p.get('group'),
            'pipeline': po.get('pipeline'),
            'compute': po.get('compute'),
            'epsg': po.get('epsg') or [],
            'io': p['io'],
            'compare': p['compare'],
            'tol': {'h': p['tolerance_m'].get('h'), 'v': p['tolerance_m'].get('v')},
            'known': {'points': kd.get('points'), 'diagnosis': kd.get('diagnosis')} if kd else None,
            'points': [],
        }
        for pt in p['points']:
            src = pt.get('expected_source') or pt.get('model_source') or {}
            o = {
                'id': pt['id'],
                'input': [clean_num(x) for x in pt['input']],
                'expected': [clean_num(x) for x in pt['expected']],
                'status': pt.get('status'),
                'source': {k: src.get(k) for k in ('tool', 'version', 'date') if src.get(k)},
            }
            if pt.get('params'):
                o['params'] = pt['params']
            if pt.get('proj_result') is not None:
                o['proj'] = pt['proj_result']
            if pt.get('model_value') is not None:
                o['model'] = pt['model_value']
            q['points'].append(o)
        pairs.append(q)
    pairs.extend(circe_pairs())
    pairs.extend(ncat_reverse_pairs())
    meta = ref['_meta']
    out = {
        '_meta': {
            'generated_by': 'scripts/convert-fixtures.py',
            'source': 'research/validation/reference_points.json + validation-notes §9 (Circé)',
            'reference_run': meta.get('last_run'),
            'conventions': meta.get('conventions'),
        },
        'pairs': pairs,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')
    # A small index the app bundles (the 0.6 MB suite stays test-only): what
    # each pair was validated against, for the accuracy panel.
    index = {}
    for p in pairs:
        tools = sorted({q['source'].get('tool') for q in p['points'] if q['source'].get('tool')})
        st = [q['status'] for q in p['points']]
        index[p['id']] = {'title': p['title'], 'tools': tools, 'n': len(st), 'pass': st.count('pass'),
                          'known': st.count('fail-known'), 'diagnosis': (p['known'] or {}).get('diagnosis')}
    with open(os.path.join(os.path.dirname(OUT), 'index.json'), 'w') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')
    n = sum(len(p['points']) for p in pairs)
    print(f'{len(pairs)} pairs, {n} points → {os.path.relpath(OUT)} ({os.path.getsize(OUT) / 1e6:.2f} MB)')


if __name__ == '__main__':
    main()

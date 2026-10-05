#!/usr/bin/env python3
"""Tide stations + tidal benchmarks build steps (orchestrated by ../tides.sh).

    build.py sources
    build.py fetch     SRC RAW              per-source fetch (polite, resumable)
    build.py normalize SRC RAW NORM         → NORM/SRC.stations.ndjson, NORM/SRC.bms.ndjson (gated)
    build.py derive    NORM OUT CACHE       ellipsoidal CD + oracle checks → OUT/stations.ndjson, OUT/checks.json
    build.py join      NORM GEONORM OUT     tidal benchmarks → OUT/tidal_join.json (+ checks)
    build.py assemble  OUT                  → OUT/tides.geojsonl (tiles), OUT/tides-v1.json, OUT/tides-report.json;
                                              prints the TileJSON description

Gates (DESIGN §3.1): a source below its catalogue minimum, or down > 30 %
from its last good run, keeps last run's records. `derive` and `join` hide
anything an oracle does not confirm. CHS never appears: only catalogue
sources pass `assemble` (owner decision PLAN Q1 = c).
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.append(os.path.join(HERE, '..', 'geodetic'))  # after ours: geodetic has its own build/catalog
import catalog  # noqa: E402
from common import log, read_ndjson, valid_position, write_ndjson  # noqa: E402

TILE_KEYS_VERSION = 1


def _min_count(src):
    return catalog.SOURCES[catalog.SOURCE_INDEX[src]][8]


def cmd_fetch(src, raw):
    from fetch import FETCHERS  # noqa: PLC0415

    FETCHERS[src](os.path.join(raw, src))


def cmd_normalize(src, raw, norm):
    from normalize import NORMALIZERS  # noqa: PLC0415

    os.makedirs(norm, exist_ok=True)
    final_s = os.path.join(norm, f'{src}.stations.ndjson')
    final_b = os.path.join(norm, f'{src}.bms.ndjson')
    try:
        stations, bms = NORMALIZERS[src](os.path.join(raw, src))
    except Exception as e:  # noqa: BLE001 — a broken source keeps its last records
        log(f'{src}: normalize FAILED ({e!r}); keeping the previous records')
        return 0
    stations = [s for s in stations if valid_position(s['lat'], s['lng'])]
    prev_path = final_s + '.count'
    prev = int(open(prev_path).read()) if os.path.exists(prev_path) else 0
    n = len(stations)
    if n < _min_count(src) or (prev and n * 10 < prev * 7):
        log(f'{src}: {n} stations (min {_min_count(src)}, last {prev}) — gate FAILED; keeping the previous records')
        return 0
    write_ndjson(final_s, stations)
    write_ndjson(final_b, bms)
    open(prev_path, 'w').write(str(n))
    log(f'{src}: {n} stations, {len(bms)} published tidal benchmarks')
    return n


def _load_norm(norm, kind):
    out = []
    for key, *_ in catalog.SOURCES:
        p = os.path.join(norm, f'{key}.{kind}.ndjson')
        if os.path.exists(p):
            out.extend(read_ndjson(p))
    return out


def cmd_derive(norm, out, cache):
    from derive import Geoid, derive_all, summarize, vdatum_lookup  # noqa: PLC0415

    os.makedirs(out, exist_ok=True)
    stations = _load_norm(norm, 'stations')
    geoid = Geoid()

    def vdatum(rec):
        return vdatum_lookup(os.path.join(cache, 'vdatum'), rec['id'], rec['lng'], rec['lat'])

    checks = derive_all(stations, geoid, vdatum)
    write_ndjson(os.path.join(out, 'stations.ndjson'), stations)
    json.dump({'checks': checks, 'summary': summarize(checks)}, open(os.path.join(out, 'checks.json'), 'w'),
              ensure_ascii=False, indent=1)
    log(f'derive: {sum(1 for s in stations if s.get("ell"))} ellipsoidal CDs shown of {len(stations)} stations; '
        f'{json.dumps(summarize(checks))}')


def cmd_join(norm, geonorm, out):
    from join_geodetic import join, summarize, write  # noqa: PLC0415

    bms = _load_norm(norm, 'bms')
    joins, rows = join(bms, geonorm)
    write(joins, os.path.join(out, 'tidal_join.json'))
    json.dump({'rows': rows, 'summary': summarize(rows), 'published': len(bms)},
              open(os.path.join(out, 'join_checks.json'), 'w'), ensure_ascii=False, indent=1)


# ---------------------------------------------------------------- tile features

def _levels(rows):
    return ';'.join(f"{r['code']}={r['text']}" for r in rows)


def props(rec, ref=None):
    """Station → tile properties (decoded by src/core/tides/station.ts)."""
    p = {'i': rec['id'], 's': catalog.SOURCE_INDEX[rec['src']], 'n': rec['name'][:60], 'k': rec['kind'],
         'cn': rec['cd'], 'y': rec['lat'], 'x': rec['lng']}
    if rec.get('live'):
        p['lv'] = rec['live']
    if rec['levels']:
        p['L'] = _levels(rec['levels'])
    if rec['extremes']:
        p['X'] = ';'.join(f"{r['code']}={r['text']}@{r.get('date') or ''}" for r in rec['extremes'])
    nat = [n for n in rec['national'] if 'national-inconsistent' not in rec['flags']]
    if nat:
        p['D'] = ';'.join(f"{n['datum']}={n['text']}" for n in nat)
    e = rec.get('ell')
    if e:
        p['E'] = '|'.join([e['text'], e['frame'], e.get('epoch') or '', e['how'], e['checkedBy'],
                           f"{e['deltaM']:.3f}", e['basis']])
    for key, field in (('ep', 'epoch'), ('pd', 'published'), ('z', 'zone')):
        if rec.get(field):
            p[key] = str(rec[field])[:60]
    if rec.get('posAccM'):
        p['pa'] = int(rec['posAccM'])
    if rec['flags']:
        p['f'] = ','.join(rec['flags'])
    if rec.get('landUpliftCmYr'):
        p['lu'] = rec['landUpliftCmYr']
    if ref is not None:
        p['rp'] = ref['id']
        p['rpn'] = ref['name'][:60]
        p['rL'] = _levels(ref['levels'])
    return p


def _needs_ref(rec):
    codes = {lv['code'] for lv in rec['levels']}
    return not ({'HAT', 'LAT'} <= codes)


def feature(rec, ref=None):
    return json.dumps({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [rec['lng'], rec['lat']]},
                       'properties': props(rec, ref)}, ensure_ascii=False, separators=(',', ':'))


def cmd_assemble(out):
    stations = [s for s in read_ndjson(os.path.join(out, 'stations.ndjson')) if s['src'] in catalog.SOURCE_INDEX]
    by_uid = {s['uid']: s for s in stations}
    counts = {}
    with open(os.path.join(out, 'tides.geojsonl.tmp'), 'w', encoding='utf-8') as f:
        for s in stations:
            ref = None
            rp = (s.get('refPort') or {}).get('id')
            if rp and rp in by_uid and rp != s['uid'] and _needs_ref(s):
                ref = by_uid[rp]
            f.write(feature(s, ref) + '\n')
            c = counts.setdefault(s['src'], {'stations': 0, 'live': 0, 'ellipsoid': 0, 'national': 0})
            c['stations'] += 1
            c['live'] += 1 if s.get('live') else 0
            c['ellipsoid'] += 1 if s.get('ell') else 0
            c['national'] += 1 if s['national'] and 'national-inconsistent' not in s['flags'] else 0
    os.replace(os.path.join(out, 'tides.geojsonl.tmp'), os.path.join(out, 'tides.geojsonl'))
    # The worldwide side file (DESIGN §2.2) — the same records, kept with the build.
    side = {'v': 1, 'updated': time.strftime('%Y-%m-%d'), 'catalog': catalog.catalog(),
            'stations': [props(s) for s in stations]}
    json.dump(side, open(os.path.join(out, 'tides-v1.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    checks = json.load(open(os.path.join(out, 'checks.json'))) if os.path.exists(os.path.join(out, 'checks.json')) else {}
    jc = json.load(open(os.path.join(out, 'join_checks.json'))) if os.path.exists(os.path.join(out, 'join_checks.json')) else {}
    tidal = json.load(open(os.path.join(out, 'tidal_join.json'))) if os.path.exists(os.path.join(out, 'tidal_join.json')) else {}
    report = {'updated': side['updated'], 'sources': counts,
              'ellipsoidChecks': checks.get('summary', {}), 'benchmarkChecks': jc.get('summary', {}),
              'tidalBenchmarks': {'published': jc.get('published', 0), 'joined': len(tidal)}}
    json.dump(report, open(os.path.join(out, 'tides-report.json'), 'w'), ensure_ascii=False, indent=1)
    desc = {'v': 1, 'updated': side['updated'],
            'counts': {str(catalog.SOURCE_INDEX[k]): v['stations'] for k, v in counts.items()}}
    print(json.dumps(desc, separators=(',', ':')))


def attribution(out):
    report = json.load(open(os.path.join(out, 'tides-report.json')))
    return ' · '.join(s[4] for s in catalog.SOURCES if report['sources'].get(s[0], {}).get('stations'))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('sources')
    f = sub.add_parser('fetch')
    f.add_argument('src')
    f.add_argument('raw')
    n = sub.add_parser('normalize')
    n.add_argument('src')
    n.add_argument('raw')
    n.add_argument('norm')
    d = sub.add_parser('derive')
    d.add_argument('norm')
    d.add_argument('out')
    d.add_argument('cache')
    j = sub.add_parser('join')
    j.add_argument('norm')
    j.add_argument('geonorm')
    j.add_argument('out')
    a = sub.add_parser('assemble')
    a.add_argument('out')
    at = sub.add_parser('attribution')
    at.add_argument('out')
    c = sub.add_parser('catalog')
    c.add_argument('path')
    args = ap.parse_args()
    if args.cmd == 'sources':
        print(' '.join(s[0] for s in catalog.SOURCES))
    elif args.cmd == 'fetch':
        cmd_fetch(args.src, args.raw)
    elif args.cmd == 'normalize':
        cmd_normalize(args.src, args.raw, args.norm)
    elif args.cmd == 'derive':
        cmd_derive(args.norm, args.out, args.cache)
    elif args.cmd == 'join':
        cmd_join(args.norm, args.geonorm, args.out)
    elif args.cmd == 'assemble':
        cmd_assemble(args.out)
    elif args.cmd == 'attribution':
        print(attribution(args.out))
    else:
        catalog.write_json(args.path)


if __name__ == '__main__':
    main()

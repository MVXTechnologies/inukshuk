#!/usr/bin/env python3
"""Geodetic points build steps (orchestrated by ../geodetic.sh).

    build.py fetch     SRC RAW [--pieces pieces.json]
    build.py normalize SRC RAW NORM [--fiches QC_STATE_DIR]
    build.py assemble  NORM OUT          → OUT/geodetic.geojsonl, OUT/geodetic_osm.geojsonl,
                                           OUT/report.json; prints the description JSON
    build.py catalog   OUT.json          → the catalogue the app bundles

`normalize` gates each source (DESIGN.md §5.1 step 3): fewer live marks than
the catalogue's minimum, or a drop of more than 30 % since the last good run,
keeps last run's file (`NORM/SRC.ndjson`) and says so — a source that fails
never vanishes from the map.

`assemble` partitions every record by its z5 tile, then per partition: ID-first
dedupe, drop destroyed / not-found, ladder, tile features. Memory stays at one
partition's worth of records.
"""
import argparse
import json
import os
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import catalog  # noqa: E402
from common import log, read_ndjson, valid_position, write_ndjson  # noqa: E402
from dedupe import dedupe  # noqa: E402
from ladder import assign_minzoom, world_px  # noqa: E402
from tiles import feature_line  # noqa: E402

LIVE = ('ok', 'damaged', 'unknown')


def module_for(src):
    import importlib  # noqa: PLC0415

    name = {
        'qc-mrnf': 'qc', 'ca-nrcan': 'nrcan', 'us-ngs': 'ngs', 'osm': 'osm',
    }.get(src) or 'src_' + src.replace('-', '_')
    return importlib.import_module(name)


def available_sources():
    """Catalogue sources that have a module, in catalogue order."""
    out = []
    for key, *_ in catalog.SOURCES:
        try:
            module_for(key)
        except ImportError:
            continue
        out.append(key)
    return out


def attribution(sources):
    """The archive's combined credit line: each present source's, once, OSM last."""
    seen = []
    for key, *rest in catalog.SOURCES:
        if key in sources and sources[key].get('marks') and rest[3] not in seen:
            seen.append(rest[3])
    osm = catalog.SOURCES[catalog.OSM][4]
    if osm in seen:
        seen.remove(osm)
        seen.append(osm)
    return ' · '.join(seen)


def min_count(src):
    return catalog.SOURCES[catalog.SOURCE_INDEX[src]][7]


def cmd_fetch(src, raw, pieces):
    mod = module_for(src)
    out = os.path.join(raw, src)
    if src == 'osm':
        mod.fetch(out, pieces)
    else:
        mod.fetch(out)


def cmd_normalize(src, raw, norm, fiches_dir=None):
    mod = module_for(src)
    os.makedirs(norm, exist_ok=True)
    final = os.path.join(norm, f'{src}.ndjson')
    new = final + '.new'
    kwargs = {}
    if src == 'qc-mrnf' and fiches_dir and os.path.isdir(fiches_dir):
        from enrich_qc import load_fiches  # noqa: PLC0415

        kwargs['fiches'] = load_fiches(fiches_dir)
        log(f'{src}: {len(kwargs["fiches"])} harvested datasheets')
    try:
        records = (r for r in mod.normalize(os.path.join(raw, src), **kwargs)
                   if valid_position(r['lat'], r['lng']))
        total = write_ndjson(new, records)
    except Exception as e:  # noqa: BLE001 — a broken source keeps last month's records
        log(f'{src}: normalize FAILED ({e!r}); keeping the previous records')
        if os.path.exists(new):
            os.remove(new)
        return 0
    live = sum(1 for r in read_ndjson(new) if r['status'] in LIVE)
    prev_path = final + '.count'
    prev = int(open(prev_path).read()) if os.path.exists(prev_path) else 0
    if live < min_count(src) or (prev and live * 10 < prev * 7):
        log(f'{src}: {live} live marks (min {min_count(src)}, last {prev}) — gate FAILED; '
            f'keeping the previous records')
        os.remove(new)
        return 0
    os.replace(new, final)
    open(prev_path, 'w').write(str(live))
    log(f'{src}: {total} records, {live} live')
    return live


def _part_key(lat, lng):
    x, y = world_px(lat, lng, 5)
    return f'{int(x // 256)}_{int(y // 256)}'


def cmd_assemble(norm, out, tidal_path=None):
    # Tidal benchmarks (../tides/join_geodetic.py): geodetic uid → its chart-datum block.
    tidal = json.load(open(tidal_path)) if tidal_path and os.path.exists(tidal_path) else {}
    if tidal:
        log(f'assemble: {len(tidal)} tidal benchmarks to mark')
    tidal_marked = 0
    parts_dir = os.path.join(out, 'parts')
    shutil.rmtree(parts_dir, ignore_errors=True)
    os.makedirs(parts_dir)
    handles = {}
    sources_in = []
    for name in sorted(os.listdir(norm)):
        if not name.endswith('.ndjson'):
            continue
        src = name[:-len('.ndjson')]
        if src not in catalog.SOURCE_INDEX:
            continue
        sources_in.append(src)
        for line_rec in read_ndjson(os.path.join(norm, name)):
            key = _part_key(line_rec['lat'], line_rec['lng'])
            h = handles.get(key)
            if h is None:
                h = handles[key] = open(os.path.join(parts_dir, key + '.ndjson'), 'a', encoding='utf-8')
            h.write(json.dumps(line_rec, ensure_ascii=False, separators=(',', ':')) + '\n')
        log(f'assemble: partitioned {src}')
        for h in handles.values():
            h.close()
        handles = {}
    counts = {s: {'marks': 0, 'types': {}} for s in sources_in}
    merged, hist, vd_counts = {}, {}, {}
    official = open(os.path.join(out, 'geodetic.geojsonl.tmp'), 'w', encoding='utf-8')
    osm = open(os.path.join(out, 'geodetic_osm.geojsonl.tmp'), 'w', encoding='utf-8')
    for name in sorted(os.listdir(parts_dir)):
        records = list(read_ndjson(os.path.join(parts_dir, name)))
        kept = [r for r in dedupe(records, merged) if r['status'] in LIVE]
        for z, n in assign_minzoom(kept).items():
            hist[z] = hist.get(z, 0) + n
        for r in kept:
            t = tidal.get(r['uid'])
            if t is not None:
                r['tidal'] = t
                tidal_marked += 1
            (osm if r['src'] == 'osm' else official).write(feature_line(r) + '\n')
            c = counts[r['src']]
            c['marks'] += 1
            c['types'][r['type']] = c['types'].get(r['type'], 0) + 1
            for h in (r.get('hOrtho') or [])[:2]:
                i = catalog.VDATUM_INDEX.get(h.get('datum'))
                if i is not None:
                    vd_counts[i] = vd_counts.get(i, 0) + 1
        os.remove(os.path.join(parts_dir, name))
    official.close()
    osm.close()
    os.replace(os.path.join(out, 'geodetic.geojsonl.tmp'), os.path.join(out, 'geodetic.geojsonl'))
    os.replace(os.path.join(out, 'geodetic_osm.geojsonl.tmp'), os.path.join(out, 'geodetic_osm.geojsonl'))
    shutil.rmtree(parts_dir, ignore_errors=True)
    report = {
        'updated': time.strftime('%Y-%m-%d'),
        'total': sum(c['marks'] for c in counts.values()),
        'sources': counts,
        'minzoom': dict(sorted(hist.items())),
        'merged': dict(sorted(merged.items(), key=lambda kv: -kv[1])),
        'tidal': tidal_marked,
        'vdatums': {catalog.VDATUMS[i][0]: n for i, n in sorted(vd_counts.items())},
    }
    json.dump(report, open(os.path.join(out, 'report.json'), 'w'), indent=1, ensure_ascii=False)
    # What the app reads from the archive's TileJSON `description`: date + per-source counts.
    desc = {'v': 1, 'updated': report['updated'],
            'counts': {str(catalog.SOURCE_INDEX[s]): c['marks'] for s, c in counts.items()},
            # Marks with a height on each vertical datum: the filter's datum chips.
            'vd': {str(i): n for i, n in sorted(vd_counts.items())}}
    print(json.dumps(desc, separators=(',', ':')))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    f = sub.add_parser('fetch')
    f.add_argument('src')
    f.add_argument('raw')
    f.add_argument('--pieces')
    n = sub.add_parser('normalize')
    n.add_argument('src')
    n.add_argument('raw')
    n.add_argument('norm')
    n.add_argument('--fiches')
    a = sub.add_parser('assemble')
    a.add_argument('norm')
    a.add_argument('out')
    a.add_argument('--tidal')
    c = sub.add_parser('catalog')
    c.add_argument('out')
    sub.add_parser('sources')
    at = sub.add_parser('attribution')
    at.add_argument('report')
    args = ap.parse_args()
    if args.cmd == 'sources':
        print(' '.join(available_sources()))
        return
    if args.cmd == 'attribution':
        print(attribution(json.load(open(args.report))['sources']))
        return
    if args.cmd == 'fetch':
        cmd_fetch(args.src, args.raw, args.pieces)
    elif args.cmd == 'normalize':
        cmd_normalize(args.src, args.raw, args.norm, args.fiches)
    elif args.cmd == 'assemble':
        cmd_assemble(args.norm, args.out, args.tidal)
    else:
        catalog.write_json(args.out)


if __name__ == '__main__':
    main()

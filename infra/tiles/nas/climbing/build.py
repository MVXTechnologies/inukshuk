"""Climbing-crags pipeline entry point (run by ../climbing.sh in the
inukshuk-climbing-py image).

    build.py sources                                    the source keys
    build.py fetch SRC RAW_DIR [--pieces P]             fetch one source into RAW_DIR/SRC
    build.py normalize SRC RAW_DIR NORM_DIR [--takedowns T]
                                                        RAW → NORM_DIR/SRC.json, gated
    build.py assemble NORM_DIR OUT_DIR [--ne DIR] [--version V] [--takedowns T]
                                                        merge + publish files; prints
                                                        the one-line description
    build.py attribution                                the tiles' attribution line

Gate (normalize): a source whose record count is below its minimum, or more
than 30 % below its last good run, keeps its last good NORM_DIR/SRC.json (the
shell carries on with the other sources).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import c2c  # noqa: E402
import fetchers  # noqa: E402
import merge  # noqa: E402
import openbeta  # noqa: E402
import osm  # noqa: E402
import osm_fetch  # noqa: E402
import partners  # noqa: E402
import publish  # noqa: E402
from common import log, read_json, write_json  # noqa: E402

SOURCES = ['ob', 'osm', 'c2c']
# Crag records per source on the first world run (2026-10); far below means a
# short download or a broken parser, not climbers leaving.
MIN_RECORDS = {
    'ob': int(os.environ.get('CLIMBING_MIN_OB', '8000')),
    'osm': int(os.environ.get('CLIMBING_MIN_OSM', '3000')),
    'c2c': int(os.environ.get('CLIMBING_MIN_C2C', '2500')),
}


def load_takedowns(path):
    return read_json(path, {}) if path else {}


def normalize(src, raw_root, norm_dir, takedowns):
    raw = os.path.join(raw_root, src)
    if src == 'ob':
        path = fetchers.latest_openbeta(raw)
        if path is None:
            raise SystemExit('ob: no export on disk')
        log(f'ob: reading {os.path.basename(path)}')
        records = openbeta.normalize(openbeta.read_parquet(path), takedowns)
    elif src == 'osm':
        elements = []
        for name in sorted(os.listdir(raw)):
            if name.endswith('.json'):
                with open(os.path.join(raw, name), encoding='utf-8') as f:
                    elements.extend(json.load(f).get('elements', []))
        records = osm.normalize(elements, takedowns)
    elif src == 'c2c':
        records = c2c.normalize(os.path.join(raw, 'docs'), takedowns)
    else:
        raise SystemExit(f'unknown source {src}')
    count = len(records)
    routes = sum(len(s['routes']) for r in records for s in r.get('sectors') or [])
    prev = read_json(os.path.join(norm_dir, f'{src}.count.json'), {}).get('records', 0)
    log(f'{src}: {count} records, {routes} routes (last good: {prev})')
    if count < MIN_RECORDS[src]:
        log(f'{src}: {count} < minimum {MIN_RECORDS[src]}; keeping the last good records')
        return 1
    if prev and count * 10 < prev * 7:
        log(f'{src}: {count} is > 30 % below last good {prev}; keeping the last good records')
        return 1
    write_json(os.path.join(norm_dir, f'{src}.json'), records)
    write_json(os.path.join(norm_dir, f'{src}.count.json'), {'records': count, 'routes': routes})
    return 0


def assemble(norm_dir, out_dir, ne_dir, version, takedowns, raw_root=None):
    recs = {s: read_json(os.path.join(norm_dir, f'{s}.json'), []) for s in SOURCES}
    log('assemble: ' + ', '.join(f'{s} {len(v)}' for s, v in recs.items()))
    crags = merge.assemble(recs['ob'], recs['osm'], recs['c2c'], takedowns.get('crags') or [])
    sites = partners.load_fqme(raw_root) if raw_root else []
    if sites:
        log(f'fqme: {partners.apply_access(crags, sites)} crags take FQME access status')
    report = publish.publish(crags, out_dir, version, ne_dir)
    log(f"assemble: {report['crags']} crags, {report['routes']} routes, "
        f"{report['ordered_sectors']} ordered sectors, details {report['details_mb']} MB")
    print(publish.description(report))
    return 0


def main(argv):
    args = argv[1:]
    opts, pos = {}, []
    while args:
        a = args.pop(0)
        if a.startswith('--'):
            opts[a[2:]] = args.pop(0)
        else:
            pos.append(a)
    cmd = pos[0] if pos else None
    if cmd == 'sources':
        print('\n'.join(SOURCES))
        return 0
    if cmd == 'attribution':
        print(publish.attribution())
        return 0
    if cmd == 'fetch' and len(pos) == 3:
        src, raw = pos[1], os.path.join(pos[2], pos[1])
        if src == 'ob':
            fetchers.fetch_openbeta(raw)
        elif src == 'osm':
            osm_fetch.fetch(raw, opts['pieces'])
        elif src == 'c2c':
            fetchers.fetch_c2c(raw)
        else:
            raise SystemExit(f'unknown source {src}')
        return 0
    if cmd == 'normalize' and len(pos) == 4:
        return normalize(pos[1], pos[2], pos[3], load_takedowns(opts.get('takedowns')))
    if cmd == 'assemble' and len(pos) == 3:
        return assemble(
            pos[1], pos[2], opts.get('ne'), opts.get('version') or 'dev',
            load_takedowns(opts.get('takedowns')), opts.get('raw'),
        )
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))

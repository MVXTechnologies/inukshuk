#!/usr/bin/env python3
"""The DEM pipeline's steps (driven by ../dem.sh; README "Precise elevation (DEM)").

    dem.py mask      --region NAME --index coverage-index.pmtiles --coverage coverage.pmtiles
                     --mask OUT.json --geojson OUT.geojson [--bbox w,s,e,n]
    dem.py plan      --urls download_urls.json --geojson REGION.geojson   → "url minzoom maxzoom" lines
    dem.py transcode --mask M.json --out OUT.mbtiles --name NAME EXTRACT.pmtiles …
    dem.py verify    --mbtiles M --pmtiles P --name NAME --manifest OUT.json [--mask M.json]
    dem.py index     --version V --out dem.index.json MANIFEST.json …
    dem.py credits   --attribution attribution.json [--write TS | --check TS]

Python ≥ 3.9 + Pillow (the image in ./Dockerfile); everything else is the
standard library.
"""
import argparse
import hashlib
import json
import os
import random
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from coverage import Mask, build_cells, candidates  # noqa: E402
from pmtiles_lite import Reader  # noqa: E402

REGIONS = os.path.join(HERE, 'regions.json')


def log(msg):
    print(time.strftime('%F %T'), msg, file=sys.stderr, flush=True)


def load_regions(path=REGIONS):
    with open(path) as f:
        d = json.load(f)
    return d, {r['name']: r for r in d['regions']}


def parse_bbox(text):
    v = [float(a) for a in text.split(',')]
    if len(v) != 4 or not (v[0] < v[2] and v[1] < v[3]):
        raise argparse.ArgumentTypeError(f'bad bbox {text}')
    return v


# --- mask --------------------------------------------------------------------------

def cmd_mask(a):
    conf, regions = load_regions(a.regions)
    region = regions[a.region]
    bbox = a.bbox or region['bbox']
    allowed = set(region['sources'])
    pending = set(region.get('pendingValidation', {}).get('sources', []))
    wanted, seen = candidates(a.index, bbox, allowed)
    blocked = set()
    for sid, meta in sorted(seen.items()):
        fine = float(meta.get('resolution', 99)) <= conf['maxResolutionM']
        if fine and sid not in allowed:
            # Mapterhorn would draw it over an allowed source: carve it out.
            blocked.add(sid)
        if sid in pending:
            log(f'{sid}: pending validation (regions.json) — left out')
        elif sid not in allowed and fine:
            log(f'REVIEW: {sid} ({meta.get("name")}, {meta.get("resolution")} m) is in '
                f'{a.region} but not allow-listed in regions.json — left out')
    log(f'{a.region}: {len(wanted)} candidate macrotiles in {bbox}')
    cells = build_cells(a.coverage, wanted, allowed, bbox=bbox, blocked=blocked,
                        progress=lambda i, n, k: log(f'mask {i}/{n} ({k} with LiDAR cells)'))
    mask = Mask(cells)
    out = mask.to_json()
    # The bbox the Worker routes by: the macrotiles actually kept, not the request.
    out.update({'region': a.region, 'bbox': mask.bbox() or bbox, 'requestBbox': bbox,
                'sources': sorted(allowed), 'blocked': sorted(blocked)})
    write_json(a.mask, out)
    write_json(a.geojson, mask.region_geojson())
    log(f'{a.region}: {len(cells)} macrotiles, z16 tiles {mask.count(16)}, '
        f'z13 {mask.count(13)}, z12 {mask.count(12)}, z10 {mask.count(10)}')


def write_json(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f, separators=(',', ':'))
    os.replace(tmp, path)


# --- plan ----------------------------------------------------------------------------

def plan(urls, geojson):
    """Which Mapterhorn archives to extract for a region, with their zoom ranges."""
    rects = []
    for poly in geojson['geometry']['coordinates']:
        xs = [p[0] for p in poly[0]]
        ys = [p[1] for p in poly[0]]
        rects.append((min(xs), min(ys), max(xs), max(ys)))
    out = []
    for item in urls['items']:
        b = (item['min_lon'], item['min_lat'], item['max_lon'], item['max_lat'])
        if not any(r[0] < b[2] and r[2] > b[0] and r[1] < b[3] and r[3] > b[1] for r in rects):
            continue
        if item['name'] == 'planet.pmtiles':
            out.append((item['url'], 0, min(12, item['max_zoom'])))
        elif item['max_zoom'] >= 13:
            out.append((item['url'], max(13, item['min_zoom']), min(15, item['max_zoom'])))
    return out


def cmd_plan(a):
    urls = json.load(open(a.urls))
    for url, z0, z1 in plan(urls, json.load(open(a.geojson))):
        print(url, z0, z1)


# --- transcode -----------------------------------------------------------------------

def cmd_transcode(a):
    from transcode import run
    meta = {'name': a.name, 'format': 'png', 'type': 'baselayer',
            'attribution': '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>',
            'description': 'Terrarium-encoded terrain, 256 px, from Mapterhorn (LiDAR-masked)'}
    mask = json.load(open(a.mask))
    w, s, e, n = mask['bbox']
    meta['bounds'] = f'{w},{s},{e},{n}'
    meta['center'] = f'{(w + e) / 2},{(s + n) / 2},12'
    run(mask, a.inputs, a.out, meta, jobs=a.jobs, log=log)


# --- verify --------------------------------------------------------------------------

def sha256_file(path, chunk=8 << 20):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            b = f.read(chunk)
            if not b:
                return h.hexdigest()
            h.update(b)


def pixel_sha(png):
    from PIL import Image
    import io
    img = Image.open(io.BytesIO(png))
    img.load()
    return hashlib.sha256(img.tobytes()).hexdigest()


def verify(mbtiles, pmtiles, mask=None, samples=4000, seed=7):
    """Check the PMTiles archive against the MBTiles it was converted from: same tile
    count, PNG type, uncompressed tiles; `samples` random tiles + every tile at
    z ≤ 12 byte-identical, decoding to the pixels recorded (sha256) when their
    Mapterhorn quadrant was cut, and inside the LiDAR mask (given the mask)."""
    db = sqlite3.connect(mbtiles)
    count = db.execute('SELECT COUNT(*) FROM tiles').fetchone()[0]
    if count == 0:
        raise SystemExit(f'{mbtiles}: no tiles')
    z0, z1 = db.execute('SELECT MIN(zoom_level), MAX(zoom_level) FROM tiles').fetchone()
    rows = [r[0] for r in db.execute('SELECT rowid FROM tiles')]
    rng = random.Random(seed)
    pick = set(rng.sample(rows, min(samples, len(rows))))
    pick |= {r[0] for r in db.execute('SELECT rowid FROM tiles WHERE zoom_level <= 12')}
    with Reader(pmtiles) as r:
        h = r.header
        problems = []
        if h['tile_type'] != 'png':
            problems.append(f'tile type {h["tile_type"]}')
        if h['tile_compression'] not in (0, 1):
            problems.append(f'tile compression {h["tile_compression"]} (must be none)')
        if h['addressed_tiles'] != count:
            problems.append(f'{h["addressed_tiles"]} tiles addressed, MBTiles has {count}')
        if (h['min_zoom'], h['max_zoom']) != (z0, z1):
            problems.append(f'zooms {h["min_zoom"]}-{h["max_zoom"]} vs {z0}-{z1}')
        m = Mask.from_json(mask) if mask else None
        checked = 0
        for rowid in sorted(pick):
            z, x, row, data = db.execute(
                'SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles WHERE rowid=?',
                (rowid,)).fetchone()
            y = (1 << z) - 1 - row
            got = r.get(z, x, y)
            if got != data:
                problems.append(f'tile {z}/{x}/{y} differs')
            elif pixel_sha(got) != db.execute(
                    'SELECT sha256 FROM pixels WHERE zoom_level=? AND tile_column=? AND tile_row=?',
                    (z, x, row)).fetchone()[0]:
                problems.append(f'tile {z}/{x}/{y}: pixels differ from the source quadrant')
            if m is not None and not m.qualifies(z, x, y):
                problems.append(f'tile {z}/{x}/{y} is outside the LiDAR mask')
            checked += 1
            if len(problems) > 20:
                break
        # A deepest-zoom tile for dem.sh to fetch back through the live Worker.
        pz, px, prow, pdata = db.execute(
            'SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles '
            'WHERE zoom_level = ? ORDER BY tile_column, tile_row LIMIT 1', (z1,)).fetchone()
        probe = {'tile': [pz, px, (1 << pz) - 1 - prow],
                 'sha256': hashlib.sha256(pdata).hexdigest()}
    db.close()
    if problems:
        raise SystemExit(f'{pmtiles}: ' + '; '.join(problems[:20]))
    return {'tiles': count, 'checked': checked, 'minzoom': z0, 'maxzoom': z1,
            'bounds': list(h['bounds']), 'probe': probe}


def cmd_verify(a):
    mask = json.load(open(a.mask)) if a.mask else None
    result = verify(a.mbtiles, a.pmtiles, mask, a.samples)
    manifest = {
        'name': a.name,
        'bytes': os.path.getsize(a.pmtiles),
        'sha256': sha256_file(a.pmtiles),
        'tiles': result['tiles'],
        'minzoom': result['minzoom'],
        'maxzoom': result['maxzoom'],
        'bbox': mask['bbox'] if mask else result['bounds'],
        'sources': mask['sources'] if mask else [],
        'probe': result['probe'],
    }
    write_json(a.manifest, manifest)
    log(f'{a.pmtiles}: verified {result["checked"]} of {result["tiles"]} tiles; '
        f'sha256 {manifest["sha256"][:16]}…')


# --- index ---------------------------------------------------------------------------

def make_index(manifests, version, built):
    pieces = []
    for m in manifests:
        if m['tiles'] <= 0:
            raise SystemExit(f'{m["name"]}: empty archive, refusing to publish it')
        pieces.append({k: m[k] for k in
                       ('name', 'bbox', 'minzoom', 'maxzoom', 'bytes', 'sha256', 'tiles', 'sources')})
    names = [p['name'] for p in pieces]
    if len(set(names)) != len(names):
        raise SystemExit('duplicate piece names')
    return {'format': 'terrarium-png-256', 'mapterhorn': version, 'built': built,
            'pieces': pieces}


def cmd_index(a):
    manifests = [json.load(open(p)) for p in a.manifests]
    write_json(a.out, make_index(manifests, a.version,
                                 time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())))
    log(f'index: {len(manifests)} pieces → {a.out}')


# --- credits -------------------------------------------------------------------------

def cmd_credits(a):
    from credits import check_ts, render_ts
    conf, _ = load_regions(a.regions)
    attribution = json.load(open(a.attribution))
    if a.write:
        with open(a.write, 'w') as f:
            f.write(render_ts(conf, attribution))
        log(f'credits → {a.write} (run prettier on it)')
    if a.check:
        missing = check_ts(conf, open(a.check).read())
        if missing:
            raise SystemExit(f'{a.check} does not credit {", ".join(missing)}: '
                             'regenerate it (dem.py credits --write) and ship it in the app')
        log(f'{a.check}: every served source is credited')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--regions', default=REGIONS)
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('mask')
    p.add_argument('--region', required=True)
    p.add_argument('--index', required=True)
    p.add_argument('--coverage', required=True)
    p.add_argument('--mask', required=True)
    p.add_argument('--geojson', required=True)
    p.add_argument('--bbox', type=parse_bbox)
    p.set_defaults(fn=cmd_mask)

    p = sub.add_parser('plan')
    p.add_argument('--urls', required=True)
    p.add_argument('--geojson', required=True)
    p.set_defaults(fn=cmd_plan)

    p = sub.add_parser('transcode')
    p.add_argument('--mask', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--name', required=True)
    p.add_argument('--jobs', type=int)
    p.add_argument('inputs', nargs='+')
    p.set_defaults(fn=cmd_transcode)

    p = sub.add_parser('verify')
    p.add_argument('--mbtiles', required=True)
    p.add_argument('--pmtiles', required=True)
    p.add_argument('--name', required=True)
    p.add_argument('--manifest', required=True)
    p.add_argument('--mask')
    p.add_argument('--samples', type=int, default=4000)
    p.set_defaults(fn=cmd_verify)

    p = sub.add_parser('index')
    p.add_argument('--version', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('manifests', nargs='+')
    p.set_defaults(fn=cmd_index)

    p = sub.add_parser('credits')
    p.add_argument('--attribution', required=True)
    p.add_argument('--write')
    p.add_argument('--check')
    p.set_defaults(fn=cmd_credits)

    a = ap.parse_args(argv)
    a.fn(a)


if __name__ == '__main__':
    main()

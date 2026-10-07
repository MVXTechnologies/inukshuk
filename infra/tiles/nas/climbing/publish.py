"""Assembled crags → the published files (DESIGN.md §2.2, §2.3, §5):

- crags.geojsonl / route_starts.geojsonl, for tippecanoe (crags.pmtiles);
- climbing-{version}.details.bin + .offsets.json: one topo per crag (the
  trails format: one object, range-read by the Worker);
- climbing-v1.index.json: name search for the whole world;
- report.json: coverage per source, for the logs and Settings → Coverage.

Tile record (layer `crags`): i uid, n name, r routes, s sectors, st style
bits, b band counts "easy,mid,hard,elite", g0/g1 rope ladder min/max, v0/v1
boulder, w0/w1 ice (grades.py), a access code (absent = unknown), src source
bits, ord 1 when a sector has a left-to-right order, ap approach minutes, rg
region, v detail version. Layer `route_starts` (OSM only, z14+): n, g, c
crag uid, o number in its sector when ordered, bd band.
"""
import hashlib
import json
import os
import sys
import time
import zlib

import grades
from common import ACCESS_CODE, LICENCES, SOURCE_BITS, STYLE_BITS, STYLES, write_json
from ladder import assign_minzoom

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BLOCKED_LINK_HOSTS = (
    'mountainproject.com', 'adventureprojects.net', 'thecrag.com', '27crags.com', 'thetopo.com',
    'vertical-life.info', '8a.nu', 'ukclimbing.com', 'kayaclimb.com', 'sendage.com',
)
FQME_MAP = 'https://fqme.qc.ca/carte/'
DETAIL_SCHEMA = 1


class _NoRegions:
    admin1 = []
    names = {}

    def country(self, pt):
        return None

    def region(self, pt):
        return None


def load_regions(ne_dir):
    if not ne_dir or not os.path.isdir(ne_dir):
        return _NoRegions()
    from trails_build import Regions

    return Regions(ne_dir)


def _all_routes(crag):
    return [r for s in crag.get('sectors') or [] for r in s['routes']]


def summarize(crag):
    """Counts, styles, bands and grade ranges, from the routes."""
    routes = _all_routes(crag)
    styles = {k: 0 for k in STYLES}
    bands = [0, 0, 0, 0]
    ranges = {}
    st_bits = 0
    for r in routes:
        st = r.get('st', 0)
        st_bits |= st
        for name, bit in STYLE_BITS.items():
            if st & bit:
                styles[name] += 1
        k, x = r.get('k'), r.get('x')
        if k is not None and x is not None:
            bands[grades.band(k, x)] += 1
            lo, hi = ranges.get(k, (x, x))
            ranges[k] = (min(lo, x), max(hi, x))
    for s in crag.get('sectors') or []:
        st_bits |= s.get('st', 0)
    if crag.get('boulder'):
        st_bits |= STYLE_BITS['boulder']
    # A crag with no route list (camptocamp only) still has its rating range.
    if not routes and crag.get('min') and crag.get('max'):
        lo, hi = grades.french_index(crag['min']), grades.french_index(crag['max'])
        if lo is not None and hi is not None:
            ranges['r'] = (lo, hi)
    return {
        'routes': len(routes),
        'styles': {k: v for k, v in styles.items() if v},
        'st': st_bits,
        'bands': bands,
        'ranges': ranges,
    }


def links_for(crag, cc, admin1):
    """Link-outs in the owner's order (PLAN Q4): FQME first in Québec, then
    camptocamp, then the crag's own website. Never Mountain Project (nor the
    other platforms whose terms forbid reuse)."""
    out = []
    if cc == 'CA' and admin1 in ('Québec', 'Quebec'):
        out.append({'kind': 'access', 'url': FQME_MAP, 'src': 'fqme'})
    if crag.get('c2c'):
        out.append({'kind': 'info', 'url': crag['c2c'], 'src': 'c2c'})
    site = crag.get('website')
    if site and not any(h in site for h in BLOCKED_LINK_HOSTS):
        out.append({'kind': 'info', 'url': site, 'src': 'web'})
    return out


def sources_of(crag):
    """Which open sources this topo is built from, with their licence and role."""
    out = []
    secs = crag.get('sectors') or []
    ob = [s for s in secs if s['src'] == 'ob']
    osm = [s for s in secs if s['src'] == 'osm']
    if crag['uid'].startswith('ob-') or ob:
        out.append({'src': 'ob', 'role': 'routes' if ob else 'crag', **LICENCES['ob']})
    if osm or crag['uid'].startswith('osm-') or crag.get('osm'):
        o = {'src': 'osm', 'role': 'routes' if osm else 'crag', **LICENCES['osm']}
        out.append(o)
    if crag.get('c2c'):
        role = 'approach' if crag.get('approach', {}).get('src') == 'c2c' else 'crag'
        out.append({'src': 'c2c', 'role': role, **LICENCES['c2c'], 'page': crag['c2c']})
    return out


def detail_doc(crag, summary, place):
    secs = []
    for s in crag.get('sectors') or []:
        sec = {'n': s['n'], 'src': s['src'], 'ordered': bool(s['ordered']), 'routes': s['routes']}
        if s.get('pt'):
            sec['pt'] = s['pt']
        if s.get('osm'):
            sec['osm'] = s['osm']
        secs.append(sec)
    doc = {
        'schema': DETAIL_SCHEMA,
        'uid': crag['uid'],
        'name': crag['name'],
        'lat': crag['lat'],
        'lng': crag['lng'],
        'routeCount': summary['routes'] or crag.get('declared') or 0,
        'listed': summary['routes'],
        'styles': summary['styles'],
        'bands': summary['bands'],
        'grades': {k: list(v) for k, v in summary['ranges'].items()},
        'sectors': secs,
        'access': crag.get('access') or {'status': 'unknown'},
        'links': links_for(crag, place.get('cc'), place.get('admin1')),
        'sources': sources_of(crag),
        'aliases': sorted(set(crag.get('alias') or [])),
    }
    names = dict(crag.get('names') or {})
    for lang in ('fr', 'en'):
        if crag.get(f'name_{lang}') and crag[f'name_{lang}'] != crag['name']:
            names[lang] = crag[f'name_{lang}']
    if names:
        doc['names'] = names
    for k in ('rock', 'aspect', 'height', 'approach'):
        if crag.get(k):
            doc[k] = crag[k]
    for k in ('region', 'admin1', 'country', 'cc'):
        v = crag.get('region') if k == 'region' else place.get(k)
        if v:
            doc[k] = v
    if crag.get('declared') and not summary['routes']:
        doc['declared'] = crag['declared']
    blob = json.dumps(doc, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    doc['v'] = hashlib.sha1(blob.encode('utf-8')).hexdigest()[:8]
    return doc


def tile_feature(crag, summary, doc):
    p = {
        'i': crag['uid'],
        'n': crag['name'],
        'r': doc['routeCount'],
        's': len(doc['sectors']),
        'b': ','.join(str(n) for n in summary['bands']),
        'v': doc['v'],
    }
    if summary['st']:
        p['st'] = summary['st']
    for k, (lo_key, hi_key) in {'r': ('g0', 'g1'), 'b': ('v0', 'v1'), 'i': ('w0', 'w1')}.items():
        if k in summary['ranges']:
            p[lo_key], p[hi_key] = summary['ranges'][k]
    status = doc['access'].get('status')
    if status in ACCESS_CODE:
        p['a'] = ACCESS_CODE[status]
    src = 0
    for s in doc['sources']:
        src |= SOURCE_BITS.get(s['src'], 0)
    p['src'] = src
    if any(s['ordered'] for s in doc['sectors']):
        p['ord'] = 1
    if doc.get('approach', {}).get('min'):
        p['ap'] = doc['approach']['min']
    rg = doc.get('region') or doc.get('admin1')
    if rg:
        p['rg'] = rg[:48]
    return {
        'type': 'Feature',
        'tippecanoe': {'minzoom': crag['minzoom']},
        'geometry': {'type': 'Point', 'coordinates': [crag['lng'], crag['lat']]},
        'properties': p,
    }


def route_start_features(doc):
    for s in doc['sectors']:
        if s['src'] != 'osm':
            continue
        for i, r in enumerate(s['routes']):
            if 'pos' not in r:
                continue
            p = {'n': r['n'][:60], 'c': doc['uid']}
            if r.get('g'):
                p['g'] = r['g']
            if s['ordered']:
                p['o'] = i + 1
            b = grades.band(r.get('k'), r.get('x'))
            if b is not None:
                p['bd'] = b
            yield {
                'type': 'Feature',
                'tippecanoe': {'minzoom': 14},
                'geometry': {'type': 'Point', 'coordinates': r['pos']},
                'properties': p,
            }


def place_of(crag, regions, cache):
    key = (round(crag['lat'], 2), round(crag['lng'], 2))
    if key not in cache:
        pt = (crag['lng'], crag['lat'])
        c = regions.country(pt)
        cache[key] = {
            'cc': c[0] if c else None,
            'country': c[1] if c else None,
            'admin1': regions.region(pt),
        }
    return cache[key]


def publish(crags, out_dir, version, ne_dir=None):
    regions = load_regions(ne_dir)
    cache = {}
    assign_minzoom(crags)
    os.makedirs(out_dir, exist_ok=True)
    offsets = {}
    rows = []
    aliases = {}
    report = {
        'version': version,
        'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'crags': 0,
        'routes': 0,
        'ordered_sectors': 0,
        'closed': 0,
        'by_source': {k: {'crags': 0, 'routes': 0} for k in ('ob', 'osm', 'c2c')},
        'countries': {},
    }
    bin_path = os.path.join(out_dir, f'climbing-{version}.details.bin')
    seen = set()
    with open(bin_path + '.tmp', 'wb') as fb, \
            open(os.path.join(out_dir, 'crags.geojsonl'), 'w', encoding='utf-8') as fc, \
            open(os.path.join(out_dir, 'route_starts.geojsonl'), 'w', encoding='utf-8') as fr:
        pos = 0
        for crag in sorted(crags, key=lambda c: c['uid']):
            if crag['uid'] in seen:
                continue
            seen.add(crag['uid'])
            summary = summarize(crag)
            place = place_of(crag, regions, cache)
            doc = detail_doc(crag, summary, place)
            data = json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            fb.write(data)
            offsets[crag['uid']] = [pos, len(data)]
            pos += len(data)
            fc.write(json.dumps(tile_feature(crag, summary, doc), ensure_ascii=False) + '\n')
            for f in route_start_features(doc):
                fr.write(json.dumps(f, ensure_ascii=False) + '\n')
            rows.append([
                crag['uid'], crag['name'], round(crag['lng'], 5), round(crag['lat'], 5),
                (doc.get('region') or doc.get('admin1') or '')[:48], place.get('cc') or '',
                doc['routeCount'],
            ])
            for a in doc['aliases']:
                if a != crag['uid']:
                    aliases[a] = crag['uid']
            report['crags'] += 1
            report['routes'] += summary['routes']
            report['ordered_sectors'] += sum(1 for s in doc['sectors'] if s['ordered'])
            if doc['access'].get('status') in ('closed', 'banned'):
                report['closed'] += 1
            for s in doc['sources']:
                report['by_source'][s['src']]['crags'] += 1
            for s in doc['sectors']:
                report['by_source'][s['src']]['routes'] += len(s['routes'])
            cc = place.get('cc') or '??'
            report['countries'][cc] = report['countries'].get(cc, 0) + 1
    os.replace(bin_path + '.tmp', bin_path)
    report['details_mb'] = round(pos / 1e6, 2)
    write_json(os.path.join(out_dir, f'climbing-{version}.offsets.json'), offsets)
    index = {
        'schema': 1,
        'generated': report['generated'],
        'details': version,
        'attribution': attribution(),
        'cols': ['i', 'n', 'lng', 'lat', 'rg', 'cc', 'r'],
        'rows': rows,
        'aliases': aliases,
    }
    write_json(os.path.join(out_dir, 'climbing-v1.index.json'), index)
    report['countries'] = dict(sorted(report['countries'].items(), key=lambda kv: -kv[1]))
    write_json(os.path.join(out_dir, 'report.json'), report, pretty=True)
    return report


def attribution():
    return 'OpenBeta (CC0) · © OpenStreetMap contributors (ODbL) · camptocamp.org (CC BY-SA)'


def description(report):
    """One line for the TileJSON (`/crags.json` description): Settings → Coverage."""
    return json.dumps(
        {
            'crags': report['crags'],
            'routes': report['routes'],
            'version': report['version'],
            'ordered': report['ordered_sectors'],
            'sources': report['by_source'],
        },
        separators=(',', ':'),
    )


def crc(uid):
    return zlib.crc32(uid.encode())

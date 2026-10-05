"""Partner data slots (DESIGN.md §9). NOTHING here is read today.

FQME (Fédération québécoise de la montagne et de l'escalade) holds the
authoritative access status of Québec's sites (open / restricted / closed /
banned), approach notes, emergency plans and the link to each site's topo.
Its data is all rights reserved: it is used ONLY once FQME has agreed in
writing. Until then `load_fqme` returns nothing, whatever is on disk, and
every Québec crag's access stays "unknown — check FQME".

When the agreement lands: the fetcher writes raw/fqme/sites.json as
[{"id", "name", "lat", "lng", "status", "note"?, "url"?, "approach"?}], the
owner sets CLIMBING_FQME_AGREEMENT=signed in climbing.sh, and `apply_access`
puts FQME's word above every other source (FQME > OpenBeta "(Closed)" >
OSM access tags > unknown). No app release is needed: the app already reads
`access.status`, `access.src`, `access.url` and `links`.
"""
import json
import os

from common import haversine_m, jaro_winkler, name_key

STATUSES = ('open', 'restricted', 'closed', 'banned')
MATCH_M = 1500.0
NEAR_M = 300.0
FQME_MAP = 'https://fqme.qc.ca/carte/'


def load_fqme(raw_dir):
    if os.environ.get('CLIMBING_FQME_AGREEMENT') != 'signed':
        return []
    path = os.path.join(raw_dir, 'fqme', 'sites.json')
    if not os.path.exists(path):
        return []
    with open(path, encoding='utf-8') as f:
        return [s for s in json.load(f) if s.get('status') in STATUSES]


def _match(crag, sites):
    best, best_score = None, 0.0
    for s in sites:
        d = haversine_m(crag['lat'], crag['lng'], s['lat'], s['lng'])
        if d > MATCH_M:
            continue
        jw = jaro_winkler(name_key(crag['name']), name_key(s['name']))
        score = jw if jw >= 0.85 else (0.5 if d <= NEAR_M else 0.0)
        if score > best_score:
            best, best_score = s, score
    return best


def apply_access(crags, sites, partner='fqme'):
    """Partner status overrides the open sources' (it is the authority)."""
    hits = 0
    for c in crags:
        s = _match(c, sites) if sites else None
        if s is None:
            continue
        acc = {'status': s['status'], 'src': partner}
        if s.get('note'):
            acc['note'] = s['note']
        if s.get('url'):
            acc['url'] = s['url']
        c['access'] = acc
        if s.get('url'):
            c.setdefault('links', [])
            c['links'] = [l for l in c['links'] if l.get('src') != partner]
            c['links'].insert(0, {'kind': 'topo', 'url': s['url'], 'src': partner})
        if s.get('approach'):
            c['approach'] = {'text': {'fr': s['approach']}, 'src': partner, 'url': s.get('url')}
        hits += 1
    return hits

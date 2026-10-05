"""Tidal benchmarks → the geodetic-points layer (DESIGN §2.1), ID first.

A tidal benchmark is a survey mark with a height above chart datum published
by a hydrographic office. It is not a new layer: the geodetic record of the
same mark gains a `tidal` block, which tiles.py writes as `cd` / `cs` / `cN` /
`cn` / `cdt` / `cm`, and the map draws it with the tidal symbol.

Join rules:
- NOAA CO-OPS sheet → NGS by PID (the sheet prints the NGS PID; exact).
- SHOM RAM reference mark → IGN by name (`rf` = IGN `nom`, normalized),
  within NEAR_M of the RAM site.

Check (DESIGN §3.1 step 3, the sign convention on real marks): the CD height
plus the station's published CD_in_X must land on the geodetic agency's own
levelled height of the same mark within TOL_M. A mark beyond it is NOT joined
(it may have moved, or be the wrong mark) and is listed in the report. A
name join with no levelled height to check is not joined either; a PID join
(exact identity) is joined and marked unchecked.

The CD height is never written into `hOrtho`: the heights stay separate.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.join(HERE, '..', 'geodetic'))  # after ours: geodetic has its own build/catalog
from common import haversine_m, log, norm_id, read_ndjson  # noqa: E402

TOL_M = 0.10
NEAR_M = 15000.0


def _levelled(rec, datum):
    for h in rec.get('hOrtho') or []:
        if h.get('datum') == datum:
            return h['value']
    return None


def join(bms, norm_dir):
    """→ (joins {geodetic uid: tidal}, rows [check rows for the report])."""
    by_pid = {b['joinKey']['id']: b for b in bms if b['joinKey']['src'] == 'us-ngs' and b['joinKey'].get('id')}
    by_name = {}
    for b in bms:
        if b['joinKey']['src'] == 'fr-ign':
            by_name.setdefault(norm_id(b['joinKey']['name']), []).append(b)
    found = {}  # bm identity → (record, bm)
    for src, wanted in (('us-ngs', by_pid), ('fr-ign', by_name)):
        path = os.path.join(norm_dir, f'{src}.ndjson')
        if not wanted or not os.path.exists(path):
            log(f'join: {src}: nothing to join ({"no file" if wanted else "no marks"})')
            continue
        for rec in read_ndjson(path):
            if src == 'us-ngs':
                b = wanted.get(rec['id'])
                if b is not None:
                    found[(src, rec['id'])] = (rec, b)
                continue
            keys = {norm_id(a) for a in [rec.get('name') or ''] + list(rec.get('aliases') or []) if a}
            for k in keys:
                for b in wanted.get(k, ()):
                    d = haversine_m(rec['lat'], rec['lng'], b['lat'], b['lng'])
                    if d > NEAR_M:
                        continue
                    ident = (src, b['station'], k)
                    prev = found.get(ident)
                    if prev is None or d < haversine_m(prev[0]['lat'], prev[0]['lng'], b['lat'], b['lng']):
                        found[ident] = (rec, b)
    joins, rows = {}, []
    for (src, *_), (rec, b) in found.items():
        chk = b.get('nationalCheck')
        lev = _levelled(rec, chk['datum']) if chk else None
        row = {'mark': rec['uid'], 'id': rec['id'], 'name': rec.get('name'), 'station': b['station'],
               'cd': b['cdText'], 'datum': chk['datum'] if chk else None,
               'fromCd': chk['value'] if chk else None, 'levelled': lev}
        if lev is not None and chk is not None:
            row['delta'] = round(chk['value'] - lev, 4)
            row['pass'] = abs(row['delta']) <= TOL_M
        else:
            row['pass'] = None
        rows.append(row)
        accept = row['pass'] is True or (row['pass'] is None and src == 'us-ngs')
        if not accept:
            continue
        t = {'cd': b['cdText'], 'cs': b['station'], 'cN': b['stationName'], 'cn': b['cd']}
        if b.get('date'):
            t['cdt'] = str(b['date'])[:10]
        if b.get('alsoMHW'):
            t['cm'] = b['alsoMHW']
        if row['pass'] is None:
            t['cu'] = 1  # identity by PID, no levelled height to check against
        # One mark can be the reference of two neighbouring sites: keep the nearer station.
        d = haversine_m(rec['lat'], rec['lng'], b['lat'], b['lng'])
        if rec['uid'] in joins and joins[rec['uid']]['_d'] <= d:
            continue
        t['_d'] = d
        joins[rec['uid']] = t
    for t in joins.values():
        t.pop('_d', None)
    log(f'join: {len(joins)} tidal benchmarks joined of {len(bms)} published '
        f'({sum(1 for r in rows if r["pass"] is False)} rejected by the height check)')
    return joins, rows


def summarize(rows):
    out = {}
    for r in rows:
        key = r['station'].split(':')[0]
        s = out.setdefault(key, {'matched': 0, 'checked': 0, 'pass': 0, 'fail': 0, 'unchecked': 0, 'd': []})
        s['matched'] += 1
        if r['pass'] is None:
            s['unchecked'] += 1
            continue
        s['checked'] += 1
        s['pass' if r['pass'] else 'fail'] += 1
        s['d'].append((abs(r['delta']), r['pass']))
    for s in out.values():
        d = sorted(s.pop('d'))
        s['maxAbsDeltaM'] = round(d[-1][0], 4) if d else None
        s['medianAbsDeltaM'] = round(d[len(d) // 2][0], 4) if d else None
        ok = [x for x, p in d if p]
        s['maxAbsDeltaShownM'] = round(ok[-1], 4) if ok else None
    return out


def write(joins, path):
    tmp = path + '.tmp'
    json.dump(joins, open(tmp, 'w'), ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, path)

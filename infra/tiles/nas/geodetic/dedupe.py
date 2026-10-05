"""De-duplication across sources (DESIGN.md §4): ID first, distance second.

Records are walked in precedence order (the authority of a jurisdiction
first, GNSS lists after, OpenStreetMap last). A record joins an already kept
one — and is dropped — when:

1. an ID matches (its id or an alias against the kept record's id or
   aliases, normalized), from another source, within ID_MATCH_M — NRCan
   publishes benchmarks tens of metres off their MRNF twin, so distance
   alone would fail; or
2. it lies within SAME_M of a kept mark of the same type; or within NEAR_M
   when the names match or the orthometric heights agree within 5 cm on the
   same datum. A benchmark (v) never merges into a trig mark (h) on
   distance alone; or
3. it is OpenStreetMap and lies within NEAR_M of any type-compatible kept mark.

Nothing is copied between records: the kept record stays one agency's data
(and no ODbL attribute reaches an official record). The kept record's
status wins, so an OSM or federal twin can never bring back a mark the
provincial agency has destroyed.
"""
import math

from common import haversine_m, norm_id

PRECEDENCE = [
    'qc-mrnf', 'ca-nrcan', 'us-ngs',
    'fr-ign', 'ch-swisstopo', 'ch-cantons', 'uk-os-trig', 'uk-os-bm', 'es-ign', 'nl-rws',
    'nl-kadaster', 'no-kartverket', 'at-bev', 'de-nw', 'de-mv', 'de-be', 'de-hh', 'is-natt',
    'au-nsw', 'au-vic', 'au-qld', 'au-sa', 'au-tas', 'br-ibge',
    'gl-igs', 'eu-epn', 'gl-ngl',
    'osm',
]
RANK = {s: i for i, s in enumerate(PRECEDENCE)}
ID_MATCH_M = 2000.0
SAME_M = 3.0
NEAR_M = 30.0
CELL_DEG = 0.0005  # ~55 m of latitude: a NEAR_M search touches at most the 3×3 neighbourhood


def _keys(rec):
    out = set()
    for v in [rec['id']] + list(rec.get('aliases') or []):
        k = norm_id(v)
        if len(k) >= 3:
            out.add(k)
    return out


def jaro_winkler(a, b):
    if a == b:
        return 1.0
    la, lb = len(a), len(b)
    if not la or not lb:
        return 0.0
    window = max(la, lb) // 2 - 1
    ma, mb = [False] * la, [False] * lb
    matches = 0
    for i, ch in enumerate(a):
        for j in range(max(0, i - window), min(lb, i + window + 1)):
            if not mb[j] and b[j] == ch:
                ma[i] = mb[j] = True
                matches += 1
                break
    if not matches:
        return 0.0
    t, j = 0, 0
    for i in range(la):
        if ma[i]:
            while not mb[j]:
                j += 1
            if a[i] != b[j]:
                t += 1
            j += 1
    m = matches
    jaro = (m / la + m / lb + (m - t / 2) / m) / 3
    prefix = 0
    for x, y in zip(a[:4], b[:4]):
        if x != y:
            break
        prefix += 1
    return jaro + prefix * 0.1 * (1 - jaro)


def _names_match(a, b):
    na = norm_id(a.get('name') or a['id'])
    nb = norm_id(b.get('name') or b['id'])
    return bool(na and nb) and jaro_winkler(na, nb) > 0.9


def _heights_agree(a, b):
    for ha in a.get('hOrtho') or []:
        for hb in b.get('hOrtho') or []:
            if ha.get('datum') and ha.get('datum') == hb.get('datum') and abs(ha['value'] - hb['value']) <= 0.05:
                return True
    return False


def _compatible(a_type, b_type):
    return a_type == b_type or 'u' in (a_type, b_type) or {a_type, b_type} <= {'3d', 'h', 'gnss'} \
        or {a_type, b_type} == {'3d', 'v'}


def _cell(lat, lng):
    return int(math.floor(lat / CELL_DEG)), int(math.floor(lng / CELL_DEG))


def dedupe(records, stats=None):
    """Kept records (destroyed ones included, for the caller to drop) in precedence order."""
    by_uid = {}
    for r in records:
        by_uid.setdefault(r['uid'], r)  # the same mark in two state files
    ordered = sorted(by_uid.values(), key=lambda r: (RANK.get(r['src'], len(RANK)), r['uid']))
    kept, by_key, grid = [], {}, {}
    stats = stats if stats is not None else {}
    for r in ordered:
        twin = None
        for k in _keys(r):
            for idx in by_key.get(k, ()):
                other = kept[idx]
                if other['src'] != r['src'] and \
                        haversine_m(r['lat'], r['lng'], other['lat'], other['lng']) <= ID_MATCH_M:
                    twin = idx
                    break
            if twin is not None:
                break
        reason = 'id'
        if twin is None:
            reason = 'distance'
            cy, cx = _cell(r['lat'], r['lng'])
            best = None
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    for idx in grid.get((cy + dy, cx + dx), ()):
                        other = kept[idx]
                        if other['src'] == r['src']:
                            continue
                        d = haversine_m(r['lat'], r['lng'], other['lat'], other['lng'])
                        if d > NEAR_M or (best is not None and d >= best[0]):
                            continue
                        if r['src'] == 'osm':
                            ok = _compatible(r['type'], other['type'])
                        elif d <= SAME_M:
                            ok = r['type'] == other['type']
                        else:
                            ok = r['type'] == other['type'] and (_names_match(r, other) or _heights_agree(r, other))
                        if ok:
                            best = (d, idx)
            twin = best[1] if best else None
        if twin is not None:
            other = kept[twin]
            for k in _keys(r):
                by_key.setdefault(k, []).append(twin)
            key = f"{r['src']}->{other['src']}:{reason}"
            stats[key] = stats.get(key, 0) + 1
            continue
        idx = len(kept)
        kept.append(r)
        for k in _keys(r):
            by_key.setdefault(k, []).append(idx)
        grid.setdefault(_cell(r['lat'], r['lng']), []).append(idx)
    return kept

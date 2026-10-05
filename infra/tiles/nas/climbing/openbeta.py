"""OpenBeta (CC0) → crag records.

The weekly export is one row per climb with its area path cut to five levels
(country, state, region, area, crag) and the climb's position (in Québec, a
copy of its leaf area's point). We read FACTS ONLY: names, grades, styles,
positions, and the climb's UUID (kept on every route, so a takedown can remove
one surgically, takedowns.json). Never `description`, never `first_ascent`.

Which node of the path tree is a crag: walking down from each state, a node
whose climbs all sit within CRAG_SPAN_M of each other (and that has at most
MAX_SECTORS children) is a crag, its children its sectors (Lac Long → Southern
/ Central / Northern Area). A wider node is a region: we walk on into its
children. A leaf is always a crag. A node marked closed in its name or an
ancestor's ("Val-Bélair (Closed)", "XM: Closed Areas") gives a closed access
status; nothing in OpenBeta ever says "open".
"""
import hashlib
import re

import grades
from common import STYLE_BITS, clean, haversine_m

# Lac Long's Southern, Central and Northern Areas spread over ~2.5 km of
# shore: one crag. Regions (Laurentides, Portneuf…) span tens of km.
CRAG_SPAN_M = 3000.0
MAX_SECTORS = 40
_CLOSED = re.compile(r'\bclosed\b|\bferm[ée]e?s?\b', re.I)
_STATUS_PAREN = re.compile(r'\s*[(\[][^)\]]*\b(?:closed|ferm[ée]e?s?)\b[^)\]]*[)\]]\s*', re.I)
_PROJECT = re.compile(r'\(\s*(?:open\s+)?project\s*\)|\bopen project\b', re.I)
_ICE = re.compile(r'\bice\b|\bglace\b', re.I)
PATH_KEYS = ('country', 'state_province', 'region', 'area', 'crag')


def crag_uid(path):
    return 'ob-' + hashlib.sha1('\x1f'.join(path).encode('utf-8')).hexdigest()[:16]


def display_name(token):
    """'Val-Bélair (Closed)' → 'Val-Bélair'; 'Edge (Closed), The' → 'The Edge'."""
    name = _STATUS_PAREN.sub(' ', token).strip(' ,')
    m = re.match(r'^(.*), (The|Le|La|Les)$', name)
    if m:
        name = f'{m.group(2)} {m.group(1)}'
    return re.sub(r'\s+', ' ', name).strip() or token


def _styles(row, path):
    st = 0
    for key, style in (
        ('is_sport', 'sport'),
        ('is_trad', 'trad'),
        ('is_top_rope', 'tr'),
        ('is_boulder', 'boulder'),
        ('is_alpine', 'alpine'),
    ):
        if row.get(key):
            st |= STYLE_BITS[style]
    # The export has no ice flag: an unflagged climb under an "Ice" area
    # ("Quebec Ice, Mixed & Alpine") is an ice climb.
    if st == 0 and any(_ICE.search(t) for t in path):
        st = STYLE_BITS['ice']
    return st


def route_of(row, path):
    st = _styles(row, path)
    out = {'id': f"ob:{row['climb_id']}", 'n': clean(row.get('climb_name'), 120) or 'Unnamed'}
    if _PROJECT.search(out['n']):
        # An open project is unclimbed: its "grade" is a placeholder (5.0,
        # 5.15) that would skew the crag's range and bands.
        out['g'] = 'Project'
    else:
        out.update(grades.from_openbeta(row, boulder=bool(st & STYLE_BITS['boulder'])))
    if st:
        out['st'] = st
    length = row.get('length_meters') or -1
    if length > 0:
        out['len'] = int(length)
    bolts = row.get('bolts_count') or -1
    if bolts > 0:
        out['bolts'] = int(bolts)
    return out


def _route_sort(r):
    return (r.get('k') or 'z', r.get('x', 99), r['n'].lower())


class Node:
    __slots__ = ('path', 'rows', 'children')

    def __init__(self, path):
        self.path = path
        self.rows = []
        self.children = {}

    def all_rows(self):
        out = list(self.rows)
        for c in self.children.values():
            out.extend(c.all_rows())
        return out


def _span_m(rows):
    lats = [r['latitude'] for r in rows]
    lngs = [r['longitude'] for r in rows]
    return haversine_m(min(lats), min(lngs), max(lats), max(lngs))


def _median_point(rows):
    lats = sorted(r['latitude'] for r in rows)
    lngs = sorted(r['longitude'] for r in rows)
    return lats[len(lats) // 2], lngs[len(lngs) // 2]


def build_tree(rows, takedowns):
    gone_ids = set(takedowns.get('ob') or [])
    gone_paths = [p.split('/') for p in takedowns.get('ob_paths') or []]
    root = Node(())
    kept = 0
    for row in rows:
        if row.get('latitude') is None or row.get('longitude') is None:
            continue
        if str(row['climb_id']) in gone_ids:
            continue
        path = []
        for key in PATH_KEYS:
            v = clean(row.get(key))
            if not v:
                break
            path.append(v)
        if not path or any(path[: len(g)] == g for g in gone_paths):
            continue
        node = root
        for i in range(len(path)):
            key = path[i]
            if key not in node.children:
                node.children[key] = Node(tuple(path[: i + 1]))
            node = node.children[key]
        node.rows.append(row)
        kept += 1
    return root, kept


def _sector(name, rows, path):
    lat, lng = _median_point(rows)
    routes = sorted((route_of(r, path) for r in rows), key=_route_sort)
    return {'n': name, 'src': 'ob', 'pt': [round(lng, 6), round(lat, 6)], 'ordered': False, 'routes': routes}


def _crag(node, sectors_from):
    path = node.path
    rows = node.all_rows()
    lat, lng = _median_point(rows)
    name = display_name(path[-1])
    sectors = []
    if node.rows:
        sectors.append(_sector(name, node.rows, path))
    for child in sorted(sectors_from, key=lambda c: c.path[-1]):
        crows = child.all_rows()
        if crows:
            sectors.append(_sector(display_name(child.path[-1]), crows, child.path))
    sectors.sort(key=lambda s: -len(s['routes']))
    rec = {
        'uid': crag_uid(path),
        'src': 'ob',
        'name': name,
        'lat': round(lat, 6),
        'lng': round(lng, 6),
        'region': ' › '.join(display_name(t) for t in path[2:-1]) or None,
        'path': list(path),
        'sectors': sectors,
    }
    if any(_CLOSED.search(t) for t in path):
        rec['access'] = {'status': 'closed', 'src': 'ob', 'note': 'Marked closed in OpenBeta'}
    return rec


def crags_from_tree(root):
    out = []

    def visit(node):
        depth = len(node.path)
        if not node.children:
            if node.rows:
                out.append(_crag(node, []))
            return
        rows = node.all_rows()
        # Regions (depth 3: Laurentides) never become crags, nor does a node
        # with a single child (the child is the crag).
        if (
            depth >= 4
            and len(node.children) >= 2
            and rows
            and len(node.children) <= MAX_SECTORS
            and _span_m(rows) <= CRAG_SPAN_M
        ):
            out.append(_crag(node, list(node.children.values())))
            return
        for child in node.children.values():
            visit(child)
        # Climbs filed on a region itself (beside its sub-areas) become a crag
        # of their own, at their own point.
        if node.rows and depth >= 2:
            lone = Node(node.path)
            lone.rows = node.rows
            out.append(_crag(lone, []))

    for country in root.children.values():
        visit(country)
    return out


def normalize(rows, takedowns=None):
    root, _kept = build_tree(rows, takedowns or {})
    return crags_from_tree(root)


def read_parquet(path):
    import pyarrow.parquet as pq

    cols = [
        'climb_id', 'climb_name', 'grade_yds', 'grade_vscale', 'grade_french',
        'is_sport', 'is_trad', 'is_boulder', 'is_alpine', 'is_top_rope',
        *PATH_KEYS, 'latitude', 'longitude', 'length_meters', 'bolts_count',
    ]
    rows = pq.read_table(path, columns=cols).to_pylist()
    for r in rows:
        r['climb_id'] = str(r['climb_id'])
    return rows

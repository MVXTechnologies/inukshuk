#!/usr/bin/env python3
"""Long-distance trails for Explore (#467) — see trails.sh.

    trails_build.py fetch PIECES_JSON WORK_DIR    # Overpass → WORK_DIR/raw/…
    trails_build.py wikidata WORK_DIR             # Wikidata sitelink counts → WORK_DIR/raw/wikidata.json
    trails_build.py build WORK_DIR OUT_DIR [--ne DIR] [--version V]
                                                  # → OUT_DIR/trails-v1.index.json,
                                                  #   trails-V.details.bin, trails-V.offsets.json

What a "long-distance trail" is here: an OpenStreetMap route relation
(`type=route`, `route=hiking|foot|bicycle|mtb|ski|canoe`) on an international,
national or regional network (`network=iwn|nwn|rwn|icn|ncn|rcn`), a
`type=superroute` of such routes, or any other named hiking/ski/canoe route
(local `lwn` included) that reaches ≥ 20 km across or whose `distance` tag
says ≥ 40 km — and, once its geometry is measured, at least
MIN_KM_INTL_NATIONAL (international/national) or MIN_KM_OTHER (everything else)
long. A relation that is a member of another kept relation is that trail's
STAGE, never a trail of its own.

Outputs (all JSON, UTF-8):

- the INDEX, downloaded once by the app and filtered on the device: per trail
  id, names, activities, network level, length, bbox, an on-trail midpoint,
  popularity, countries, region, stage count, from/to and a ~40-point
  thumbnail polyline. Countries are a lookup table (`countries`) so the rows
  stay short;
- one DETAIL document per trail (full geometry simplified at SIMPLIFY_M, as
  encoded polylines; stages with names, lengths and geometry; operator,
  website, wikipedia…), concatenated into `details.bin` with an
  `offsets.json` directory ({id: [offset, length]}) — ONE object to upload
  instead of tens of thousands; the Worker serves `/trails/v1/d/V/{id}.json`
  by range-reading it.

Popularity (OSM carries no usage data, so it is a proxy — 0…1):

    raw = NETWORK_WEIGHT[level]                       i 1.0 · n 0.75 · r 0.5 · other 0.3
        + 0.15 if the relation has a wikipedia/wikidata tag
        + 0.35 · min(1, log10(1 + sitelinks) / log10(1 + 40))   (Wikidata sitelinks)
        + 0.15 · clamp(log10(km / 20) / log10(100), 0, 1)       (20 km → 0, 2000 km → 1)
        + 0.05 if it has stages
    pop = raw / 1.70

The app ranks "near you" by mixing it with distance (`@core/trails/rank`).

Overpass etiquette as peaks_geojson.py: one query at a time, a descriptive
User-Agent, a pause between queries, backoff on 429/504, and a query Overpass
can't answer (timeout / out of memory) split in four (bbox) or in halves (ids).
Standard library only (the NAS has python3, nothing else is installed).
"""
import json
import math
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = 'inukshuk-tiles/1.0 (+https://inukshuk.mvxtechnologies.com)'
DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter'
WIKIDATA_API = 'https://www.wikidata.org/w/api.php'
QUERY_TIMEOUT_S = 180
QUERY_MAXSIZE = 256 * 1024 * 1024
PAUSE_S = float(os.environ.get('OVERPASS_PAUSE_S', '30'))
RETRIES = 4
MAX_SPLIT_DEPTH = 4
MAX_CHILD_DEPTH = 3

ROUTES = 'hiking|foot|bicycle|mtb|ski|canoe'
NETWORKS = 'iwn|nwn|rwn|icn|ncn|rcn'
ACTIVITY = {
    'hiking': 'hiking',
    'foot': 'hiking',
    'bicycle': 'cycling',
    'mtb': 'cycling',
    'ski': 'skiing',
    'canoe': 'paddling',
}
LEVEL = {'iwn': 'i', 'icn': 'i', 'nwn': 'n', 'ncn': 'n', 'rwn': 'r', 'rcn': 'r'}
NETWORK_WEIGHT = {'i': 1.0, 'n': 0.75, 'r': 0.5, 'o': 0.3}
POP_MAX = 1.70

# Length floors, km. "Long distance" is a weekend and up.
MIN_KM_INTL_NATIONAL = 30.0
MIN_KM_OTHER = 40.0
# Phase-1 prefilter on the relation's bbox diagonal (km), per network level:
# a route that never leaves a box this size is a day-hike loop, not a
# long-distance trail — dropped before its geometry is ever fetched. The
# 2026-09 pilot (Québec + Maritimes + New England + the Alps) had 6 300
# relations passing an 8/12 km rule, 2 800 of them under 15 km across; most
# of those are stages, which are fetched anyway through their parent.
MIN_DIAG_KM = 10.0  # international / national / superroutes
MIN_DIAG_KM_REGIONAL = 15.0
MIN_DIAG_KM_LOCAL = 20.0  # lwn and unnetworked hiking / ski / canoe
# Geometry batches: relations per query, and the summed bbox diagonals (km)
# one answer may cover (a 60-relation batch of regional routes is ~5 MB).
GEOM_BATCH_MAX = 150
GEOM_BATCH_KM = 8000.0
# Member roles that are the trail itself (not alternatives, excursions,
# approaches or the backward half of a one-way pair).
MAIN_ROLES = {'', 'main', 'forward', 'section', 'stage', 'route'}
# Detail geometry tolerance, metres, and the point budget that raises it on
# very long trails (the E-paths) so no detail document grows past ~1 MB.
SIMPLIFY_M = 10.0
MAX_DETAIL_POINTS = 60000
THUMB_POINTS = 40
# Thumbnail gaps shorter than this share of the trail's bbox diagonal are bridged.
THUMB_BRIDGE_FRACTION = 0.08
# Gaps up to this many metres between consecutive way chains are joined.
JOIN_GAP_M = 60.0
DESCRIPTION_MAX = 400

EARTH_R = 6371008.8


# ---------------------------------------------------------------------------
# Small geometry kit (lon/lat in degrees)
# ---------------------------------------------------------------------------


def haversine_m(a, b):
    lon1, lat1 = a
    lon2, lat2 = b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(h)))


def line_length_m(points):
    return sum(haversine_m(points[i - 1], points[i]) for i in range(1, len(points)))


def simplify(points, tolerance_m):
    """Douglas-Peucker on a local equirectangular projection (metres)."""
    if len(points) <= 2:
        return list(points)
    lat0 = math.radians(sum(p[1] for p in points) / len(points))
    kx = math.cos(lat0) * EARTH_R * math.pi / 180
    ky = EARTH_R * math.pi / 180
    xy = [(p[0] * kx, p[1] * ky) for p in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    tol2 = tolerance_m * tolerance_m
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]
        bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        best, best_d = -1, tol2
        for i in range(a + 1, b):
            px, py = xy[i]
            if seg2 == 0:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
                d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > best_d:
                best, best_d = i, d
        if best >= 0:
            keep[best] = True
            stack.append((a, best))
            stack.append((best, b))
    return [p for p, k in zip(points, keep) if k]


def simplify_parts(parts, tolerance_m, max_points):
    """Simplify every part, raising the tolerance until the budget is met."""
    tol = tolerance_m
    while True:
        out = [simplify(p, tol) for p in parts]
        if sum(len(p) for p in out) <= max_points or tol > 50000:
            return out, tol
        tol *= 1.6


def encode_polyline(points, precision=5):
    """Google's encoded-polyline algorithm, (lon, lat) input, lat first on the wire."""
    factor = 10 ** precision
    out = []
    prev_lat = prev_lon = 0
    for lon, lat in points:
        ilat, ilon = int(round(lat * factor)), int(round(lon * factor))
        for value in (ilat - prev_lat, ilon - prev_lon):
            v = ~(value << 1) if value < 0 else value << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        prev_lat, prev_lon = ilat, ilon
    return ''.join(out)


def decode_polyline(text, precision=5):
    factor = 10 ** precision
    points, i, lat, lon = [], 0, 0, 0
    while i < len(text):
        vals = []
        for _ in range(2):
            shift = result = 0
            while True:
                b = ord(text[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            vals.append(~(result >> 1) if result & 1 else result >> 1)
        lat += vals[0]
        lon += vals[1]
        points.append((lon / factor, lat / factor))
    return points


def bbox_of(parts):
    xs = [p[0] for part in parts for p in part]
    ys = [p[1] for part in parts for p in part]
    return [round(min(xs), 5), round(min(ys), 5), round(max(xs), 5), round(max(ys), 5)]


def bbox_diag_km(b):
    return haversine_m((b[0], b[1]), (b[2], b[3])) / 1000


def point_at_fraction(parts, fraction):
    """The on-line point `fraction` of the way along all parts (0…1)."""
    total = sum(line_length_m(p) for p in parts)
    if total == 0:
        return parts[0][0]
    target = total * fraction
    for part in parts:
        for i in range(1, len(part)):
            d = haversine_m(part[i - 1], part[i])
            if target <= d and d > 0:
                t = target / d
                a, b = part[i - 1], part[i]
                return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            target -= d
    return parts[-1][-1]


def chain_ways(ways):
    """Way geometries (in member order) → continuous parts, in trail order.

    OSM member order is a hint, not a guarantee: plenty of relations list
    their ways unsorted, and child routes are drawn in whichever direction
    their mapper walked. So:

    1. consecutive members that share an end are chained (either way round);
    2. chains whose ends coincide are joined whatever their member order —
       only where exactly two chain ends meet (a T junction is ambiguous);
    3. the pieces left are ordered and oriented end-to-end (order_pieces):
       member order when it is about as good as a geographic chaining,
       else the chaining — never a jump back and forth across the map;
    4. consecutive pieces whose ends are within JOIN_GAP_M are joined.

    Disjoint pieces stay separate parts (the app draws a MultiLineString; a
    straight connector across an unmapped gap would be a made-up trail).
    """
    parts = []
    first_len = 0
    for g in ways:
        if len(g) < 2:
            continue
        if not parts:
            parts.append(list(g))
            first_len = 1
            continue
        cur = parts[-1]
        if cur[-1] == g[0]:
            cur.extend(g[1:])
        elif cur[-1] == g[-1]:
            cur.extend(reversed(g[:-1]))
        elif first_len == 1 and cur[0] == g[0]:
            cur.reverse()
            cur.extend(g[1:])
        elif first_len == 1 and cur[0] == g[-1]:
            cur.reverse()
            cur.extend(reversed(g[:-1]))
        else:
            parts.append(list(g))
            first_len = 1
            continue
        first_len += 1
    return order_parts(merge_shared_ends(parts))


def order_parts(parts):
    """Parts → the same parts ordered and oriented end-to-end, then joined
    where their ends meet within JOIN_GAP_M."""
    parts = [p for p in parts if len(p) >= 2]
    order = order_pieces([(p[0], p[-1]) for p in parts])
    return join_gaps([list(reversed(parts[i])) if flip else parts[i] for i, flip in order])


def merge_shared_ends(parts):
    """Join chains that share an end node, whatever their order in the list.

    Only where exactly two chain ends meet: at a junction of three (a spur,
    a loop closing on the line) which way the trail goes is ambiguous, and
    order_pieces decides by distance instead. A joined run keeps the
    direction of its earliest chain (member order is the relation's own
    direction). Linear in the number of points: the E-paths have thousands
    of chains."""
    parts = [list(p) for p in parts if len(p) >= 2]
    nodes = {}
    for i, p in enumerate(parts):
        if p[0] == p[-1]:
            continue  # a closed loop has no free end
        nodes.setdefault(p[0], []).append((i, 0))
        nodes.setdefault(p[-1], []).append((i, 1))
    link = {}
    for hits in nodes.values():
        if len(hits) == 2 and hits[0][0] != hits[1][0]:
            link[hits[0]] = hits[1]
            link[hits[1]] = hits[0]
    out = []
    for run in linked_runs(len(parts), link):
        line = []
        for i, f in run:
            pts = parts[i][::-1] if f else parts[i]
            line.extend(pts[1:] if line else pts)
        out.append(line)
    return out


def linked_runs(n, link, earliest_first=False):
    """Pieces 0…n-1 whose ends are linked ({(i, end): (j, end)}, end 0 = start,
    1 = finish) → runs [(index, flipped)], each walked end to end, in the
    order of their earliest piece and in that piece's own direction — or,
    `earliest_first`, run so that the earliest piece comes first (a
    superroute's first stage is where it starts, whichever way it was mapped)."""
    seen = [False] * n

    def walk(i, flipped):
        run = []
        while not seen[i]:
            seen[i] = True
            run.append((i, flipped))
            nxt = link.get((i, 0 if flipped else 1))
            if nxt is None:
                break
            i, flipped = nxt[0], nxt[1] == 1
        return run

    runs = []
    # Runs with a free end first (walked from that end), then the closed rings.
    for i in range(n):
        if seen[i]:
            continue
        if (i, 0) not in link:
            runs.append(walk(i, False))
        elif (i, 1) not in link:
            runs.append(walk(i, True))
    for i in range(n):
        if not seen[i]:
            runs.append(walk(i, False))
    out = []
    for run in sorted(runs, key=lambda r: min(i for i, _ in r)):
        first = min(run)
        if earliest_first:
            turn = run.index(first) > (len(run) - 1) / 2
        else:
            turn = first[1]  # the earliest piece would run backwards
        if turn:
            run = [(i, not f) for i, f in reversed(run)]
        out.append(run)
    return out


def _near_m(a, b):
    """Equirectangular distance, metres — exact enough to rank ends."""
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * EARTH_R * math.pi / 180


def _orient(order_ends):
    """Best orientation of pieces in a FIXED order (Viterbi over flip / no
    flip): [(start, end)] → (flips, total gap m). Ties keep a piece as is."""
    n = len(order_ends)
    if n == 0:
        return [], 0.0
    # cost[f] = best total ending with piece k flipped (f=1) or not (f=0)
    cost = [0.0, 0.0]
    back = []
    for k in range(1, n):
        prev, cur = order_ends[k - 1], order_ends[k]
        tails = (prev[1], prev[0])  # prev's exit point when not flipped / flipped
        heads = (cur[0], cur[1])
        new, choice = [0.0, 0.0], [0, 0]
        for f in (0, 1):
            options = [cost[pf] + _near_m(tails[pf], heads[f]) for pf in (0, 1)]
            pf = 0 if options[0] <= options[1] else 1
            new[f], choice[f] = options[pf], pf
        back.append(choice)
        cost = new
    f = 0 if cost[0] <= cost[1] else 1
    total = cost[f]
    flips = [f]
    for choice in reversed(back):
        f = choice[f]
        flips.append(f)
    flips.reverse()
    return [bool(x) for x in flips], total


# Stage ends this close are where one stage hands over to the next — mapped
# sections rarely meet on the exact node.
STAGE_JOIN_M = 1000.0


def order_stages(ends):
    """Stages [(start, end)] in member order → [(index, flipped)].

    Stages are not ways: a superroute often lists side trails, loops or
    variants after its main sections (the Bruce Trail, the Rideau Trail), so
    the list is never re-chained by distance. Member order stays, with two
    repairs:

    - a stage listed out of place moves to where it hands over to its
      neighbours (ends within STAGE_JOIN_M) — one stage at a time, and only
      while that strictly adds handovers (ties: the order that strays
      least from member order), only into a gap (never between two stages
      that already meet), so side trails that meet the line at a section
      boundary stay where they are listed, and the first member stays
      first (a side loop from the trailhead — the Rideau Trail's K&P loop —
      is not "stage 1");
    - every stage is turned to meet its neighbours (a section mapped in
      the other direction: the Appalachian Trail's Virginia, the Balcon du
      Léman stages the GR 5 walks backwards).
    """
    n = len(ends)
    touch = [
        [
            i != j and min(_near_m(p, q) for p in ends[i] for q in ends[j]) <= STAGE_JOIN_M
            for j in range(n)
        ]
        for i in range(n)
    ]

    def handovers(seq):
        return sum(touch[a][b] for a, b in zip(seq, seq[1:]))

    seq = list(range(n))
    score = handovers(seq)
    for _ in range(n * n):
        best = None
        for pos, k in enumerate(seq):
            rest = seq[:pos] + seq[pos + 1 :]
            for at in range(len(rest) + 1):
                if at == pos:
                    continue
                if 0 < at < len(rest) and touch[rest[at - 1]][rest[at]]:
                    continue  # never split two stages that already hand over
                cand = rest[:at] + [k] + rest[at:]
                if cand[0] != 0:
                    continue  # the first member is where the trail starts
                gain = handovers(cand) - score
                if gain <= 0:
                    continue
                # Ties: the order that strays least from member order.
                stray = sum(abs(i - j) for i, j in enumerate(cand))
                if best is None or (gain, -stray) > (best[0], -best[2]):
                    best = (gain, cand, stray)
        if best is None:
            break
        score += best[0]
        seq = best[1]
    flips, _ = _orient([ends[i] for i in seq])
    return list(zip(seq, flips))


# Member order is kept unless a geographic chaining is clearly shorter in
# jumps: by this factor and by ORDER_SLACK_M (a few hundred metres of
# unmapped gaps never reorder a relation that is listed in order).
ORDER_FACTOR = 1.25
ORDER_SLACK_M = 2000.0
# Greedy chaining tries every piece as the start up to this many pieces,
# else the pieces whose ends are loneliest (a trail's two ends) and the first.
ORDER_ALL_STARTS = 40
ORDER_LONELY_STARTS = 12
# Past this many pieces the greedy chaining (quadratic) is skipped: member
# order, each piece turned to meet its neighbours.
ORDER_MAX_PIECES = 1500


def order_pieces(ends):
    """Order and orient pieces of a line, given each piece's (start, end).

    Returns [(index, flipped)] covering every piece once. The given (member)
    order is kept, each piece turned to meet its neighbours, unless chaining
    the pieces geographically (greedy nearest end) leaves clearly less ground
    to jump across — then that order, run in the direction that keeps the
    first member nearer the start.
    """
    n = len(ends)
    if n <= 1:
        return [(i, False) for i in range(n)]
    kept_flips, kept_cost = _orient(ends)
    if n > ORDER_MAX_PIECES:
        return [(i, kept_flips[i]) for i in range(n)]
    best = None
    for start in _greedy_starts(ends):
        order = _greedy_chain(ends, start)
        flips, cost = _orient([ends[i] for i in order])
        if best is None or cost < best[1]:
            best = (order, cost, flips)
    if best is None or kept_cost <= best[1] * ORDER_FACTOR + ORDER_SLACK_M:
        return [(i, kept_flips[i]) for i in range(n)]
    order, _, flips = best
    pairs = list(zip(order, flips))
    if order.index(0) > (n - 1) / 2:
        pairs = [(i, not f) for i, f in reversed(pairs)]
    return pairs


def _greedy_starts(ends):
    n = len(ends)
    if n <= ORDER_ALL_STARTS:
        return [(i, f) for i in range(n) for f in (False, True)]
    # Loneliest ends: the farthest from any other piece's end — where a line starts.
    lonely = []
    for i, (a, b) in enumerate(ends):
        for f, p in ((False, a), (True, b)):
            near = min(
                min(_near_m(p, q[0]), _near_m(p, q[1])) for j, q in enumerate(ends) if j != i
            )
            lonely.append((near, i, f))
    lonely.sort(reverse=True)
    starts = [(i, f) for _, i, f in lonely[:ORDER_LONELY_STARTS]]
    return starts + [(0, False), (0, True)]


def _greedy_chain(ends, start):
    """Pieces in greedy nearest-end order from `start` (index, flipped)."""
    i, flipped = start
    order = [i]
    used = {i}
    tip = ends[i][0] if flipped else ends[i][1]
    while len(order) < len(ends):
        best_d, best_j, best_tip = None, None, None
        for j, (a, b) in enumerate(ends):
            if j in used:
                continue
            da, db = _near_m(tip, a), _near_m(tip, b)
            if best_d is None or da < best_d:
                best_d, best_j, best_tip = da, j, b
            if db < best_d:
                best_d, best_j, best_tip = db, j, a
        order.append(best_j)
        used.add(best_j)
        tip = best_tip
    return order


def bridge_parts(parts, max_gap_m):
    """Join each part to the next one when their nearest ends are within max_gap_m."""
    out = []
    for part in parts:
        part = list(part)
        if out:
            prev = out[-1]
            options = [
                (haversine_m(prev[-1], part[0]), False, False),
                (haversine_m(prev[-1], part[-1]), False, True),
                (haversine_m(prev[0], part[0]), True, False),
                (haversine_m(prev[0], part[-1]), True, True),
            ]
            gap, flip_prev, flip_part = min(options)
            if gap <= max_gap_m:
                if flip_prev:
                    prev.reverse()
                prev.extend(reversed(part) if flip_part else part)
                continue
        out.append(part)
    return out


def join_gaps(parts):
    """Join consecutive parts whose ends meet within JOIN_GAP_M (either way round)."""
    out = []
    for part in parts:
        if out:
            prev = out[-1]
            if haversine_m(prev[-1], part[0]) <= JOIN_GAP_M:
                prev.extend(part[1:] if prev[-1] == part[0] else part)
                continue
            if haversine_m(prev[-1], part[-1]) <= JOIN_GAP_M:
                rev = list(reversed(part))
                prev.extend(rev[1:] if prev[-1] == rev[0] else rev)
                continue
        out.append(list(part))
    return out


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------

_KM = re.compile(r'^\s*~?\s*(\d+(?:[.,]\d+)?)\s*(km|mi|miles?)?\s*$', re.I)


def parse_distance_km(raw):
    """OSM `distance` ("123", "123 km", "12.5", "80 mi") → km or None."""
    if raw is None:
        return None
    m = _KM.match(str(raw))
    if not m:
        return None
    value = float(m.group(1).replace(',', '.'))
    if m.group(2) and m.group(2).lower().startswith('mi'):
        value *= 1.609344
    return value if 0 < value < 20000 else None


def level_of(tags):
    return LEVEL.get((tags.get('network') or '').strip(), 'o')


def activities_of(tags):
    acts = []
    for r in (tags.get('route') or '').split(';'):
        a = ACTIVITY.get(r.strip())
        if a and a not in acts:
            acts.append(a)
    return acts


def display_name(tags):
    # A bare `ref` ("1", "E4") is not a name people search for or recognise.
    for key in ('name', 'name:en', 'official_name'):
        value = (tags.get(key) or '').strip()
        if value:
            return value
    return None


def is_candidate(el):
    """Phase-1 prefilter: worth fetching the geometry of?"""
    tags = el.get('tags') or {}
    if tags.get('state') in ('proposed', 'disused', 'abandoned') or not display_name(tags):
        return False
    if not activities_of(tags):
        return False
    b = el.get('bounds')
    diag = (
        bbox_diag_km([b['minlon'], b['minlat'], b['maxlon'], b['maxlat']])
        if b
        else MIN_DIAG_KM
    )
    if tags.get('type') == 'superroute':
        # Its `bb` covers only its own few ways (the Appalachian Trail's is
        # 5 km across): the geometry decides, once its stages are fetched.
        return True
    level = level_of(tags)
    if level in ('i', 'n'):
        return diag >= MIN_DIAG_KM
    if level == 'r':
        return diag >= MIN_DIAG_KM_REGIONAL
    # Local and unnetworked hiking/ski/canoe routes (the Sentier des Caps de
    # Charlevoix is `lwn`): only the ones that reach far enough to possibly
    # be MIN_KM_OTHER long, or that say so in `distance`.
    if (tags.get('route') or '') in ('bicycle', 'mtb'):
        return False
    dist = parse_distance_km(tags.get('distance'))
    return diag >= MIN_DIAG_KM_LOCAL or (dist is not None and dist >= MIN_KM_OTHER)


# A stage that is famous in its own right stays a trail too (stands_alone):
# Wikidata sitelinks at least this many (the Appalachian Trail has 35; its
# state sections, which carry their own Wikidata items, have 0).
NOTABLE_SITELINKS = 5


def ancestors_of(rid, parents):
    """Every relation above `rid` (parents, their parents, …)."""
    out, todo = set(), list(parents.get(rid, ()))
    while todo:
        p = todo.pop()
        if p not in out:
            out.add(p)
            todo.extend(parents.get(p, ()))
    return out


def stands_alone(rid, relations, parents, sitelinks):
    """Is a stage also a trail in its own right?

    - famous: a well-linked Wikidata item (NOTABLE_SITELINKS) that is its own —
      sections tagged with their whole trail's item don't count (every
      "SIA, n-…" section carries the International Appalachian Trail's);
    - or independently run: its own `website`, which none of the trails it is
      part of shares (the Sentier des Caps de Charlevoix is a stage of the
      Sentier National and a trail with its own operator and site).

    A section named after its trail ("Sentier National, Charlevoix") never
    stands alone.
    """
    tags = (relations.get(rid) or {}).get('tags') or {}
    above = [((relations.get(a) or {}).get('tags') or {}) for a in ancestors_of(rid, parents)]
    name = normalize_name(display_name(tags) or '')
    for a in above:
        parent_name = normalize_name(display_name(a) or '')
        if parent_name and name.startswith(parent_name):
            return False
    q = (tags.get('wikidata') or '').strip()
    if q and sitelinks.get(q, 0) >= NOTABLE_SITELINKS:
        if all((a.get('wikidata') or '').strip() != q for a in above):
            return True
    site = (tags.get('website') or '').strip().rstrip('/')
    if site and all((a.get('website') or '').strip().rstrip('/') != site for a in above):
        return True
    return False


def relation_members(rel, main_only=False):
    return [
        m['ref']
        for m in (rel or {}).get('members', [])
        if m.get('type') == 'relation'
        and (not main_only or (m.get('role') or '').strip() in MAIN_ROLES)
    ]


def own_main_ways(rel):
    return [
        m
        for m in (rel or {}).get('members', [])
        if m.get('type') == 'way' and (m.get('role') or '').strip() in MAIN_ROLES
    ]


def normalize_name(name):
    s = unicodedata.normalize('NFKD', name.lower())
    s = ''.join(c for c in s if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()


# ---------------------------------------------------------------------------
# Overpass
# ---------------------------------------------------------------------------


def log(message):
    print(message, file=sys.stderr, flush=True)


def tags_query(bbox):
    w, s, e, n = bbox
    area = f'({s},{w},{n},{e})'
    # A superroute's members are relations, not ways, so a bbox filter never
    # matches it (the Appalachian Trail's own relation holds 14 state
    # sections and no way): parents are found upward from the routes, with
    # `rel(br)`, up to three levels.
    return (
        f'[out:json][timeout:{QUERY_TIMEOUT_S}][maxsize:{QUERY_MAXSIZE}];('
        f'relation["type"="route"]["route"~"^({ROUTES})$"]["network"~"^({NETWORKS})$"]{area};'
        f'relation["type"="superroute"]["route"~"^({ROUTES})$"]{area};'
        f'relation["type"="route"]["route"~"^(hiking|foot|ski|canoe)$"]{area};'
        ')->.r;'
        '(rel(br.r)["type"~"^(route|superroute)$"];)->.p1;'
        '(rel(br.p1)["type"~"^(route|superroute)$"];)->.p2;'
        '(rel(br.p2)["type"~"^(route|superroute)$"];)->.p3;'
        '(.r;.p1;.p2;.p3;);out tags bb;'
    )


def geom_query(ids):
    return (
        f'[out:json][timeout:{QUERY_TIMEOUT_S}][maxsize:{QUERY_MAXSIZE}];'
        f'relation(id:{",".join(str(i) for i in ids)});out geom;'
    )


def post(endpoint, query):
    """One Overpass answer, or raises Split (too big) / RuntimeError."""
    body = urllib.parse.urlencode({'data': query}).encode()
    last = None
    for attempt in range(RETRIES):
        req = urllib.request.Request(
            endpoint, data=body, method='POST', headers={'User-Agent': USER_AGENT}
        )
        try:
            with urllib.request.urlopen(req, timeout=QUERY_TIMEOUT_S + 120) as resp:
                data = json.loads(resp.read())
            remark = (data.get('remark') or '').strip()
            if 'error' in remark.lower():
                raise Split(remark[:200])
            time.sleep(PAUSE_S)
            return data.get('elements', [])
        except urllib.error.HTTPError as e:
            if e.code == 400:
                raise RuntimeError(f'Overpass rejected the query: {e.read()[:300]!r}') from e
            last = f'HTTP {e.code}'
            wait = (120 if e.code == 429 else 60) * 2**attempt
        except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError) as e:
            last = str(e)[:200]
            if 'timed out' in last:
                raise Split(last) from e
            wait = 60 * 2**attempt
        log(f'  {last}; retry {attempt + 1}/{RETRIES} in {wait}s')
        time.sleep(wait)
    raise Split(last or 'no answer')


class Split(Exception):
    pass


def split4(bbox):
    w, s, e, n = bbox
    mx, my = (w + e) / 2, (s + n) / 2
    return [[w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n]]


def fetch_tags(bbox, endpoint, depth=0):
    try:
        return post(endpoint, tags_query(bbox))
    except Split as e:
        if depth >= MAX_SPLIT_DEPTH:
            raise RuntimeError(f'{bbox} failed at split depth {depth}: {e}') from e
        log(f'  {bbox}: {e}; splitting in four')
        out = []
        for part in split4(bbox):
            out.extend(fetch_tags(part, endpoint, depth + 1))
        return out


def fetch_geoms(ids, endpoint, depth=0):
    try:
        return post(endpoint, geom_query(ids))
    except Split as e:
        if len(ids) == 1 or depth >= 8:
            log(f'  relation(s) {ids[:3]}…: {e}; skipped')
            return []
        half = len(ids) // 2
        log(f'  {len(ids)} relations: {e}; splitting in two')
        return fetch_geoms(ids[:half], endpoint, depth + 1) + fetch_geoms(
            ids[half:], endpoint, depth + 1
        )


def batches(items, weight, budget, max_items):
    """Split `items` into batches whose summed weight stays under `budget`."""
    out, cur, acc = [], [], 0.0
    for item in items:
        w = weight(item)
        if cur and (acc + w > budget or len(cur) >= max_items):
            out.append(cur)
            cur, acc = [], 0.0
        cur.append(item)
        acc += w
    if cur:
        out.append(cur)
    return out


def write_json(path, value):
    with open(path + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(path + '.tmp', path)


def fetch(pieces_path, work):
    endpoint = os.environ.get('OVERPASS_URL') or DEFAULT_ENDPOINT
    raw = os.path.join(work, 'raw')
    os.makedirs(os.path.join(raw, 'geom'), exist_ok=True)
    with open(pieces_path) as f:
        pieces = json.load(f)['pieces']

    # 1. Tags + bounds per piece.
    candidates = {}
    for piece in pieces:
        path = os.path.join(raw, f"tags-{piece['name']}.json")
        if os.path.exists(path):
            with open(path, encoding='utf-8') as f:
                elements = json.load(f)['elements']
        else:
            log(f"{time.strftime('%c')} tags {piece['name']} {piece['bbox']}")
            elements = fetch_tags(piece['bbox'], endpoint)
            write_json(path, {'elements': elements})
        kept = [el for el in elements if el.get('type') == 'relation' and is_candidate(el)]
        log(f"  {len(elements)} relations, {len(kept)} candidates")
        for el in kept:
            candidates[el['id']] = el

    # 2. Geometry of every candidate, then (recursively) of their child relations.
    fetched = set()
    for name in os.listdir(os.path.join(raw, 'geom')):
        if name.endswith('.json'):
            with open(os.path.join(raw, 'geom', name), encoding='utf-8') as f:
                for el in json.load(f)['elements']:
                    if el.get('type') == 'relation':
                        fetched.add(el['id'])
    todo = [i for i in candidates if i not in fetched]
    weights = {i: bbox_weight(candidates[i]) for i in candidates}
    depth = 0
    batch_no = len(os.listdir(os.path.join(raw, 'geom')))
    while todo and depth <= MAX_CHILD_DEPTH:
        log(f"{time.strftime('%c')} geometry: {len(todo)} relations (depth {depth})")
        children = set()
        for group in batches(todo, lambda i: weights.get(i, 50.0), GEOM_BATCH_KM, GEOM_BATCH_MAX):
            elements = fetch_geoms(group, endpoint)
            batch_no += 1
            write_json(os.path.join(raw, 'geom', f'{batch_no:05d}.json'), {'elements': elements})
            for el in elements:
                if el.get('type') != 'relation':
                    continue
                fetched.add(el['id'])
                for m in el.get('members', []):
                    if m.get('type') == 'relation' and m.get('role', '') not in (
                        'alternative',
                        'excursion',
                        'approach',
                        'connection',
                    ):
                        children.add(m['ref'])
        todo = sorted(c for c in children if c not in fetched)
        depth += 1
    log(f'{len(fetched)} relations with geometry')


def bbox_weight(el):
    b = el.get('bounds')
    if not b:
        return 50.0
    return max(5.0, bbox_diag_km([b['minlon'], b['minlat'], b['maxlon'], b['maxlat']]))


# ---------------------------------------------------------------------------
# Wikidata
# ---------------------------------------------------------------------------


def wikidata(work):
    raw = os.path.join(work, 'raw')
    relations = load_relations(raw)
    ids = sorted(
        {
            (r.get('tags') or {}).get('wikidata', '').strip()
            for r in relations.values()
            if re.fullmatch(r'Q\d+', (r.get('tags') or {}).get('wikidata', '').strip())
        }
    )
    path = os.path.join(raw, 'wikidata.json')
    counts = {}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            counts = json.load(f)
    todo = [q for q in ids if q not in counts]
    log(f'wikidata: {len(ids)} items, {len(todo)} to fetch')
    for i in range(0, len(todo), 50):
        group = todo[i : i + 50]
        url = WIKIDATA_API + '?' + urllib.parse.urlencode(
            {
                'action': 'wbgetentities',
                'ids': '|'.join(group),
                'props': 'sitelinks',
                'format': 'json',
            }
        )
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        for attempt in range(RETRIES):
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    data = json.loads(resp.read())
                break
            except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError) as e:
                log(f'  wikidata: {e}; retry')
                time.sleep(10 * 2**attempt)
        else:
            continue
        for q, entity in (data.get('entities') or {}).items():
            counts[q] = len(entity.get('sitelinks') or {})
        write_json(path, counts)
        time.sleep(1)
    write_json(path, counts)


# ---------------------------------------------------------------------------
# Natural Earth (countries, regions) — optional
# ---------------------------------------------------------------------------


# Country names as people say them (Natural Earth's NAME is the formal one).
COUNTRY_NAME_OVERRIDES = {'US': 'United States', 'GB': 'United Kingdom'}
# Countries whose admin-1 units are small (departments, provinces): the
# region people name is Natural Earth's `region` (Corse, Valle d'Aosta).
ADMIN1_USE_REGION = {'FR', 'IT', 'ES'}


class Regions:
    """Point → ISO country (+ name, continent) and admin-1 region name.

    Admin-1 (10 m, detailed coasts) answers first — it knows its country too —
    and admin-0 (50 m) covers what it misses.
    """

    def __init__(self, ne_dir):
        self.countries = []
        self.admin1 = []
        self.names = {}
        if not ne_dir:
            return
        c = os.path.join(ne_dir, 'ne_50m_admin_0_countries.geojson')
        a = os.path.join(ne_dir, 'ne_10m_admin_1_states_provinces.geojson')
        if os.path.exists(c):
            for f in load_geojson(c):
                p = f['properties']
                iso = p.get('ISO_A2_EH') or p.get('ISO_A2')
                if not iso or iso == '-99':
                    continue
                name = COUNTRY_NAME_OVERRIDES.get(iso) or p.get('NAME') or iso
                self.names[iso] = (name, p.get('CONTINENT') or '')
                self.countries.append((iso, polygons_of(f['geometry'])))
        if os.path.exists(a):
            for f in load_geojson(a):
                p = f['properties']
                iso = p.get('iso_a2')
                name = (
                    (p.get('region') if iso in ADMIN1_USE_REGION and p.get('region') else None)
                    or p.get('name')
                    or p.get('name_en')
                )
                if name and iso and iso != '-99':
                    self.admin1.append(((iso, name), polygons_of(f['geometry'])))

    def country(self, pt):
        """(iso, name, continent) or None."""
        hit = lookup(self.admin1, pt)
        iso = hit[0] if hit else lookup(self.countries, pt)
        if iso is None or iso not in self.names:
            return None
        return (iso, *self.names[iso])

    def region(self, pt):
        hit = lookup(self.admin1, pt)
        return hit[1] if hit else None


def load_geojson(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)['features']


def polygons_of(geometry):
    """GeoJSON (Multi)Polygon → [(bbox, rings)] with rings as [(x, y)] lists."""
    if geometry is None:
        return []
    polys = (
        [geometry['coordinates']]
        if geometry['type'] == 'Polygon'
        else geometry['coordinates']
        if geometry['type'] == 'MultiPolygon'
        else []
    )
    out = []
    for poly in polys:
        rings = [[(x, y) for x, y, *_ in ring] for ring in poly]
        xs = [p[0] for p in rings[0]]
        ys = [p[1] for p in rings[0]]
        out.append(((min(xs), min(ys), max(xs), max(ys)), rings))
    return out


def in_ring(pt, ring):
    x, y = pt
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def lookup(table, pt):
    x, y = pt
    for value, polys in table:
        for (w, s, e, n), rings in polys:
            if w <= x <= e and s <= y <= n and in_ring(pt, rings[0]):
                if not any(in_ring(pt, hole) for hole in rings[1:]):
                    return value
    return None


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


def load_relations(raw):
    relations = {}
    geom_dir = os.path.join(raw, 'geom')
    for name in sorted(os.listdir(geom_dir)):
        if not name.endswith('.json'):
            continue
        with open(os.path.join(geom_dir, name), encoding='utf-8') as f:
            for el in json.load(f)['elements']:
                if el.get('type') == 'relation':
                    relations[el['id']] = el
    return relations


def main_ways(rel, relations, seen=None):
    """A relation's main-role ways as (way id, relation id, geometry), its
    child routes' in place, in member order."""
    seen = seen if seen is not None else set()
    if rel['id'] in seen:
        return []
    seen = seen | {rel['id']}
    ways = []
    for m in rel.get('members', []):
        role = (m.get('role') or '').strip()
        if m.get('type') == 'way' and role in MAIN_ROLES and m.get('geometry'):
            geom = [(round(p['lon'], 6), round(p['lat'], 6)) for p in m['geometry'] if p]
            ways.append((m.get('ref'), rel['id'], geom))
        elif m.get('type') == 'relation' and role in MAIN_ROLES and m['ref'] in relations:
            ways.extend(main_ways(relations[m['ref']], relations, seen))
    return ways


def main_parts(rel, relations):
    """A relation's main line (own main-role ways and its child routes'),
    chained and ordered end-to-end (chain_ways).

    A way that two child routes share (overlapping sections of the Trans
    Canada Trail) is drawn once: twice, it would chain into a line that runs
    out and back over itself and count its length twice. A way repeated in
    ONE relation is kept — that is a deliberate out-and-back (a spur to a
    summit and back), and member order chains it so."""
    owner, ways = {}, []
    for ref, rid, geom in main_ways(rel, relations):
        if ref is not None and owner.setdefault(ref, rid) != rid:
            continue
        ways.append(geom)
    return [p for p in chain_ways(ways) if len(p) >= 2]


def reversed_parts(parts):
    return [list(reversed(p)) for p in reversed(parts)]


def stage_relations(rel, relations):
    """Direct child routes, in member order — the trail's stages."""
    out = []
    for m in rel.get('members', []):
        role = (m.get('role') or '').strip()
        if m.get('type') == 'relation' and role in MAIN_ROLES and m['ref'] in relations:
            child = relations[m['ref']]
            if (child.get('tags') or {}).get('type') in ('route', 'superroute'):
                out.append(child)
    return out


def clean(value, limit=200):
    if value is None:
        return None
    s = str(value).strip()
    return s[:limit] if s else None


def popularity(tags, km, sitelinks, has_stages):
    raw = NETWORK_WEIGHT[level_of(tags)]
    if tags.get('wikipedia') or tags.get('wikidata'):
        raw += 0.15
    if sitelinks:
        raw += 0.35 * min(1.0, math.log10(1 + sitelinks) / math.log10(41))
    if km > 0:
        raw += 0.15 * max(0.0, min(1.0, math.log10(km / 20) / 2))
    if has_stages:
        raw += 0.05
    return round(min(1.0, raw / POP_MAX), 3)


def stage_name(tags, n, parent_name=None, region=None):
    """A stage's name; one that only repeats its trail's (the Appalachian
    Trail's state sections are all "Appalachian Trail") says where it runs."""
    name = clean(tags.get('name'))
    if name and (parent_name is None or normalize_name(name) != normalize_name(parent_name)):
        return name
    f, t = clean(tags.get('from')), clean(tags.get('to'))
    if f and t:
        return f'{f} → {t}'
    if region:
        return region
    return name or f'Stage {n}'


def build_trail(rel, relations, sitelinks, regions):
    tags = rel.get('tags') or {}
    stages = []
    for child in stage_relations(rel, relations):
        parts = main_parts(child, relations)
        if parts:
            stages.append((child, parts))
    # Stages in trail order, each running the trail's way (order_stages): a
    # section mapped in the other direction (the Appalachian Trail's
    # Virginia, the Balcon du Léman stages the GR 5 walks backwards) is
    # turned round — its from/to with it.
    order = order_stages([(parts[0][0], parts[-1][-1]) for _, parts in stages])
    stage_docs = []
    all_parts = []
    for n, (i, flipped) in enumerate(order, start=1):
        child, parts = stages[i]
        ctags = dict(child.get('tags') or {})
        if flipped:
            parts = reversed_parts(parts)
            ctags['from'], ctags['to'] = ctags.get('to'), ctags.get('from')
        simplified, _ = simplify_parts(parts, SIMPLIFY_M, MAX_DETAIL_POINTS)
        doc = {
            'id': f"r{child['id']}",
            'name': stage_name(
                ctags,
                n,
                display_name(tags),
                regions.region(point_at_fraction(parts, 0.5)) if regions.admin1 else None,
            ),
            'km': round(sum(line_length_m(p) for p in parts) / 1000, 1),
            'geom': [encode_polyline(p) for p in simplified if len(p) >= 2],
        }
        for key in ('from', 'to'):
            if clean(ctags.get(key)):
                doc[key] = clean(ctags.get(key))
        stage_docs.append(doc)
        all_parts.extend(parts)
    single = None
    if len(stage_docs) == 1:
        # One stage is no stages: a wrapper around its one route.
        single = stages[0][0]
        stage_docs = []
    own = main_parts(rel, relations) if not stage_docs else all_parts
    if not own:
        return None
    km = sum(line_length_m(p) for p in own) / 1000
    level = level_of(tags)
    floor = MIN_KM_INTL_NATIONAL if level in ('i', 'n') else MIN_KM_OTHER
    if km < floor:
        return None
    acts = activities_of(tags) or ['hiking']
    name = display_name(tags)
    names = {}
    for lang in ('fr', 'en'):
        value = clean(tags.get(f'name:{lang}'))
        if value and value != name:
            names[lang] = value
    bbox = bbox_of(own)
    mid = point_at_fraction(own, 0.5)
    thumb_tol = max(bbox_diag_km(bbox) * 1000 / 150, 20.0)
    # The thumbnail is a picture of the trail's shape: gaps OSM hasn't mapped
    # yet (the Sentier National is a string of sections) would read as a
    # broken line at 64 px, so small ones are bridged — the detail keeps them.
    bridged = bridge_parts(own, bbox_diag_km(bbox) * 1000 * THUMB_BRIDGE_FRACTION)
    thumb, _ = simplify_parts(bridged, thumb_tol, THUMB_POINTS)
    thumb = [p for p in thumb if len(p) >= 2]
    # Countries along the trail (21 samples), most-travelled first; the
    # region is the midpoint's, else the most-travelled one (a midpoint on a
    # bridge or an island Natural Earth doesn't draw has none).
    ccs = []
    region = None
    if regions.names:
        tally = {}
        region_tally = {}
        for i in range(21):
            pt = point_at_fraction(own, i / 20)
            hit = regions.country(pt)
            if hit:
                tally[hit] = tally.get(hit, 0) + 1
            rg = regions.region(pt)
            if rg:
                region_tally[rg] = region_tally.get(rg, 0) + 1
        ccs = [c for c, _ in sorted(tally.items(), key=lambda kv: -kv[1])]
        region = regions.region(mid) or next(
            iter(sorted(region_tally, key=lambda k: -region_tally[k])), None
        )
    q = (tags.get('wikidata') or '').strip()
    if not q and single is not None:
        q = ((single.get('tags') or {}).get('wikidata') or '').strip()
    pop = popularity(tags, km, sitelinks.get(q, 0), bool(stage_docs))
    index_row = {
        'id': f"r{rel['id']}",
        'n': name,
        **({'nf': names['fr']} if 'fr' in names else {}),
        **({'ne': names['en']} if 'en' in names else {}),
        'a': acts,
        'net': level,
        'km': round(km, 1),
        'b': bbox,
        'c': [round(mid[0], 5), round(mid[1], 5)],
        'p': pop,
        **({'cc': [c[0] for c in ccs]} if ccs else {}),
        **({'rg': region} if region else {}),
        **({'st': len(stage_docs)} if stage_docs else {}),
        **({'fr': clean(tags.get('from'), 80)} if clean(tags.get('from'), 80) else {}),
        **({'to': clean(tags.get('to'), 80)} if clean(tags.get('to'), 80) else {}),
        't': [encode_polyline(p, 4) for p in thumb],
    }
    simplified, _ = simplify_parts(own, SIMPLIFY_M, MAX_DETAIL_POINTS)
    detail = {
        'schema': 1,
        'id': index_row['id'],
        'name': name,
        **({'names': names} if names else {}),
        'acts': acts,
        'net': level,
        'km': index_row['km'],
        'bbox': bbox,
        **({'stages': stage_docs} if stage_docs else {}),
        **({} if stage_docs else {'geom': [encode_polyline(p) for p in simplified]}),
    }
    for key, limit in (
        ('from', 120),
        ('to', 120),
        ('ref', 40),
        ('operator', 120),
        ('website', 300),
        ('wikipedia', 200),
        ('wikidata', 20),
        ('description', DESCRIPTION_MAX),
    ):
        value = clean(tags.get(key), limit)
        if value:
            detail[key] = value
    if (tags.get('roundtrip') or '').strip() == 'yes':
        detail['roundtrip'] = True
    return index_row, detail, ccs


def bbox_iou(a, b):
    w, s = max(a[0], b[0]), max(a[1], b[1])
    e, n = min(a[2], b[2]), min(a[3], b[3])
    if e <= w or n <= s:
        return 0.0
    inter = (e - w) * (n - s)
    area = lambda x: (x[2] - x[0]) * (x[3] - x[1])  # noqa: E731
    return inter / max(1e-12, area(a) + area(b) - inter)


def merge_duplicates(rows):
    """One row per trail: same name + overlapping bbox (summer hike / winter ski twins)."""
    by_name = {}
    for row in rows:
        by_name.setdefault(normalize_name(row['n']), []).append(row)
    out = []
    dropped = set()
    for group in by_name.values():
        group.sort(key=lambda r: (-r['p'], -r['km']))
        for i, keep in enumerate(group):
            if keep['id'] in dropped:
                continue
            for other in group[i + 1 :]:
                if other['id'] not in dropped and bbox_iou(keep['b'], other['b']) >= 0.5:
                    for a in other['a']:
                        if a not in keep['a']:
                            keep['a'].append(a)
                    dropped.add(other['id'])
            out.append(keep)
    return out, dropped


def build(work, out_dir, ne_dir=None, version=None):
    raw = os.path.join(work, 'raw')
    relations = load_relations(raw)
    sitelinks = {}
    wd = os.path.join(raw, 'wikidata.json')
    if os.path.exists(wd):
        with open(wd, encoding='utf-8') as f:
            sitelinks = json.load(f)
    candidates = set()
    for name in os.listdir(raw):
        if name.startswith('tags-') and name.endswith('.json'):
            with open(os.path.join(raw, name), encoding='utf-8') as f:
                for el in json.load(f)['elements']:
                    if el.get('type') == 'relation' and is_candidate(el):
                        candidates.add(el['id'])
    # A wrapper holding a single main route and no way of its own (the "Tour
    # du Mont Blanc" superroute around its "Itinéraire principal" and its
    # variants) is ONE trail: the wrapper keeps its name, its route is not
    # listed again (and is not a one-stage "stage" either — see build_trail).
    wrapped = {
        relation_members(relations.get(rid), main_only=True)[0]
        for rid in candidates
        if len(relation_members(relations.get(rid), main_only=True)) == 1
        and not own_main_ways(relations.get(rid))
    }
    # A relation that is a member of another candidate is a stage, not a
    # trail — unless it is notable in its own right (NOTABLE_SITELINKS): the
    # Appalachian Trail is a stage of the Eastern Continental Trail and still
    # a trail, while its state sections are only its stages.
    # Parents are every fetched route of ours, not only the candidates: an
    # intermediate level ("Sentier international des Appalaches, Québec")
    # holds one way and its sections, so its `bb` is tiny and it never became
    # a candidate — its sections must still stay its (grand-parent's) stages.
    parents = {}
    for rel in relations.values():
        tags = rel.get('tags') or {}
        if tags.get('type') in ('route', 'superroute') and activities_of(tags):
            for c in relation_members(rel):
                parents.setdefault(c, []).append(rel['id'])
    children = {
        c for c in parents if not stands_alone(c, relations, parents, sitelinks)
    } | wrapped
    regions = Regions(ne_dir)
    rows, details, countries = [], {}, {}
    for rid in sorted(candidates - children):
        rel = relations.get(rid)
        if rel is None:
            continue
        built = build_trail(rel, relations, sitelinks, regions)
        if built is None:
            continue
        row, detail, ccs = built
        rows.append(row)
        details[row['id']] = detail
        for iso, name, continent in ccs:
            countries[iso] = [name, continent]
    rows, dropped = merge_duplicates(rows)
    for row in rows:
        details[row['id']]['acts'] = row['a']
    rows.sort(key=lambda r: (-r['p'], r['n']))
    version = version or time.strftime('%Y%m%d%H%M')
    os.makedirs(out_dir, exist_ok=True)

    offsets = {}
    bin_path = os.path.join(out_dir, f'trails-{version}.details.bin')
    with open(bin_path + '.tmp', 'wb') as f:
        pos = 0
        for row in rows:
            blob = json.dumps(details[row['id']], ensure_ascii=False, separators=(',', ':'))
            data = blob.encode('utf-8')
            f.write(data)
            offsets[row['id']] = [pos, len(data)]
            pos += len(data)
    os.replace(bin_path + '.tmp', bin_path)
    write_json(os.path.join(out_dir, f'trails-{version}.offsets.json'), offsets)
    index = {
        'schema': 1,
        'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'details': version,
        'attribution': '© OpenStreetMap contributors (ODbL)',
        'countries': dict(sorted(countries.items())),
        'trails': rows,
    }
    write_json(os.path.join(out_dir, 'trails-v1.index.json'), index)
    log(
        f'{len(rows)} trails ({len(dropped)} merged twins), '
        f'{sum(1 for r in rows if r.get("st"))} with stages; details {pos / 1e6:.1f} MB'
    )
    print(len(rows))
    return len(rows)


def main(argv):
    if len(argv) == 4 and argv[1] == 'fetch':
        fetch(argv[2], argv[3])
        return 0
    if len(argv) == 3 and argv[1] == 'wikidata':
        wikidata(argv[2])
        return 0
    if len(argv) >= 4 and argv[1] == 'build':
        opts = dict(zip(argv[4::2], argv[5::2]))
        build(argv[2], argv[3], opts.get('--ne'), opts.get('--version'))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))

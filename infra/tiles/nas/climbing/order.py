"""Left-to-right order of a sector's routes, as seen standing at the foot of
the wall (DESIGN.md §4.1). Only OSM gives route-start positions, so only OSM
sectors are ever ordered; anything else gets the grade chart in the app, never
a guessed wall.

The viewer's right-hand direction comes from, in order:
1. `climbing:orientation` (the way the wall faces): facing azimuth θ → the
   viewer looks at θ + 180°, their right is θ − 90°;
2. the wall line (`natural=cliff`, the sector's own way, a member way, or the
   nearest cliff within 40 m of the starts): the viewer stands on the side
   where the route starts are and faces the line, so their right runs along
   the line in the direction that keeps the starts on its right. When the
   starts sit on the line itself (no side to read), OSM's cliff convention
   decides (the cliff's lower side is to the right of the way's direction, so
   the way runs left to right as seen from below).
Without either, the order is unknown (None).
"""
import math

from common import local_xy

ORIENT = {
    'N': 0, 'NNE': 22.5, 'NE': 45, 'ENE': 67.5, 'E': 90, 'ESE': 112.5, 'SE': 135, 'SSE': 157.5,
    'S': 180, 'SSW': 202.5, 'SW': 225, 'WSW': 247.5, 'W': 270, 'WNW': 292.5, 'NW': 315, 'NNW': 337.5,
}
# Starts mapped within this of the line are "on" it: mappers drop route starts
# on the traced wall, a few metres either side (Weir's Black and White sits
# 1–6 m north of its south-facing cliff line), so only a clear offset says
# which side the foot of the wall is on.
SIDE_MIN_M = 8.0
SIDE_AGREE = 0.7
MIN_SPREAD_M = 2.0
CLIFF_NEAR_M = 40.0


def facing_azimuth(tag):
    """'S' → 180, 'south-west' → 225, '200' → 200; None when unreadable or mixed ('N;S')."""
    if not tag:
        return None
    t = tag.strip().upper().replace('-', '').replace(' ', '')
    if ';' in t:
        return None
    words = {'NORTH': 'N', 'SOUTH': 'S', 'EAST': 'E', 'WEST': 'W'}
    for w, s in words.items():
        t = t.replace(w, s)
    if t in ORIENT:
        return float(ORIENT[t])
    try:
        v = float(t)
    except ValueError:
        return None
    return v % 360 if 0 <= v <= 360 else None


def _unit_from_azimuth(az):
    r = math.radians(az)
    return (math.sin(r), math.cos(r))  # (east, north)


def _nearest_segment(line, p):
    """Index of the line segment closest to p, and the distance (local metres)."""
    best, best_d = 0, float('inf')
    for i in range(len(line) - 1):
        (ax, ay), (bx, by) = line[i], line[i + 1]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2))
        qx, qy = ax + t * dx, ay + t * dy
        d = math.hypot(p[0] - qx, p[1] - qy)
        if d < best_d:
            best, best_d = i, d
    return best, best_d


def line_distance_m(line_ll, lat, lng):
    """Distance from a point to a [(lat, lng)] polyline, in metres."""
    f = local_xy(lat, lng)
    line = [f(a, b) for a, b in line_ll]
    if len(line) == 1:
        return math.hypot(*line[0])
    return _nearest_segment(line, (0.0, 0.0))[1]


def right_from_line(line_ll, starts_ll):
    """The viewer's right-hand unit vector (east, north) from a wall line, or None."""
    if len(line_ll) < 2 or not starts_ll:
        return None
    lat0 = sum(p[0] for p in starts_ll) / len(starts_ll)
    lng0 = sum(p[1] for p in starts_ll) / len(starts_ll)
    f = local_xy(lat0, lng0)
    line = [f(a, b) for a, b in line_ll]
    pts = [f(a, b) for a, b in starts_ll]
    # The line's direction near the starts: the sum of the nearest segments' directions.
    dx = dy = 0.0
    signs = []
    for p in pts:
        i, d = _nearest_segment(line, p)
        (ax, ay), (bx, by) = line[i], line[i + 1]
        sx, sy = bx - ax, by - ay
        n = math.hypot(sx, sy) or 1.0
        dx += sx / n
        dy += sy / n
        if d >= SIDE_MIN_M:
            # cross(segment, start − a) < 0 → the start is to the right of the way.
            cross = sx * (p[1] - ay) - sy * (p[0] - ax)
            signs.append(-1 if cross < 0 else 1)
    n = math.hypot(dx, dy)
    if n == 0:
        return None
    ux, uy = dx / n, dy / n
    if len(signs) >= max(1, len(pts) // 2):
        right = sum(1 for s in signs if s < 0) / len(signs)
        if right >= SIDE_AGREE:
            return (ux, uy)
        if right <= 1 - SIDE_AGREE:
            return (-ux, -uy)
        return None  # starts on both sides: no reading
    return (ux, uy)  # starts on the line: OSM's cliff convention


def order_routes(starts_ll, facing=None, line_ll=None):
    """Left-to-right indices of `starts_ll` [(lat, lng)], or None when unknown."""
    if len(starts_ll) < 2:
        return None
    if facing is not None:
        r = _unit_from_azimuth((facing - 90) % 360)
    elif line_ll:
        r = right_from_line(line_ll, starts_ll)
    else:
        r = None
    if r is None:
        return None
    lat0 = sum(p[0] for p in starts_ll) / len(starts_ll)
    lng0 = sum(p[1] for p in starts_ll) / len(starts_ll)
    f = local_xy(lat0, lng0)
    proj = [(f(a, b)[0] * r[0] + f(a, b)[1] * r[1], i) for i, (a, b) in enumerate(starts_ll)]
    if max(p for p, _ in proj) - min(p for p, _ in proj) < MIN_SPREAD_M:
        return None
    return [i for _, i in sorted(proj)]

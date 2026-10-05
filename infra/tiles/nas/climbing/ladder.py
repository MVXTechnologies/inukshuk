"""The thinning ladder for the crag layer (DESIGN.md §4.3): one crag per
CELL_PX screen cell from z4 to z9, the biggest (most routes) first; every crag
from z10. A crag's minzoom is the first zoom where it wins its cell. Grids at
successive zooms nest, so the ladder is deterministic.
"""
import math
import zlib

LADDER_MIN = 4
LADDER_MAX = 9
FULL_ZOOM = 10
CELL_PX = 40


def world_px(lat, lng, z):
    scale = 256 * 2**z
    x = (lng + 180) / 360 * scale
    s = math.sin(math.radians(max(-85.0511, min(85.0511, lat))))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * scale
    return x, y


def _size(c):
    n = sum(len(s['routes']) for s in c.get('sectors') or [])
    return n or c.get('declared') or 0


def rank_key(c):
    closed = 1 if (c.get('access') or {}).get('status') in ('closed', 'banned') else 0
    return (closed, -_size(c), zlib.crc32(c['uid'].encode()))


def assign_minzoom(crags):
    ranked = sorted(crags, key=rank_key)
    for c in crags:
        c['minzoom'] = FULL_ZOOM
    pts = [world_px(c['lat'], c['lng'], LADDER_MAX) for c in ranked]
    placed = [False] * len(ranked)
    for z in range(LADDER_MIN, LADDER_MAX + 1):
        div = 2 ** (LADDER_MAX - z) * CELL_PX
        taken = set()
        for i, (x, y) in enumerate(pts):
            if placed[i]:
                taken.add((int(x // div), int(y // div)))
        for i, (x, y) in enumerate(pts):
            if placed[i]:
                continue
            cell = (int(x // div), int(y // div))
            if cell not in taken:
                taken.add(cell)
                placed[i] = True
                ranked[i]['minzoom'] = z
    hist = {}
    for c in crags:
        hist[c['minzoom']] = hist.get(c['minzoom'], 0) + 1
    return hist

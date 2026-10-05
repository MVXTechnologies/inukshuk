"""The thinning ladder: a per-mark minzoom (DESIGN.md §5.2).

For each zoom from LADDER_MIN to LADDER_MAX, walk the marks in rank order and
keep one per CELL_PX screen cell; a mark's minzoom is the first zoom where it
wins its cell (marks that won earlier hold their cells first). Every live mark
is in the tiles from FULL_ZOOM. Low-precision marks (posAcc ≥ LOW_PRECISION_M)
take no cell: they enter at FULL_ZOOM with their `p`, and the app draws them
only from z15 (a separate layer) — a symbol at z14 would claim an accuracy
their position doesn't have.

Grids at successive zooms nest (a cell at z+1 is a quarter of one at z), so
the ladder is deterministic and can run per partition.
"""
import math
import zlib

from catalog import TYPE_RANK, is_modern, wgs_offset_m

LADDER_MIN = 5
LADDER_MAX = 13
FULL_ZOOM = 14
CELL_PX = 18
LOW_PRECISION_M = 10.0
STATUS_RANK = {'ok': 0, 'damaged': 1, 'unknown': 2}


def world_px(lat, lng, z):
    """Web-Mercator pixel coordinates (256-px tiles) at zoom z."""
    scale = 256 * 2 ** z
    x = (lng + 180) / 360 * scale
    s = math.sin(math.radians(max(-85.0511, min(85.0511, lat))))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * scale
    return x, y


def _visit_year(rec):
    v = rec.get('lastVisit') or ''
    try:
        return int(v[:4])
    except ValueError:
        return 0


def rank_key(rec):
    legacy = 0 if rec['src'] == 'osm' or is_modern(rec['datum']) else 1
    return (
        TYPE_RANK.get(rec['type'], 3),
        1 if rec['src'] == 'osm' else 0,
        STATUS_RANK.get(rec['status'], 2),
        legacy,
        -_visit_year(rec),
        zlib.crc32(rec['uid'].encode()),
    )


def low_precision(rec):
    """Our drawn position may be ≥ 10 m off: a scaled position, or a datum
    (NAD27) whose lat/lon drawn as WGS 84 lands that far away."""
    off = 0 if rec['src'] == 'osm' else wgs_offset_m(rec['datum'])
    return max(rec.get('posAcc') or 0, off) >= LOW_PRECISION_M


def assign_minzoom(records):
    """Set rec['minzoom'] on every record; returns {zoom: count entering there}."""
    ranked = sorted((r for r in records if not low_precision(r)), key=rank_key)
    for r in records:
        r['minzoom'] = FULL_ZOOM
    pts = [world_px(r['lat'], r['lng'], LADDER_MAX) for r in ranked]
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
    for r in records:
        hist[r['minzoom']] = hist.get(r['minzoom'], 0) + 1
    return hist

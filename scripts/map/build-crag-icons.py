#!/usr/bin/env python3
"""Render the climbing-crag map badges (Explore → Climbing, Settings →
Extensions → Climbing crags).

    python3 scripts/map/build-crag-icons.py

Writes assets/map/climbing/crag-{hollow|saved|closed}-{light|dark}{,@2x,@3x}.png
from src/core/climbing/palette.json: a rounded square (distinct from
Explore's discs and the geodetic shapes) with a rock glyph. Hollow = a crag
streamed from the tiles; filled = saved on the phone; grey = access closed or
banned. A halo in the theme's paper keeps them legible on any base. Standard
library only: shapes are sampled 4×4 per pixel.
"""
import json
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PALETTE = json.load(open(os.path.join(ROOT, 'src/core/climbing/palette.json')))
OUT = os.path.join(ROOT, 'assets/map/climbing')
SIZE = 26  # logical px; centred, so the icon anchors at its middle
HALF = 10.0  # the square's half side
RADIUS = 3.6
HALO = 1.6
RING = 1.9
SS = 4
# The rock glyph: two peaks, the left one taller (Material's "terrain" shape).
GLYPH = [(-6.6, 4.6), (-1.6, -3.9), (1.6, 0.9), (3.0, -1.1), (6.6, 4.6)]


def sd_round_square(x, y, half, r):
    qx, qy = abs(x) - (half - r), abs(y) - (half - r)
    ox, oy = max(qx, 0.0), max(qy, 0.0)
    return (ox * ox + oy * oy) ** 0.5 + min(max(qx, qy), 0.0) - r


def inside(poly, x, y):
    c = False
    n = len(poly)
    for i in range(n):
        (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            c = not c
    return c


def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def over(dst, src, a):
    r, g, b, da = dst
    oa = a + da * (1 - a)
    if oa <= 0:
        return (0, 0, 0, 0)
    mix = [(s * a + d * da * (1 - a)) / oa for s, d in zip(src, (r, g, b))]
    return (mix[0], mix[1], mix[2], oa)


def colours(kind, theme):
    p = PALETTE[theme]
    paper = hex_rgb(p['halo'])
    if kind == 'saved':
        return paper, hex_rgb(p['crag']), hex_rgb(p['cragInk']), None
    ink = hex_rgb(p['closed'] if kind == 'closed' else p['crag'])
    # Hollow: the paper inside, an ink ring and an ink glyph.
    return paper, hex_rgb(p['cragSoft']) if kind == 'hollow' else paper, ink, ink


def render(kind, theme, scale):
    halo, fill, glyph, ring = colours(kind, theme)
    n = SIZE * scale
    rows = []
    for py in range(n):
        row = bytearray()
        for px in range(n):
            c_halo = c_fill = c_ring = c_glyph = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / scale - SIZE / 2
                    y = (py + (sy + 0.5) / SS) / scale - SIZE / 2
                    d = sd_round_square(x, y, HALF, RADIUS)
                    if d <= HALO:
                        c_halo += 1
                    if d <= 0:
                        c_fill += 1
                        if ring is not None and d >= -RING:
                            c_ring += 1
                        if inside(GLYPH, x, y):
                            c_glyph += 1
            k = SS * SS
            px_rgba = over((0.0, 0.0, 0.0, 0.0), halo, c_halo / k)
            px_rgba = over(px_rgba, fill, c_fill / k)
            if ring is not None:
                px_rgba = over(px_rgba, ring, c_ring / k)
            px_rgba = over(px_rgba, glyph, c_glyph / k)
            row += bytes(int(round(c)) for c in px_rgba[:3]) + bytes([int(round(px_rgba[3] * 255))])
        rows.append(bytes(row))
    return n, rows


def write_png(path, n, rows):
    raw = b''.join(b'\x00' + r for r in rows)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', n, n, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def main():
    os.makedirs(OUT, exist_ok=True)
    for theme in ('light', 'dark'):
        for kind in ('hollow', 'saved', 'closed'):
            for scale in (1, 2, 3):
                n, rows = render(kind, theme, scale)
                suffix = '' if scale == 1 else f'@{scale}x'
                write_png(os.path.join(OUT, f'crag-{kind}-{theme}{suffix}.png'), n, rows)
    print(f'wrote {len(os.listdir(OUT))} files to {OUT}')


if __name__ == '__main__':
    main()

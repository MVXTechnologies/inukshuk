#!/usr/bin/env python3
"""Render the geodetic-point map symbols (Settings → Extensions → Geodetic points).

    python3 scripts/map/build-geodetic-icons.py

Writes assets/map/geodetic/geodetic-{type}[-o]-{light|dark}{,@2x,@3x}.png from
src/core/geodetic/palette.json — one image per mark type × fill × theme, so
the style picks one by name (`iconImageName` in @core/map/geodeticStyle) and
never needs a ["zoom"] inside an expression. Shape = type (3D ◉, horizontal
▲, vertical ●, GNSS ◆, unclassified ·); fill = datum (solid modern, hollow
legacy); colour = type; a halo in the theme's paper keeps them legible on any
base. Standard library only: shapes are signed-distance functions sampled 4×4
per pixel.
"""
import json
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PALETTE = json.load(open(os.path.join(ROOT, 'src/core/geodetic/palette.json')))
OUT = os.path.join(ROOT, 'assets/map/geodetic')
SIZE = 18  # logical px; the shapes are centred, so the icon anchors at its middle
HALO = 1.5
STROKE = 1.6
SS = 4


def sd_disc(x, y, r):
    return math.hypot(x, y) - r


def sd_diamond(x, y, r):
    return (abs(x) + abs(y) - r) / math.sqrt(2)


def sd_triangle(x, y, side):
    # Equilateral, pointing up, centroid at the origin (y grows downwards).
    h = side * math.sqrt(3) / 2
    top, base = -2 * h / 3, h / 3
    edges = []
    # base: y <= base
    edges.append(y - base)
    # two slanted sides through the apex (0, top) and base corners (±side/2, base)
    for sx in (1, -1):
        ax, ay = 0.0, top
        bx, by = sx * side / 2, base
        nx, ny = by - ay, -(bx - ax)  # outward normal for this winding
        if sx < 0:
            nx, ny = -nx, -ny
        ln = math.hypot(nx, ny)
        edges.append(((x - ax) * nx + (y - ay) * ny) / ln)
    return max(edges)


SHAPES = {
    '3d': lambda x, y: sd_disc(x, y, 5.6),
    'h': lambda x, y: sd_triangle(x, y + 0.4, 12.0),
    'v': lambda x, y: sd_disc(x, y, 4.4),
    'gnss': lambda x, y: sd_diamond(x, y, 6.2),
    'u': lambda x, y: sd_disc(x, y, 2.8),
}


def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def over(dst, src, a):
    """src (rgb) with coverage a over dst (r, g, b, alpha), straight alpha."""
    r, g, b, da = dst
    oa = a + da * (1 - a)
    if oa <= 0:
        return (0, 0, 0, 0)
    mix = [(s * a + d * da * (1 - a)) / oa for s, d in zip(src, (r, g, b))]
    return (mix[0], mix[1], mix[2], oa)


def render(kind, hollow, theme, scale):
    pal = PALETTE[theme]
    ink, halo = hex_rgb(pal[kind]), hex_rgb(pal['halo'])
    sd = SHAPES[kind]
    n = SIZE * scale
    rows = []
    for py in range(n):
        row = bytearray()
        for px in range(n):
            cov_halo = cov_ink = cov_dot = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / scale - SIZE / 2
                    y = (py + (sy + 0.5) / SS) / scale - SIZE / 2
                    d = sd(x, y)
                    if d <= HALO:
                        cov_halo += 1
                    if (d <= 0) if not hollow else (-STROKE <= d <= 0):
                        cov_ink += 1
                    if kind == '3d':
                        r = math.hypot(x, y)
                        if r <= (1.9 if not hollow else 1.7):
                            cov_dot += 1
            k = SS * SS
            px_rgba = (0.0, 0.0, 0.0, 0.0)
            px_rgba = over(px_rgba, halo, cov_halo / k)
            px_rgba = over(px_rgba, ink, cov_ink / k)
            if kind == '3d':
                # Solid ◉: a paper centre in the disc; hollow: an ink dot in the ring.
                px_rgba = over(px_rgba, halo if not hollow else ink, cov_dot / k)
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
        for kind in SHAPES:
            for hollow in (False, True):
                name = f"geodetic-{kind}{'-o' if hollow else ''}-{theme}"
                for scale in (1, 2, 3):
                    n, rows = render(kind, hollow, theme, scale)
                    suffix = '' if scale == 1 else f'@{scale}x'
                    write_png(os.path.join(OUT, f'{name}{suffix}.png'), n, rows)
    print(f'wrote {len(os.listdir(OUT))} files to {OUT}')


if __name__ == '__main__':
    main()

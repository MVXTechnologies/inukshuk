#!/usr/bin/env python3
"""Render the tide-station and tidal-benchmark map symbols.

    python3 scripts/map/build-tide-icons.py

Writes, from src/core/tides/palette.json:
- assets/map/tides/tide-{gauge,pred}-{light|dark}{,@2x,@3x}.png — marine-teal
  rounded square with a tide-staff-and-wave glyph; filled = live gauge,
  hollow = predictions / secondary / historic (owner Q3a: teal stations);
- assets/map/geodetic/geodetic-tbm-{light|dark}{,@2x,@3x}.png — the tidal
  benchmark: the geodetic red disc crossed by a paper wave line (owner Q2a).

One image per kind × theme, so the style picks one by name and never needs
["zoom"] inside an expression. Standard library only (signed-distance shapes
sampled 4×4 per pixel), like build-geodetic-icons.py.
"""
import json
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PALETTE = json.load(open(os.path.join(ROOT, 'src/core/tides/palette.json')))
SS = 4


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


def sd_round_rect(x, y, half, r):
    qx, qy = abs(x) - (half - r), abs(y) - (half - r)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


def sd_segment(x, y, ax, ay, bx, by):
    px, py, vx, vy = x - ax, y - ay, bx - ax, by - ay
    t = max(0.0, min(1.0, (px * vx + py * vy) / (vx * vx + vy * vy)))
    return math.hypot(px - vx * t, py - vy * t)


def sd_wave(x, y, x0, x1, y0, amp, period):
    """Distance (approx.) to a sine wave y = y0 + amp·sin(2π(x−x0)/period), x0 ≤ x ≤ x1."""
    best = 1e9
    steps = 24
    prev = None
    for i in range(steps + 1):
        xx = x0 + (x1 - x0) * i / steps
        yy = y0 + amp * math.sin(2 * math.pi * (xx - x0) / period)
        if prev is not None:
            best = min(best, sd_segment(x, y, prev[0], prev[1], xx, yy))
        prev = (xx, yy)
    return best


def glyph(x, y):
    """Tide staff (vertical bar with ticks) + a wave across its foot. Units: logical px, centred."""
    d = sd_segment(x, y, -2.2, -5.0, -2.2, 3.0) - 0.9
    for ty in (-4.0, -2.0, 0.0):
        d = min(d, sd_segment(x, y, -2.2, ty, 0.6, ty) - 0.6)
    d = min(d, sd_wave(x, y, -5.6, 5.6, 4.0, 1.1, 5.6) - 0.85)
    return d


def render(size, scale, layers):
    """layers: [(sdf, rgb)] painted in order; coverage from sdf <= 0."""
    n = size * scale
    rows = []
    for py in range(n):
        row = bytearray()
        for px in range(n):
            acc = [0.0] * len(layers)
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / scale - size / 2
                    y = (py + (sy + 0.5) / SS) / scale - size / 2
                    for i, (sd, _) in enumerate(layers):
                        if sd(x, y) <= 0:
                            acc[i] += 1
            c = (0.0, 0.0, 0.0, 0.0)
            for (_, rgb), a in zip(layers, acc):
                c = over(c, rgb, a / (SS * SS))
            row += bytes(int(round(v)) for v in c[:3]) + bytes([int(round(c[3] * 255))])
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


def station_layers(theme, filled):
    pal = PALETTE[theme]
    teal, paper, halo = hex_rgb(pal['station']), hex_rgb(pal['stationFill']), hex_rgb(pal['halo'])
    half, r = 9.0, 3.2
    layers = [(lambda x, y: sd_round_rect(x, y, half + 1.4, r + 1.4), halo)]
    if filled:
        layers += [(lambda x, y: sd_round_rect(x, y, half, r), teal), (glyph, paper)]
    else:
        layers += [(lambda x, y: sd_round_rect(x, y, half, r), teal),
                   (lambda x, y: sd_round_rect(x, y, half - 1.8, r - 1.0), paper), (glyph, teal)]
    return layers


def tbm_layers(theme):
    pal = PALETTE[theme]
    red, halo = hex_rgb(pal['tidal']), hex_rgb(pal['halo'])
    return [
        (lambda x, y: math.hypot(x, y) - 7.0, halo),
        (lambda x, y: math.hypot(x, y) - 5.8, red),
        (lambda x, y: max(sd_wave(x, y, -4.6, 4.6, 0.3, 1.2, 4.6) - 0.85, math.hypot(x, y) - 5.0), halo),
    ]


def main():
    tides = os.path.join(ROOT, 'assets/map/tides')
    geo = os.path.join(ROOT, 'assets/map/geodetic')
    os.makedirs(tides, exist_ok=True)
    for theme in ('light', 'dark'):
        for scale in (1, 2, 3):
            suffix = '' if scale == 1 else f'@{scale}x'
            for name, filled in (('gauge', True), ('pred', False)):
                n, rows = render(22, scale, station_layers(theme, filled))
                write_png(os.path.join(tides, f'tide-{name}-{theme}{suffix}.png'), n, rows)
            n, rows = render(18, scale, tbm_layers(theme))
            write_png(os.path.join(geo, f'geodetic-tbm-{theme}{suffix}.png'), n, rows)
    print('wrote tide-station and tidal-benchmark icons')


if __name__ == '__main__':
    main()

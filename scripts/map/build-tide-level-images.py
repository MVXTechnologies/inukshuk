#!/usr/bin/env python3
"""Render the tide level labels' images (#764).

    python3 scripts/map/build-tide-level-images.py

Writes:
- assets/map/tides/levels/tide-pill-{1|2}-{w}.png — SDF pills (one or two
  lines of text) that `icon-text-fit` stretches behind a label; the style
  colours them (`icon-color`, `icon-halo-color`), so one set serves every
  kind and theme. Widths match PILL_WIDTHS in src/core/tides/levels.ts; the
  nearest one up is picked, so the stretch (and the corners' distortion)
  stays small. SDF encoding as MapLibre reads it (TinySDF): alpha =
  255·(0.75 − d/8), d the signed distance in px, positive outside; a 6 px
  margin holds the halo.
- assets/map/tides/levels/tide-arr-{up|down|flat}-{ink|label}-{light|dark}{,@2x,@3x}.png
  — the trend arrow, an inline image in the label's text (our glyphs have no
  arrows), in the label's text colour: `ink` on a live gauge's filled pill,
  `label` on the others. Colours from src/core/tides/palette.json.

Standard library only, like build-tide-icons.py.
"""
import json
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PALETTE = json.load(open(os.path.join(ROOT, 'src/core/tides/palette.json')))
OUT = os.path.join(ROOT, 'assets/map/tides/levels')
PILL_WIDTHS = [48, 64, 80, 104, 128, 152, 184, 216]
MARGIN = 6
SS = 4


def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def write_png(path, w, h, rows):
    raw = b''.join(b'\x00' + r for r in rows)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def sd_box(x, y, hw, hh, r):
    qx, qy = abs(x) - (hw - r), abs(y) - (hh - r)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


def pill(width, height, radius):
    w, h = width + 2 * MARGIN, height + 2 * MARGIN
    rows = []
    for py in range(h):
        row = bytearray()
        for px in range(w):
            d = sd_box(px + 0.5 - w / 2, py + 0.5 - h / 2, width / 2, height / 2, radius)
            a = max(0, min(255, round(255 * (0.75 - d / 8))))
            row += bytes([255, 255, 255, a])
        rows.append(bytes(row))
    return w, h, rows


def sd_segment(x, y, ax, ay, bx, by):
    px, py, vx, vy = x - ax, y - ay, bx - ax, by - ay
    t = max(0.0, min(1.0, (px * vx + py * vy) / (vx * vx + vy * vy)))
    return math.hypot(px - vx * t, py - vy * t)


def arrow_sd(direction):
    """An arrow in a 12 × 12 box (centred), pointing up-right, down-right or right."""
    angle = {'up': -math.pi / 4, 'down': math.pi / 4, 'flat': 0.0}[direction]
    c, s = math.cos(angle), math.sin(angle)

    def rot(x, y):
        return x * c - y * s, x * s + y * c

    tip = rot(4.2, 0)
    tail = rot(-4.2, 0)
    w1 = rot(0.6, -3.4)
    w2 = rot(0.6, 3.4)

    def sd(x, y):
        d = sd_segment(x, y, tail[0], tail[1], tip[0], tip[1])
        d = min(d, sd_segment(x, y, w1[0], w1[1], tip[0], tip[1]))
        d = min(d, sd_segment(x, y, w2[0], w2[1], tip[0], tip[1]))
        return d - 0.95

    return sd


def arrow(direction, rgb, scale):
    size = 12
    n = size * scale
    sd = arrow_sd(direction)
    rows = []
    for py in range(n):
        row = bytearray()
        for px in range(n):
            hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / scale - size / 2
                    y = (py + (sy + 0.5) / SS) / scale - size / 2
                    if sd(x, y) <= 0:
                        hits += 1
            row += bytes(rgb) + bytes([round(255 * hits / (SS * SS))])
        rows.append(bytes(row))
    return n, n, rows


def main():
    os.makedirs(OUT, exist_ok=True)
    for lines, height, radius in ((1, 18, 9), (2, 34, 8)):
        for width in PILL_WIDTHS:
            w, h, rows = pill(width, height, radius)
            write_png(os.path.join(OUT, f'tide-pill-{lines}-{width}.png'), w, h, rows)
    for theme in ('light', 'dark'):
        inks = {'ink': hex_rgb(PALETTE[theme]['levelInk']), 'label': hex_rgb(PALETTE[theme]['label'])}
        for direction in ('up', 'down', 'flat'):
            for ink, rgb in inks.items():
                for scale, suffix in ((1, ''), (2, '@2x'), (3, '@3x')):
                    w, h, rows = arrow(direction, rgb, scale)
                    name = f'tide-arr-{direction}-{ink}-{theme}{suffix}.png'
                    write_png(os.path.join(OUT, name), w, h, rows)


if __name__ == '__main__':
    main()

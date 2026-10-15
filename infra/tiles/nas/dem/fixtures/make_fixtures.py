#!/usr/bin/env python3
"""How the fixtures next to this file were made (needs the `pmtiles` CLI; run once).

- coverage-index-edge.pmtiles, coverage-edge.pmtiles: Mapterhorn's own coverage
  files cut to a few macrotiles on the northern edge of HRDEM coverage
  (Lac-Saint-Jean, z12 1226–1228 / 1410–1412):
      pmtiles extract https://download.mapterhorn.com/coverage-index.pmtiles \\
          coverage-index-edge.pmtiles --bbox=-72.24,48.64,-71.99,48.80
      pmtiles extract https://download.mapterhorn.com/coverage.pmtiles \\
          coverage-edge.pmtiles --bbox=-72.24,48.64,-71.99,48.80 --minzoom=12 --maxzoom=12
- webp-sample.pmtiles: synthetic 512-px lossless WebP Terrarium tiles, as
  Mapterhorn publishes them (this script).
- png-sample.pmtiles: transcode.py's 256-px PNG output of webp-sample, through
  `pmtiles convert` (this script) — the verify step's test input.
"""
import io
import os
import sqlite3
import subprocess
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
# z15 tiles over the coverage-edge macrotile 12/1227/1411 (its z15 children: x 9816–9823).
TILES = [(15, 9816, 11288), (15, 9817, 11288), (14, 4908, 5644)]


def terrarium(h):
    v = round((h + 32768) * 256)
    return v >> 16, (v >> 8) & 255, v & 255


def webp_tile(z, x, y, transparent=False):
    img = Image.new('RGBA' if transparent else 'RGB', (512, 512))
    px = img.load()
    for j in range(512):
        for i in range(512):
            h = 250 + ((x * 512 + i) % 700) * 0.25 - ((y * 512 + j) % 300) / 7.0
            rgb = terrarium(h)
            px[i, j] = rgb + (255,) if transparent else rgb
    if transparent:
        px[3, 3] = (0, 0, 0, 0)
    out = io.BytesIO()
    img.save(out, 'WEBP', lossless=True, quality=100, method=4)
    return out.getvalue()


def main():
    mb = os.path.join(HERE, 'webp-sample.mbtiles')
    if os.path.exists(mb):
        os.remove(mb)
    db = sqlite3.connect(mb)
    db.executescript('CREATE TABLE metadata (name TEXT, value TEXT);'
                     'CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER,'
                     ' tile_row INTEGER, tile_data BLOB);')
    db.executemany('INSERT INTO metadata VALUES (?, ?)',
                   [('name', 'webp-sample'), ('format', 'webp'), ('minzoom', '14'),
                    ('maxzoom', '15'), ('bounds', '-72.25,48.63,-71.98,48.81')])
    for z, x, y in TILES:
        data = webp_tile(z, x, y, transparent=(z == 14))
        db.execute('INSERT INTO tiles VALUES (?, ?, ?, ?)', (z, x, (1 << z) - 1 - y, data))
    db.commit()
    db.close()
    out = os.path.join(HERE, 'webp-sample.pmtiles')
    if os.path.exists(out):
        os.remove(out)
    subprocess.run(['pmtiles', 'convert', mb, out], check=True)
    os.remove(mb)

    # png-sample.pmtiles: transcode.py's output for those tiles, converted.
    sys.path.insert(0, os.path.dirname(HERE))
    from coverage import FULL, Mask
    from transcode import run
    mask = Mask({(1227, 1411): FULL}).to_json()
    png_mb = os.path.join(HERE, 'png-sample.mbtiles')
    if os.path.exists(png_mb):
        os.remove(png_mb)
    run(mask, [out], png_mb, {'name': 'png-sample', 'format': 'png'}, jobs=1, log=print)
    png_out = os.path.join(HERE, 'png-sample.pmtiles')
    if os.path.exists(png_out):
        os.remove(png_out)
    subprocess.run(['pmtiles', 'convert', png_mb, png_out], check=True)
    os.remove(png_mb)


if __name__ == '__main__':
    sys.exit(main())

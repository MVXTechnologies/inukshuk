"""Mapterhorn 512-px lossless WebP tiles → 256-px Terrarium PNG tiles, bit for bit.

A 512-px tile at zoom z covers exactly the four 256-px tiles at z + 1, on the
same Web Mercator grid, so each quadrant is cut out as is: no resampling, the
RGB bytes (Terrarium: h = R·256 + G + B/256 − 32768 m) unchanged. Every PNG
written is decoded again and compared with the quadrant's bytes before it is
stored; a mismatch stops the run. Only quadrants the LiDAR mask allows
(coverage.py) are kept.

Output: an MBTiles file (SQLite), written in batches; the source tiles already
processed are recorded in the same transactions, so an interrupted run resumes
where it stopped. `pmtiles convert` turns it into the archive the Worker serves.
"""
import hashlib
import io
import json
import multiprocessing
import os
import sqlite3
import sys
import threading
import time

from PIL import Image

from coverage import Mask
from pmtiles_lite import Reader, zxy_to_tileid

SRC_SIZE = 512
OUT_SIZE = 256
MAX_SRC_ZOOM = 15
PNG_LEVEL = int(os.environ.get('DEM_PNG_LEVEL', '6'))


class TranscodeError(Exception):
    pass


def decode_webp(data):
    """512 × 512 RGB image; refuses anything else (and any transparent pixel)."""
    img = Image.open(io.BytesIO(data))
    if img.format != 'WEBP':
        raise TranscodeError(f'not a WebP tile ({img.format})')
    img.load()
    if img.size != (SRC_SIZE, SRC_SIZE):
        raise TranscodeError(f'unexpected tile size {img.size}')
    if img.mode == 'RGBA':
        if img.getchannel('A').getextrema()[0] != 255:
            return None  # nodata pixels: never served
        img = img.convert('RGB')
    elif img.mode != 'RGB':
        raise TranscodeError(f'unexpected mode {img.mode}')
    return img


def encode_png(raw, level=PNG_LEVEL):
    """Raw 256 × 256 RGB bytes → PNG bytes, verified to decode to exactly `raw`."""
    if len(raw) != OUT_SIZE * OUT_SIZE * 3:
        raise TranscodeError('quadrant has the wrong length')
    out = io.BytesIO()
    Image.frombytes('RGB', (OUT_SIZE, OUT_SIZE), raw).save(out, 'PNG', compress_level=level)
    png = out.getvalue()
    back = Image.open(io.BytesIO(png))
    back.load()
    if back.mode != 'RGB' or back.size != (OUT_SIZE, OUT_SIZE) or back.tobytes() != raw:
        raise TranscodeError('PNG round trip is not bit-exact')
    return png


def quadrants(z, x, y, data, wanted):
    """[(z+1, x', y', png, raw_sha256)] for the quadrants `wanted(z', x', y')` accepts."""
    keep = [(dx, dy) for dy in (0, 1) for dx in (0, 1)
            if wanted(z + 1, 2 * x + dx, 2 * y + dy)]
    if not keep:
        return []
    img = decode_webp(data)
    if img is None:
        return []
    out = []
    for dx, dy in keep:
        box = (dx * OUT_SIZE, dy * OUT_SIZE, (dx + 1) * OUT_SIZE, (dy + 1) * OUT_SIZE)
        raw = img.crop(box).tobytes()
        out.append((z + 1, 2 * x + dx, 2 * y + dy, encode_png(raw),
                    hashlib.sha256(raw).hexdigest()))
    return out


# --- MBTiles -----------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER,
  tile_data BLOB, PRIMARY KEY (zoom_level, tile_column, tile_row));
CREATE TABLE IF NOT EXISTS pixels (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER,
  sha256 TEXT, PRIMARY KEY (zoom_level, tile_column, tile_row));
CREATE TABLE IF NOT EXISTS done (src_id INTEGER PRIMARY KEY);
"""


def open_mbtiles(path, metadata):
    db = sqlite3.connect(path)
    db.executescript(SCHEMA)
    db.executemany('INSERT OR REPLACE INTO metadata VALUES (?, ?)', sorted(metadata.items()))
    db.commit()
    return db


def tms_row(z, y):
    """MBTiles rows count from the south (TMS)."""
    return (1 << z) - 1 - y


# --- the run -----------------------------------------------------------------------

_MASK = None


def _init(mask_json):
    global _MASK
    _MASK = Mask.from_json(mask_json)


def _work(item):
    src_id, z, x, y, data = item
    return src_id, quadrants(z, x, y, data, _MASK.qualifies)


def source_tiles(paths, done, mask):
    """(src_id, z, x, y, webp) of every source tile not yet done that the mask needs."""
    for path in paths:
        with Reader(path) as r:
            if r.header['tile_type'] != 'webp':
                raise TranscodeError(f'{path}: tile type {r.header["tile_type"]}, expected webp')
            for z, x, y, data in r.tiles():
                if z > MAX_SRC_ZOOM:
                    continue
                src_id = zxy_to_tileid(z, x, y)
                if src_id in done:
                    continue
                if not any(mask.qualifies(z + 1, 2 * x + dx, 2 * y + dy)
                           for dx in (0, 1) for dy in (0, 1)):
                    continue
                yield src_id, z, x, y, data


def mask_digest(mask_json):
    return hashlib.sha256(json.dumps(mask_json['cells'], sort_keys=True).encode()).hexdigest()


def run(mask_json, inputs, output, metadata, jobs=None, batch=500, log=print):
    mask = Mask.from_json(mask_json)
    digest = mask_digest(mask_json)
    if os.path.exists(output):
        # "Done" means done for THIS mask: a source tile skipped or cut under
        # another mask may owe quadrants now. A different mask starts over.
        old = sqlite3.connect(output)
        try:
            row = old.execute("SELECT value FROM metadata WHERE name = 'dem_mask_sha256'").fetchone()
        except sqlite3.Error:
            row = None
        old.close()
        if row is None or row[0] != digest:
            log(f'{output} was made under another mask; starting over')
            os.remove(output)
    metadata = {**metadata, 'dem_mask_sha256': digest}
    db = open_mbtiles(output, metadata)
    done = {row[0] for row in db.execute('SELECT src_id FROM done')}
    if done:
        log(f'resuming: {len(done)} source tiles already done')
    jobs = jobs or max(1, (os.cpu_count() or 2) - 1)
    t0 = time.time()
    n_src = n_out = 0
    pending = []

    def flush():
        with db:
            for src_id, outs in pending:
                for z, x, y, png, sha in outs:
                    db.execute('INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)',
                               (z, x, tms_row(z, y), png))
                    db.execute('INSERT OR REPLACE INTO pixels VALUES (?, ?, ?, ?)',
                               (z, x, tms_row(z, y), sha))
                db.execute('INSERT OR IGNORE INTO done VALUES (?)', (src_id,))
        pending.clear()

    # Pool.imap* drains its input as fast as it can: without this bound the
    # whole extract (100+ GB) would queue up in memory ahead of the workers.
    in_flight = threading.BoundedSemaphore(jobs * 32)

    def bounded(items):
        for item in items:
            in_flight.acquire()
            yield item

    with multiprocessing.get_context('spawn').Pool(jobs, _init, (mask_json,)) as pool:
        for src_id, outs in pool.imap_unordered(_work, bounded(source_tiles(inputs, done, mask)), 4):
            in_flight.release()
            pending.append((src_id, outs))
            n_src += 1
            n_out += len(outs)
            if len(pending) >= batch:
                flush()
                rate = n_src / max(time.time() - t0, 1e-6)
                log(f'{n_src} source tiles → {n_out} PNG ({rate:.1f}/s)')
    flush()
    count = db.execute('SELECT COUNT(*) FROM tiles').fetchone()[0]
    zooms = db.execute('SELECT MIN(zoom_level), MAX(zoom_level) FROM tiles').fetchone()
    if zooms[0] is not None:
        db.executemany('INSERT OR REPLACE INTO metadata VALUES (?, ?)',
                       [('minzoom', str(zooms[0])), ('maxzoom', str(zooms[1]))])
        db.commit()
    db.close()
    log(f'done: {n_src} source tiles this run, {count} PNG tiles in {output}')
    return count


if __name__ == '__main__':
    import argparse
    import json

    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--mask', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--name', required=True)
    ap.add_argument('--attribution', default='© Mapterhorn')
    ap.add_argument('--jobs', type=int)
    ap.add_argument('inputs', nargs='+')
    a = ap.parse_args()
    meta = {'name': a.name, 'format': 'png', 'type': 'baselayer', 'attribution': a.attribution,
            'description': 'Terrarium-encoded terrain (256 px), from Mapterhorn; LiDAR-masked'}
    run(json.load(open(a.mask)), a.inputs, a.out, meta, jobs=a.jobs,
        log=lambda m: print(time.strftime('%F %T'), m, flush=True))
    sys.exit(0)

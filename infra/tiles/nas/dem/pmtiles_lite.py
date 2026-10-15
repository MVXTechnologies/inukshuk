"""Read PMTiles v3 archives, local or over HTTP range requests (standard library only).

Only what the DEM pipeline needs: the header, tile lookup by z/x/y, and a walk
over every tile entry. The spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
Writing is left to `pmtiles convert` (MBTiles → PMTiles), the reference tool.
"""
import gzip
import struct
import urllib.request

HEADER_LEN = 127
COMPRESSION_NONE, COMPRESSION_GZIP = 1, 2
TILE_TYPES = {0: 'unknown', 1: 'mvt', 2: 'png', 3: 'jpeg', 4: 'webp', 5: 'avif'}
USER_AGENT = 'inukshuk-dem/1 (+https://github.com/MVXTechnologies/inukshuk)'


def _rotate(n, x, y, rx, ry):
    if ry == 0:
        if rx == 1:
            x, y = n - 1 - x, n - 1 - y
        x, y = y, x
    return x, y


def zxy_to_tileid(z, x, y):
    """The Hilbert tile id of z/x/y (spec §"Tile IDs")."""
    if z > 31:
        raise ValueError('zoom too large')
    n = 1 << z
    if not (0 <= x < n and 0 <= y < n):
        raise ValueError(f'tile {z}/{x}/{y} out of range')
    acc = ((1 << (2 * z)) - 1) // 3
    d = 0
    s = n >> 1
    while s > 0:
        rx = 1 if x & s else 0
        ry = 1 if y & s else 0
        d += s * s * ((3 * rx) ^ ry)
        x, y = _rotate(n, x, y, rx, ry)
        s >>= 1
    return acc + d


def tileid_to_zxy(tile_id):
    """Inverse of zxy_to_tileid."""
    acc = 0
    for z in range(32):
        count = 1 << (2 * z)
        if tile_id < acc + count:
            d = tile_id - acc
            n = 1 << z
            x = y = 0
            s = 1
            while s < n:
                rx = 1 & (d // 2)
                ry = 1 & (d ^ rx)
                x, y = _rotate(s, x, y, rx, ry)
                x += s * rx
                y += s * ry
                d //= 4
                s <<= 1
            return z, x, y
        acc += count
    raise ValueError('tile id too large')


def _varint(buf, pos):
    result = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if b < 0x80:
            return result, pos
        shift += 7


def parse_directory(buf):
    """Directory bytes (decompressed) → list of (tile_id, offset, length, run_length)."""
    n, pos = _varint(buf, 0)
    ids, runs, lengths, offsets = [], [], [], []
    last = 0
    for _ in range(n):
        v, pos = _varint(buf, pos)
        last += v
        ids.append(last)
    for _ in range(n):
        v, pos = _varint(buf, pos)
        runs.append(v)
    for _ in range(n):
        v, pos = _varint(buf, pos)
        lengths.append(v)
    for i in range(n):
        v, pos = _varint(buf, pos)
        if v == 0 and i > 0:
            offsets.append(offsets[i - 1] + lengths[i - 1])
        else:
            offsets.append(v - 1)
    return list(zip(ids, offsets, lengths, runs))


def parse_header(buf):
    if len(buf) < HEADER_LEN or buf[:7] != b'PMTiles' or buf[7] != 3:
        raise ValueError('not a PMTiles v3 archive')
    u = struct.unpack_from('<11Q', buf, 8)
    keys = ('root_offset', 'root_length', 'metadata_offset', 'metadata_length',
            'leaf_offset', 'leaf_length', 'data_offset', 'data_length',
            'addressed_tiles', 'tile_entries', 'tile_contents')
    h = dict(zip(keys, u))
    h['clustered'] = buf[96] == 1
    h['internal_compression'] = buf[97]
    h['tile_compression'] = buf[98]
    h['tile_type'] = TILE_TYPES.get(buf[99], 'unknown')
    h['min_zoom'], h['max_zoom'] = buf[100], buf[101]
    lon0, lat0, lon1, lat1 = struct.unpack_from('<4i', buf, 102)
    h['bounds'] = (lon0 / 1e7, lat0 / 1e7, lon1 / 1e7, lat1 / 1e7)
    return h


def _decompress(data, compression):
    if compression in (0, COMPRESSION_NONE):
        return data
    if compression == COMPRESSION_GZIP:
        return gzip.decompress(data)
    raise ValueError(f'unsupported compression {compression}')


class FileSource:
    def __init__(self, path):
        self.f = open(path, 'rb')

    def read(self, offset, length):
        self.f.seek(offset)
        data = self.f.read(length)
        if len(data) != length:
            raise IOError(f'short read at {offset}+{length}')
        return data

    def close(self):
        self.f.close()


class HttpSource:
    """Byte ranges over HTTP; refuses a server that ignores Range (it would send GBs)."""

    def __init__(self, url, timeout=120):
        self.url = url
        self.timeout = timeout

    def read(self, offset, length):
        req = urllib.request.Request(self.url, headers={
            'Range': f'bytes={offset}-{offset + length - 1}', 'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            if resp.status != 206:
                raise IOError(f'{self.url}: no range support (HTTP {resp.status})')
            data = resp.read()
        if len(data) != length:
            raise IOError(f'{self.url}: short range read at {offset}+{length}')
        return data

    def close(self):
        pass


class Reader:
    def __init__(self, path_or_url):
        is_url = path_or_url.startswith(('http://', 'https://'))
        self.source = HttpSource(path_or_url) if is_url else FileSource(path_or_url)
        self.header = parse_header(self.source.read(0, HEADER_LEN))
        self._dirs = {}

    def close(self):
        self.source.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _directory(self, offset, length):
        key = (offset, length)
        if key not in self._dirs:
            raw = self.source.read(offset, length)
            self._dirs[key] = parse_directory(_decompress(raw, self.header['internal_compression']))
            if len(self._dirs) > 256:
                self._dirs.pop(next(iter(self._dirs)))
        return self._dirs[key]

    def metadata(self):
        h = self.header
        if h['metadata_length'] == 0:
            return {}
        import json
        raw = self.source.read(h['metadata_offset'], h['metadata_length'])
        return json.loads(_decompress(raw, h['internal_compression']))

    def get(self, z, x, y):
        """The tile's bytes (tile compression undone), or None."""
        tile_id = zxy_to_tileid(z, x, y)
        h = self.header
        offset, length = h['root_offset'], h['root_length']
        for _ in range(4):  # the spec allows at most three levels of leaves
            entries = self._directory(offset, length)
            lo, hi = 0, len(entries) - 1
            found = None
            while lo <= hi:  # last entry with id <= tile_id
                mid = (lo + hi) // 2
                if entries[mid][0] <= tile_id:
                    found = entries[mid]
                    lo = mid + 1
                else:
                    hi = mid - 1
            if found is None:
                return None
            eid, eoff, elen, run = found
            if run == 0:  # a leaf directory
                offset, length = h['leaf_offset'] + eoff, elen
                continue
            if tile_id >= eid + run:
                return None
            data = self.source.read(h['data_offset'] + eoff, elen)
            return _decompress(data, h['tile_compression'])
        raise ValueError('directory nesting too deep')

    def entries(self):
        """Every (tile_id, offset, length) — runs expanded — in tile-id order."""
        h = self.header

        def walk(offset, length):
            for eid, eoff, elen, run in self._directory(offset, length):
                if run == 0:
                    yield from walk(h['leaf_offset'] + eoff, elen)
                else:
                    for k in range(run):
                        yield eid + k, eoff, elen

        yield from walk(h['root_offset'], h['root_length'])

    def tiles(self):
        """Every (z, x, y, bytes), reading each distinct blob once (in order of offset)."""
        h = self.header
        for tile_id, off, length in self.entries():
            z, x, y = tileid_to_zxy(tile_id)
            data = self.source.read(h['data_offset'] + off, length)
            yield z, x, y, _decompress(data, h['tile_compression'])

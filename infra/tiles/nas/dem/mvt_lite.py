"""Decode Mapbox Vector Tile polygons (standard library only).

Just enough to read Mapterhorn's `coverage.pmtiles` (layer "coverage", one
string property "source"): each feature's rings in tile coordinates. Spec:
https://github.com/mapbox/vector-tile-spec/tree/master/2.1
"""

POLYGON = 3


def _varint(buf, pos):
    result = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if b < 0x80:
            return result, pos
        shift += 7


def _fields(buf):
    """(field number, wire type, value) — value is an int or a memoryview slice."""
    pos, end = 0, len(buf)
    while pos < end:
        key, pos = _varint(buf, pos)
        field, wire = key >> 3, key & 7
        if wire == 0:
            value, pos = _varint(buf, pos)
        elif wire == 2:
            length, pos = _varint(buf, pos)
            value = buf[pos:pos + length]
            pos += length
        elif wire == 5:
            value = int.from_bytes(buf[pos:pos + 4], 'little')
            pos += 4
        elif wire == 1:
            value = int.from_bytes(buf[pos:pos + 8], 'little')
            pos += 8
        else:
            raise ValueError(f'unsupported wire type {wire}')
        yield field, wire, value


def _packed(buf):
    out, pos = [], 0
    while pos < len(buf):
        v, pos = _varint(buf, pos)
        out.append(v)
    return out


def _zigzag(n):
    return (n >> 1) ^ -(n & 1)


def decode_rings(geometry):
    """Command stream → list of closed rings, each a list of (x, y)."""
    rings, ring = [], []
    x = y = 0
    i = 0
    while i < len(geometry):
        cmd, count = geometry[i] & 7, geometry[i] >> 3
        i += 1
        if cmd == 1 or cmd == 2:  # MoveTo / LineTo
            for _ in range(count):
                x += _zigzag(geometry[i])
                y += _zigzag(geometry[i + 1])
                i += 2
                if cmd == 1 and ring:
                    rings.append(ring)
                    ring = []
                ring.append((x, y))
        elif cmd == 7:  # ClosePath
            if ring:
                rings.append(ring)
            ring = []
        else:
            raise ValueError(f'bad command {cmd}')
    if ring:
        rings.append(ring)
    return rings


def ring_area(ring):
    """Signed shoelace area in tile coordinates (y down): > 0 = exterior (spec §4.3.4.4)."""
    a = 0
    for i in range(len(ring)):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % len(ring)]
        a += x0 * y1 - x1 * y0
    return a / 2


def decode_layer(data, layer_name):
    """→ (extent, [(properties, [ring, …]), …]) for the polygon features of one layer."""
    buf = memoryview(data)
    for field, _, layer in _fields(buf):
        if field != 3:
            continue
        name, extent, keys, values, features = None, 4096, [], [], []
        for f, _, v in _fields(layer):
            if f == 1:
                name = bytes(v).decode()
            elif f == 5:
                extent = v
            elif f == 3:
                keys.append(bytes(v).decode())
            elif f == 4:
                val = None
                for vf, _, vv in _fields(v):
                    val = bytes(vv).decode() if vf == 1 else vv
                values.append(val)
            elif f == 2:
                features.append(v)
        if name != layer_name:
            continue
        out = []
        for feat in features:
            tags, geom, gtype = [], [], 0
            for f, _, v in _fields(feat):
                if f == 2:
                    tags = _packed(v)
                elif f == 3:
                    gtype = v
                elif f == 4:
                    geom = _packed(v)
            if gtype != POLYGON:
                continue
            props = {keys[tags[i]]: values[tags[i + 1]] for i in range(0, len(tags) - 1, 2)}
            out.append((props, decode_rings(geom)))
        return extent, out
    return 4096, []

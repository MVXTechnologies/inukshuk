"""Shared helpers for the climbing-crags pipeline (../climbing.sh)."""
import json
import math
import os
import re
import sys
import time
import unicodedata

USER_AGENT = 'inukshuk-tiles/1.0 (+https://inukshuk.mvxtechnologies.com)'
EARTH_R = 6371008.8

# Style bits, shared with the app (src/core/climbing/crag.ts STYLE_BITS).
STYLE_BITS = {
    'sport': 1,
    'trad': 2,
    'tr': 4,
    'boulder': 8,
    'ice': 16,
    'mixed': 32,
    'alpine': 64,
    'aid': 128,
}
STYLES = list(STYLE_BITS)

# Access codes in the tiles (`a`); absent = unknown. Never "open" from missing data.
ACCESS_CODE = {'open': 0, 'restricted': 1, 'closed': 2, 'banned': 3}

# Source bits in the tiles (`src`), for the card's attribution line offline.
SOURCE_BITS = {'ob': 1, 'osm': 2, 'c2c': 4, 'fqme': 8}

LICENCES = {
    'ob': {'name': 'OpenBeta', 'licence': 'CC0-1.0', 'url': 'https://openbeta.io'},
    'osm': {
        'name': '© OpenStreetMap contributors',
        'licence': 'ODbL-1.0',
        'url': 'https://www.openstreetmap.org/copyright',
    },
    'c2c': {
        'name': 'camptocamp.org contributors',
        'licence': 'CC-BY-SA-3.0',
        'url': 'https://www.camptocamp.org/articles/106728',
    },
}


def log(message):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), message, file=sys.stderr, flush=True)


def haversine_m(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(h)))


def local_xy(lat0, lng0):
    """Equirectangular metres around (lat0, lng0): fine at crag scale (< 5 km)."""
    k = math.cos(math.radians(lat0))

    def f(lat, lng):
        return (math.radians(lng - lng0) * EARTH_R * k, math.radians(lat - lat0) * EARTH_R)

    return f


_SPACE = re.compile(r'\s+')
_PUNCT = re.compile(r"[^\w\s]")
_STOP = {'the', 'le', 'la', 'les', 'l', 'de', 'du', 'des', 'd', 'mont', 'mount', 'mt', 'crag', 'secteur', 'sector'}


def fold(text):
    """Lower-case, accents off, punctuation off: names compared across sources."""
    t = unicodedata.normalize('NFKD', text or '')
    t = ''.join(c for c in t if not unicodedata.combining(c)).lower()
    t = _PUNCT.sub(' ', t)
    return _SPACE.sub(' ', t).strip()


def name_key(text):
    """`fold` less filler words (Mont, Secteur, The…), for crag-name matching."""
    words = [w for w in fold(text).split() if w not in _STOP]
    return ' '.join(words) or fold(text)


def jaro_winkler(a, b):
    if a == b:
        return 1.0
    la, lb = len(a), len(b)
    if not la or not lb:
        return 0.0
    window = max(la, lb) // 2 - 1
    ma, mb = [False] * la, [False] * lb
    matches = 0
    for i in range(la):
        lo, hi = max(0, i - window), min(i + window + 1, lb)
        for j in range(lo, hi):
            if not mb[j] and a[i] == b[j]:
                ma[i] = mb[j] = True
                matches += 1
                break
    if not matches:
        return 0.0
    t, k = 0, 0
    for i in range(la):
        if ma[i]:
            while not mb[k]:
                k += 1
            if a[i] != b[k]:
                t += 1
            k += 1
    jaro = (matches / la + matches / lb + (matches - t / 2) / matches) / 3
    prefix = 0
    for x, y in zip(a[:4], b[:4]):
        if x != y:
            break
        prefix += 1
    return jaro + prefix * 0.1 * (1 - jaro)


def clean(text, limit=None):
    if text is None:
        return None
    t = _SPACE.sub(' ', str(text)).strip()
    if not t:
        return None
    if limit and len(t) > limit:
        return None
    return t


def write_json(path, value, pretty=False):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path + '.tmp', 'w', encoding='utf-8') as f:
        if pretty:
            json.dump(value, f, ensure_ascii=False, indent=1, sort_keys=True)
        else:
            json.dump(value, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(path + '.tmp', path)


def read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def resumable(path):
    """True when a resumed run (CLIMBING_RESUME=1) already holds this answer."""
    return os.environ.get('CLIMBING_RESUME') == '1' and os.path.exists(path)


def round_ll(v):
    return round(v, 6)

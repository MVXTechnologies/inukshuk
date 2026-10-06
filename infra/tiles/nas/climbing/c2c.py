"""camptocamp.org collaborative waypoints (`climbing_outdoor`, CC BY-SA 3.0)
→ crag records.

Only collaborative documents are read (waypoints are; outings and personal
images, CC BY-NC-ND, never are). What we keep: name, position, route count,
rating range, orientations, rock, heights, approach time, and the access
("Accès") text verbatim with its language, its licence and a link back to the
page — the credit the licence asks for. A text longer than ACCESS_MAX is not
cut (a cut is an adaptation): the card links to the page instead.
"""
import json
import math
import os
import re

from common import clean

ACCESS_MAX = 1200
_LINK = re.compile(r'\[\[[^|\]]*\|([^\]]*)\]\]')
_URL = re.compile(r'\[([^\]]+)\]\((?:https?://[^)]+)\)')
_MARK = re.compile(r'[*_#>`]+')
_TIME = re.compile(r'^(?:(\d+)h)?(\d+)?(?:min)?$')
ROCK = {
    'granit': 'granite', 'gneiss': 'gneiss', 'calcaire': 'limestone', 'gres': 'sandstone',
    'conglomerat': 'conglomerate', 'basalte': 'basalt', 'schiste': 'schist', 'quartzite': 'quartzite',
    'rhyolite': 'rhyolite', 'molasse': 'molasse', 'serpentine': 'serpentine', 'volcanique': 'volcanic',
    'anorthosite': 'anorthosite', 'dolomie': 'dolomite', 'gabbro': 'gabbro', 'diorite': 'diorite',
    'trachyandesite': 'trachyandesite', 'tuf': 'tuff', 'ardoise': 'slate', 'mixte': 'mixed',
}


def mercator_to_ll(x, y):
    lng = math.degrees(x / 6378137.0)
    lat = math.degrees(2 * math.atan(math.exp(y / 6378137.0)) - math.pi / 2)
    return lat, lng


def plain(text):
    """camptocamp markdown → plain text (links keep their label)."""
    if not text:
        return None
    # Embedded images and their captions: the picture isn't shown, so its
    # caption would only run into the text ("Weir - accèsParoi située…").
    t = re.sub(r'\[img[^\]]*\].*?\[/img\]', ' ', text, flags=re.S)
    t = re.sub(r'\[img[^\]]*\]', ' ', t)
    t = re.sub(r'\[url=[^\]]*\](.*?)\[/url\]', r'\1', t, flags=re.S)
    t = _LINK.sub(r'\1', t)
    t = _URL.sub(r'\1', t)
    t = re.sub(r'\[/?[a-z]+(?:=[^\]]*)?\]', '', t)  # [warning], [p], …
    t = _MARK.sub('', t)
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r'\n{3,}', '\n\n', t)
    return t.strip() or None


def access_minutes(v):
    """'5min' → 5, '1h' → 60, '1h30' → 90, 'min'/'' → None."""
    m = _TIME.match((v or '').strip().lower().replace(' ', ''))
    if not m or not (m.group(1) or m.group(2)):
        return None
    return int(m.group(1) or 0) * 60 + int(m.group(2) or 0)


def _locale(doc, prefer=('fr', 'en')):
    locs = {loc.get('lang'): loc for loc in doc.get('locales') or []}
    for lang in prefer:
        if lang in locs:
            return lang, locs[lang]
    for lang, loc in locs.items():
        return lang, loc
    return None, {}


def record(doc):
    geom = (doc.get('geometry') or {}).get('geom')
    if not geom:
        return None
    x, y = json.loads(geom)['coordinates'][:2]
    lat, lng = mercator_to_ll(x, y)
    lang, loc = _locale(doc)
    name = clean(loc.get('title'), 120)
    if not name:
        return None
    did = doc['document_id']
    rec = {
        'uid': f'c2c-{did}',
        'src': 'c2c',
        'name': name,
        'lat': round(lat, 6),
        'lng': round(lng, 6),
        'url': f'https://www.camptocamp.org/waypoints/{did}',
    }
    names = {}
    for loc2 in doc.get('locales') or []:
        t = clean(loc2.get('title'), 120)
        if t and loc2.get('lang') in ('fr', 'en') and t != name:
            names[loc2['lang']] = t
    if names:
        rec['names'] = names
    n = doc.get('routes_quantity')
    if isinstance(n, int) and 0 < n < 5000:
        rec['declared'] = n
    for key in ('climbing_rating_min', 'climbing_rating_max'):
        if doc.get(key):
            rec[key.split('_')[-1]] = doc[key]
    if doc.get('orientations'):
        rec['aspect'] = ';'.join(doc['orientations'])
    rocks = [ROCK.get(r, r) for r in doc.get('rock_types') or []]
    if rocks:
        rec['rock'] = ', '.join(rocks[:2])
    if isinstance(doc.get('height_max'), int) and 0 < doc['height_max'] < 3000:
        rec['height'] = doc['height_max']
    mins = access_minutes(doc.get('access_time'))
    approach = {}
    if mins:
        approach['min'] = mins
    # Every locale's access text, verbatim (plain-text rendering only).
    texts = {}
    for loc2 in doc.get('locales') or []:
        t = plain(loc2.get('access'))
        if t and len(t) <= ACCESS_MAX and loc2.get('lang') in ('fr', 'en', 'de', 'it', 'es'):
            texts[loc2['lang']] = t
    if texts:
        approach['text'] = texts
    if approach:
        approach['src'] = 'c2c'
        approach['url'] = rec['url']
        rec['approach'] = approach
    styles = doc.get('climbing_outdoor_types') or []
    if 'bloc' in styles or 'boulder' in styles:
        rec['boulder'] = True
    return rec


def normalize(docs_dir, takedowns=None):
    gone = {str(x) for x in (takedowns or {}).get('c2c') or []}
    out = []
    for name in sorted(os.listdir(docs_dir)):
        if not name.endswith('.json') or name[:-5] in gone:
            continue
        with open(os.path.join(docs_dir, name), encoding='utf-8') as f:
            doc = json.load(f)
        if doc.get('waypoint_type') != 'climbing_outdoor':
            continue
        rec = record(doc)
        if rec:
            out.append(rec)
    return out

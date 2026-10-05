"""Climbing grades → one integer ladder per discipline, so the tiles and topos
carry system-neutral difficulty and the app shows it in the user's system
(YDS in North America, French elsewhere; V / Font for boulders).

The ladders are shared with the app (src/core/climbing/grades.ts); keep both
in step.

- rope ('r'): the YDS fine scale. 0–9 = 5.0–5.9, then four steps per number:
  10 = 5.10a … 13 = 5.10d, 14 = 5.11a … 33 = 5.15d. French and UIAA map onto
  it through the conversion OpenBeta's own export uses (measured on the
  2026-10-04 release: 5.10a ↔ 6a, 5.11d ↔ 7a, 5.13b ↔ 8a…).
- boulder ('b'): the V scale, −1 = VB / V-easy, 0 = V0 … 17 = V17. Font maps
  onto it with the usual table.
- ice ('i'): WI1–WI8.

Bands (the four-colour bar): rope ≤5.7 / 5.8–5.10 / 5.11 / 5.12+; boulder
V0–2 / V3–5 / V6–8 / V9+; ice WI2–3 / WI4 / WI5 / WI6+.
"""
import re

ROPE_YDS = ['5.0', '5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '5.7', '5.8', '5.9']
for _n in range(10, 16):
    ROPE_YDS += [f'5.{_n}{c}' for c in 'abcd']
# French per rope index (OpenBeta's export: 5.11a and 5.11b are both 6c).
ROPE_FRENCH = [
    '2-', '2', '3', '3+', '4a', '4b', '4c', '5a', '5b', '5c',
    '6a', '6a+', '6b', '6b+', '6c', '6c', '6c+', '7a',
    '7a+', '7b', '7b+', '7c', '7c+', '8a', '8a+', '8b',
    '8b+', '8c', '8c+', '9a', '9a+', '9b', '9b+', '9c',
]
assert len(ROPE_YDS) == len(ROPE_FRENCH) == 34
FRENCH_INDEX = {}
for _i, _f in enumerate(ROPE_FRENCH):
    FRENCH_INDEX.setdefault(_f, _i)
FRENCH_INDEX.update({'1': 0, '1+': 0, '2+': 1, '3a': 2, '3b': 2, '3c': 3, '4': 4, '4+': 5, '5': 7, '5+': 8})
# UIAA → rope index (the same table the mockups were checked against).
UIAA_INDEX = {
    '1': 0, '2': 1, '3-': 2, '3': 3, '3+': 3, '4-': 4, '4': 4, '4+': 5, '5-': 5, '5': 6,
    '5+': 7, '6-': 8, '6': 9, '6+': 10, '7-': 11, '7': 12, '7+': 13, '8-': 14,
    '8': 15, '8+': 17, '9-': 18, '9': 19, '9+': 20, '10-': 21, '10': 22, '10+': 23,
    '11-': 24, '11': 26, '11+': 28, '12-': 29, '12': 31, '12+': 32,
}
ROMAN = {'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10, 'XI': 11, 'XII': 12}
FONT_V = {
    '3': -1, '4': 0, '4+': 0, '5': 1, '5+': 2, '6a': 3, '6a+': 3, '6b': 4, '6b+': 4,
    '6c': 5, '6c+': 5, '7a': 6, '7a+': 7, '7b': 8, '7b+': 8, '7c': 9, '7c+': 10,
    '8a': 11, '8a+': 12, '8b': 13, '8b+': 14, '8c': 15, '8c+': 16, '9a': 17,
}

_YDS = re.compile(r'^5\.(\d{1,2})\s*([abcd])?\s*(?:/\s*([abcd]))?\s*([+-])?$')
_V = re.compile(r'^v\s*(\d{1,2}|b|-?easy)\s*([+-])?(?:\s*[-/]\s*v?\d{1,2})?$', re.I)
_WI = re.compile(r'^(?:wi|ai)\s*(\d)\s*[+-]?(?:\s*[-/]\s*(?:wi)?\s*\d[+-]?)?$', re.I)
_FRENCH = re.compile(r'^([1-9])\s*([abc])?\s*(\+)?(?:\s*/.*)?$')


def yds_index(text):
    """'5.10a' → 10, '5.9+' → 9, '5.10-' → 10, '5.10' → 12, '5.10+' → 13,
    '5.11a/b' → 14 (the lower), 'Easy 5th' → 0. None when not YDS."""
    t = (text or '').strip().lower().replace(' ', '')
    if t in ('easy5th', '5.easy'):
        return 0
    m = _YDS.match(t)
    if not m:
        return None
    n, letter, _alt, sign = int(m.group(1)), m.group(2), m.group(3), m.group(4)
    if n <= 9:
        return n
    if n > 15:
        return None
    base = 10 + (n - 10) * 4
    if letter:
        return base + 'abcd'.index(letter)
    # Letterless grades as OpenBeta's own French reads them: 5.10- ↔ 6a,
    # 5.10 ↔ 6b, 5.10+ ↔ 6b+ (and the same for 5.11–5.15).
    return base + {'-': 0, None: 2, '+': 3}[sign]


def french_index(text):
    t = (text or '').strip().lower().replace(' ', '')
    if t in FRENCH_INDEX:
        return FRENCH_INDEX[t]
    t = t.split('/')[0]
    if t in FRENCH_INDEX:
        return FRENCH_INDEX[t]
    m = _FRENCH.match(t)
    if not m:
        return None
    base = f'{m.group(1)}{m.group(2) or ""}{m.group(3) or ""}'
    if base in FRENCH_INDEX:
        return FRENCH_INDEX[base]
    return FRENCH_INDEX.get(f'{m.group(1)}{m.group(2) or ""}')


def uiaa_index(text):
    t = (text or '').strip().replace(' ', '')
    t = t.split('/')[0]
    m = re.match(r'^([IVX]+|\d{1,2})([+-])?$', t)
    if not m:
        return None
    num = ROMAN.get(m.group(1)) if not m.group(1).isdigit() else int(m.group(1))
    if num is None:
        return None
    return UIAA_INDEX.get(f'{num}{m.group(2) or ""}', UIAA_INDEX.get(str(num)))


def v_index(text):
    t = (text or '').strip().lower()
    m = _V.match(t)
    if not m:
        return None
    g = m.group(1)
    if g in ('b', 'easy', '-easy'):
        return -1
    n = int(g)
    return n if n <= 17 else None


def font_index(text):
    t = (text or '').strip().lower().replace(' ', '').replace('fb', '').replace('f', '', 1)
    t = t.split('/')[0]
    return FONT_V.get(t)


def wi_index(text):
    m = _WI.match((text or '').strip())
    if not m:
        return None
    n = int(m.group(1))
    return n if 1 <= n <= 8 else None


def band(kind, idx):
    if idx is None:
        return None
    if kind == 'r':
        return 0 if idx <= 7 else 1 if idx <= 13 else 2 if idx <= 17 else 3
    if kind == 'b':
        return 0 if idx <= 2 else 1 if idx <= 5 else 2 if idx <= 8 else 3
    if kind == 'i':
        return 0 if idx <= 3 else 1 if idx == 4 else 2 if idx == 5 else 3
    return None


def grade(kind, idx, orig, system):
    """The route's grade fields: the source's own string and system, plus the
    ladder (kind, index) when it parses."""
    out = {}
    if orig:
        out['g'] = orig
        out['gs'] = system
    if idx is not None:
        out['k'] = kind
        out['x'] = idx
    return out


def from_openbeta(row, boulder):
    """OpenBeta export row → grade fields. Boulders read V; ropes YDS, else French."""
    yds, v, fr = row.get('grade_yds'), row.get('grade_vscale'), row.get('grade_french')
    if v or (boulder and not (yds or '').startswith('5.')):
        src = v or yds
        idx = v_index(src)
        if idx is not None or not (yds or '').startswith('5.'):
            return grade('b', idx, src, 'v')
    if yds and yds.strip().lower().startswith(('5.', 'easy')):
        return grade('r', yds_index(yds), yds, 'yds')
    if fr:
        return grade('r', french_index(fr), fr, 'french')
    if yds and _WI.match(yds.strip()):
        return grade('i', wi_index(yds), yds, 'wi')
    if yds:
        return {'g': yds, 'gs': 'yds'}
    return {}


OSM_GRADE_KEYS = [
    ('climbing:grade:uiaa', 'uiaa', 'r', uiaa_index),
    ('climbing:grade:french', 'french', 'r', french_index),
    ('climbing:grade:yds_class', 'yds', 'r', yds_index),
    ('climbing:grade:yds', 'yds', 'r', yds_index),
    ('climbing:grade:font', 'font', 'b', font_index),
    ('climbing:grade:v', 'v', 'b', v_index),
    ('climbing:grade:hueco', 'v', 'b', v_index),
    ('climbing:grade:ice', 'wi', 'i', wi_index),
    ('climbing:grade:wi', 'wi', 'i', wi_index),
    ('climbing:grade:saxon', 'saxon', None, None),
    ('climbing:grade:nordic', 'nordic', None, None),
    ('climbing:grade:british_adjectival', 'british', None, None),
]


def from_osm(tags):
    """OSM route tags → grade fields: the first grade key that parses wins; a
    grade in a system we can't place keeps its string (shown as is)."""
    fallback = {}
    for key, system, kind, fn in OSM_GRADE_KEYS:
        raw = (tags.get(key) or '').strip()
        if not raw:
            continue
        if fn is not None:
            idx = fn(raw)
            if kind == 'b' and system == 'v' and idx is None:
                idx = v_index('v' + raw)
            if idx is not None:
                return grade(kind, idx, raw, system)
        if not fallback:
            fallback = {'g': raw[:12], 'gs': system}
    return fallback

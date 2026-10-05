"""France — IGN Géoplateforme geodesy and levelling (SOURCES.md #4).

WFS `GEODESIE:data_geod` (~543k rows: geodetic rsgf/rsgo, levelling nivf/nivo/
nive…) with keyset paging on `id` (5,000 per page, one connection, CQL filter
id > last — deep STARTINDEX offsets are slow), plus the 512 RGP GNSS stations
(`IGNF_GEODESIE:rgp`). Destroyed marks are not published by IGN.

ID: `{domaine}-{id}` — what the datasheet URL needs
(https://data.geopf.fr/annexes/geodesie/pt-{domaine}-{id}.pdf); the point's
own designation (`nom`, e.g. "8609001-01") is the record's `name`.
"""
import os
import re
import urllib.parse

from common import fnum, log, record
from src_util import (acc_m, date_of, features, grid, height, keyset_pages, monument_from_words,
                      offset_pages, text_of)

SRC = 'fr-ign'
WFS = 'https://data.geopf.fr/wfs/ows'
PAGE = 5000
FIELDS = ('id,domaine,nom,no,type,etat,vis_date,cg1_coord1,cg1_coord2,cg1_coord3,cg1_srt,'
          'cg1_coord1_dms,cg1_coord2_dms,cg1_prec,cp1_coord1,cp1_coord2,cp1_srt,cp1_coord3,cp1_srv,'
          'cp1_precv,cp1_altitude_type,geom')
STATUS = {'BON ETAT': 'ok', 'IMPRENABLE': 'ok', 'NON RETROUVE': 'notFound',
          'PRESUME DEPLACE': 'damaged', 'DETRUIT': 'destroyed', 'MAUVAIS ETAT': 'damaged'}
DATUM = (
    ('RGF93', 'rgf93'), ('RGAF09', 'rgaf09'), ('RGR92', 'rgr92'), ('RGFG95', 'rgfg95'),
    ('RGM23', 'rgm23'), ('RGM04', 'rgm23'), ('RGSPM06', 'rgspm06'),
)
VDATUM = (
    ('NGF-IGN 1969', 'NGF-IGN69'), ('NGF-IGN 1978', 'NGF-IGN78'),
    ('IGN 1988 (GUADELOUPE)', 'IGN 1988 (Guadeloupe)'), ('IGN 1987 (MARTINIQUE)', 'IGN 1987 (Martinique)'),
    ('IGN 1989 (REUNION)', 'IGN 1989 (Réunion)'), ('(NGG) 1977', 'NGG 1977 (Guyane)'),
    ('IGN 2023 MAYOTTE', 'IGN 2023 (Mayotte)'), ('DANGER 1950', 'Danger 1950 (Saint-Pierre-et-Miquelon)'),
)
MONUMENT = (
    (('médaillon', 'repère en bronze', 'plaque'), 'disk'),
    (('rivet', 'repère cylindrique', 'repere cylindrique', 'console', 'boule', 'bourdaloue',
      'repère', 'repere'), 'bolt'),
    (('pilier',), 'pillar'),
    (('borne', 'pierre'), 'stone'),
    (('clocher', 'clocheton', 'tour', 'cheminée', 'château', 'chateau', 'antenne', 'pylône', 'phare',
      'flèche', 'croix', 'calvaire'), 'structure'),
    (('tige', 'tube'), 'rod'),
    (('trou', 'gravé', 'croix gravée'), 'cut'),
)


DOMAINES = ('rsgf', 'rsge', 'rsgo', 'nivf', 'nive', 'nivo')


def _hits():
    import json  # noqa: PLC0415

    from common import http_get  # noqa: PLC0415

    try:
        d = json.loads(http_get(_url({'TYPENAMES': 'GEODESIE:data_geod', 'COUNT': 1,
                                      'PROPERTYNAME': 'id', 'SORTBY': 'id'})))
        return d.get('numberMatched')
    except Exception:  # noqa: BLE001
        return None


def _url(params):
    base = {'SERVICE': 'WFS', 'VERSION': '2.0.0', 'REQUEST': 'GetFeature',
            'OUTPUTFORMAT': 'application/json', 'SRSNAME': 'EPSG:4326'}
    base.update(params)
    return WFS + '?' + urllib.parse.urlencode(base)


def fetch(raw_dir):
    # `id` is unique only within a domaine: page each domaine on its own.
    total = 0
    for dom in DOMAINES:
        keyset_pages(
            os.path.join(raw_dir, 'data_geod', dom),
            lambda after, dom=dom: _url({
                'TYPENAMES': 'GEODESIE:data_geod', 'COUNT': PAGE, 'SORTBY': 'id',
                'PROPERTYNAME': FIELDS, 'CQL_FILTER': f"domaine='{dom}' AND id>{after}"}),
            lambda f: f['properties']['id'], PAGE, start=-1, label=f'{SRC} {dom}')
        total += sum(1 for _ in features(os.path.join(raw_dir, 'data_geod', dom)))
    hits = _hits()
    if hits and hits != total:
        log(f'{SRC}: WARNING {total} rows fetched over {DOMAINES} but the layer has {hits}: '
            'a domaine is missing from DOMAINES')
    offset_pages(
        os.path.join(raw_dir, 'rgp'),
        lambda off: _url({'TYPENAMES': 'IGNF_GEODESIE:rgp', 'COUNT': 1000, 'STARTINDEX': off,
                          'SORTBY': 'id'}),
        1000, label=f'{SRC} rgp')


def _pick(text, table, default=None):
    t = (text or '').upper()
    for needle, key in table:
        if needle.upper() in t:
            return key
    return default


def _monument(text):
    # "M   REPERE CYLINDRIQUE DU NIVELLEMENT GENERAL" → drop the one-letter code column
    t = re.sub(r'^[A-Z]{1,2}\s{2,}', '', (text or '').strip())
    if not t:
        return None
    return {'code': monument_from_words(t, MONUMENT), 'text': t[:1] + t[1:].lower() if t.isupper() else t}


def _grid_system(srt):
    """'Système : RGF93 v1 (ETRS89) - Projection : LAMBERT-93' → 'Lambert-93';
    '… Projection : UTM NORD FUSEAU 20' → 'UTM 20N'."""
    if not srt or 'Projection' not in srt:
        return None
    proj = srt.split('Projection :', 1)[1].strip()
    m = re.match(r'UTM (NORD|SUD) FUSEAU (\d+)', proj.upper())
    if m:
        return f"UTM {m.group(2)}{'N' if m.group(1) == 'NORD' else 'S'}"
    if proj.upper() == 'LAMBERT-93':
        return 'Lambert-93'
    return proj


def _all_rows(raw_dir):
    for dom in DOMAINES:
        yield from features(os.path.join(raw_dir, 'data_geod', dom))


def normalize(raw_dir):
    for f in _all_rows(raw_dir):
        p = f['properties']
        geom = f.get('geometry') or {}
        lng, lat = (geom.get('coordinates') or [None, None])[:2]
        if lat is None:
            lng, lat = fnum(p.get('cg1_coord1')), fnum(p.get('cg1_coord2'))
        if lat is None or lng is None:
            continue
        dom = (p.get('domaine') or '').lower()
        datum = _pick(p.get('cg1_srt'), DATUM, 'rgf93')
        h_ell = fnum(p.get('cg1_coord3'))
        h_ortho = []
        if p.get('cp1_srv'):
            h = height(p.get('cp1_coord3'), _pick(p['cp1_srv'], VDATUM, 'Local vertical datum'))
            if h:
                h_ortho.append(h)
        if p.get('cg1_coord2_dms') and p.get('cg1_coord1_dms'):
            geo = f"{text_of(p['cg1_coord2_dms'])}, {text_of(p['cg1_coord1_dms'])}"
        elif p.get('cg1_coord2') is not None and p.get('cg1_coord1') is not None:
            geo = f"{text_of(p['cg1_coord2'])}, {text_of(p['cg1_coord1'])}"
        else:
            geo = None
        g = grid(_grid_system(p.get('cp1_srt')), p.get('cp1_coord1'), p.get('cp1_coord2'))
        acc = acc_m(p.get('cg1_prec'))
        if dom.startswith('niv'):
            type_ = 'v'
            # Levelling marks carry approximate positions (no stated precision): ±5 m.
            pos_acc = acc if acc is not None and acc >= 1 else (5.0 if acc is None else None)
        else:
            type_ = '3d' if h_ell is not None and acc is not None and acc < 1 else 'h'
            pos_acc = acc if acc is not None and acc >= 1 else None
        etat = (p.get('etat') or '').strip().upper()
        yield record(
            SRC, f"{dom}-{p['id']}", lat, lng, type_, datum,
            name=(p.get('nom') or '').strip() or None,
            aliases=[a for a in [(p.get('nom') or '').strip()] if a],
            posAcc=pos_acc,
            status=STATUS.get(etat, 'unknown'),
            statusRaw=etat or None,
            hEll=h_ell if not dom.startswith('niv') else None,
            hEllText=text_of(p.get('cg1_coord3')) if h_ell is not None and not dom.startswith('niv') else None,
            hOrtho=h_ortho,
            geo=geo,
            grids=[g] if g else [],
            monument=_monument(p.get('type')),
            lastVisit=date_of(p.get('vis_date')),
            sheet=f"{dom}-{p['id']}",
        )
    for f in features(os.path.join(raw_dir, 'rgp')):
        p = f['properties']
        lng, lat = (f.get('geometry') or {}).get('coordinates', [None, None])[:2]
        if lat is None or not p.get('nom'):
            continue
        yield record(
            SRC, f"rgp-{p['nom']}", lat, lng, 'gnss', 'rgf93' if -6 < lng < 10 and 41 < lat < 52 else 'itrf',
            name=p['nom'], aliases=[p['nom']], sheet=f"rgp-{p['nom']}",
            url=p.get('url'),
        )
    log(f'{SRC}: normalized')

"""Québec — MRNF Réseau géodésique du Québec (SOURCES.md #1).

Two inputs:
- the daily bulk shapefile (4 fields, Québec Lambert, positions ±2 m), and
- the per-point datasheets ("fiches signalétiques", PDF), harvested slowly by
  enrich_qc.py into fiches.jsonl; `parse_fiche` turns a sheet's text into the
  fields the bulk layer lacks (precise position, heights, monument, last visit).
"""
import os
import re
import zipfile

from common import download, http_date, lcc_inverse, log, norm_id, read_shapefile, record

SRC = 'qc-mrnf'
SHP_URL = (
    'https://diffusion.mern.gouv.qc.ca/Diffusion/RGQ/Vectoriel/Theme/Local/'
    'Points_Geodesiques/SHP/PointsGeod_Public_shp.zip'
)
SHEET_URL = 'https://fichegeodesique.mern.gouv.qc.ca/matricule-datum/{id}/{datum}'

TYPE = {
    'Précision 3D': '3d',
    'Planimétrie': 'h',
    'Altimétrie': 'v',
    'Station GNSS': 'gnss',
}
# DESCR_ETAT → status. Replaced, unusable and moved marks are as gone as
# destroyed ones for a user standing next to them: dropped at build time.
STATUS = {
    'En bon état': 'ok',
    'Endommagé': 'damaged',
    'Inconnu': 'unknown',
    'Non retrouvé': 'notFound',
    'Détruit': 'destroyed',
    'Pas utilisable': 'destroyed',
    'Déplacé': 'destroyed',
}


def status_of(etat, type_raw=''):
    if etat.startswith('Remplacé'):
        return 'destroyed'
    if type_raw == 'Détruit':
        return 'destroyed'
    return STATUS.get(etat, 'unknown')


def lambert_to_wgs84(x, y):
    """EPSG:32198-style Québec Lambert (NAD83(CSRS), GRS80) → lat, lon.

    NAD83(CSRS) is taken as WGS 84: the bulk positions are ±2 m anyway, and
    precise datasheet positions replace them when harvested.
    """
    return lcc_inverse(x, y, lat0=44.0, lon0=-68.5, sp1=60.0, sp2=46.0)


def fetch(raw_dir):
    os.makedirs(raw_dir, exist_ok=True)
    zpath = os.path.join(raw_dir, 'PointsGeod_Public_shp.zip')
    changed = download(SHP_URL, zpath)
    out = os.path.join(raw_dir, 'shp')
    if changed or not os.path.isdir(out):
        os.makedirs(out, exist_ok=True)
        with zipfile.ZipFile(zpath) as z:
            z.extractall(out)
    log(f'{SRC}: shapefile {"updated" if changed else "unchanged"} ({http_date(zpath)})')


def shp_base(raw_dir):
    d = os.path.join(raw_dir, 'shp')
    for name in sorted(os.listdir(d)):
        if name.lower().endswith('.shp'):
            return os.path.join(d, name[:-4])
    raise FileNotFoundError(f'no .shp in {d}')


def bulk_rows(raw_dir):
    """Yield {matricule, origine, etat, typeRaw, lat, lng} for every bulk row."""
    for row, (x, y) in read_shapefile(shp_base(raw_dir)):
        lat, lng = lambert_to_wgs84(x, y)
        yield {
            'matricule': row['MATRICULE'],
            'origine': row['NO_ORIGINE'],
            'etat': row['DESCR_ETAT'],
            'typeRaw': row['TYPE'],
            'lat': lat,
            'lng': lng,
            'x': x,
            'y': y,
        }


# ---------- Datasheet text → fields ----------

def _verbatim(s):
    """A published number, digits untouched: '5 186 767,681' → '5186767.681'."""
    return s.replace(' ', '').replace(' ', '').replace(',', '.')


def _num(s):
    return float(_verbatim(s))


def _clean(s):
    return re.sub(r'\s+', ' ', s).strip()


def _dms(d, m, s):
    return int(d) + int(m) / 60 + _num(s) / 3600


_ALT = re.compile(r'Altitude orthométrique \(m\) :\s+(-?[\d ]+,\d+)')
# A grid line of the "Coordonnées" block: northing then easting (then scale factor…).
_GRID = re.compile(r'^ ?(\d{1,3}(?: \d{3})+,\d+) +(\d{1,3}(?: \d{3})+,\d+)', re.M)


def _height_after(text, header, used):
    """The first orthometric height after `header` that no other datum claimed (verbatim text)."""
    i = text.find(header)
    if i < 0:
        return None
    tail = text[i + len(header):i + len(header) + 40]
    if tail.lstrip().startswith('Inexistantes'):
        return None
    for m in _ALT.finditer(text, i):
        if m.start() not in used:
            used.add(m.start())
            return _verbatim(m.group(1))
    return None


def _grids(text):
    """The sheet's published UTM and SCOPQ (MTM) coordinates, verbatim.

    In the extracted text the block reads: '19\\n7\\n 5 186 767,681  331 582,278\\n
    5 186 200,480  250 798,875  0,999 935 8 -' — the two zones, then the UTM
    line, then the SCOPQ line (northing first).
    """
    i = text.find('\nUTM\nSCOPQ')
    if i < 0:
        return []
    pairs = list(_GRID.finditer(text, i))[:2]
    if len(pairs) < 2:
        return []
    before = text[:pairs[0].start()].rstrip('\n').split('\n')
    if len(before) < 2:
        return []
    utm_zone, mtm_zone = before[-2].strip(), before[-1].strip()
    if not (utm_zone.isdigit() and mtm_zone.isdigit() and 17 <= int(utm_zone) <= 22
            and 3 <= int(mtm_zone) <= 10):
        return []
    out = []
    for system, m in ((f'UTM zone {utm_zone}N', pairs[0]), (f'MTM zone {mtm_zone} (SCOPQ)', pairs[1])):
        out.append({'system': system, 'n': _verbatim(m.group(1)), 'e': _verbatim(m.group(2))})
    return out


def parse_fiche(text):
    """Fields of one MRNF datasheet's extracted text (pypdf), all optional.

    Everything shown on the card is kept as the sheet prints it: the agency's
    wording (monument, site, état), and every coordinate and height as its
    verbatim digits (only the decimal comma becomes a dot). `lat`/`lng` are
    the decimal form of the published DMS, for drawing the map only.
    """
    out = {}

    def grab(pat, key, flags=0):
        m = re.search(pat, text, flags)
        if m:
            v = _clean(m.group(1))
            if v:
                out[key] = v

    grab(r'État : ([^\n]+)', 'etat')
    grab(r'Description : (.+?)\nInscription', 'monument', re.S)
    grab(r'Inscription : (.+?)\nClasse', 'inscription', re.S)
    grab(r'Site : ([^\n]+)', 'site')
    grab(r'Type de point : ([^\n]+)', 'pointType')
    grab(r"Date d'inspection : (\d{4}-\d{2}-\d{2})", 'lastVisit')
    m = re.search(r'(\d+)° (\d+)\' ([\d,]+)"\s+(\d+)° (\d+)\' ([\d,]+)"Géo\.', text)
    if m:
        out['lat'] = round(_dms(*m.group(1, 2, 3)), 9)
        out['lng'] = -round(_dms(*m.group(4, 5, 6)), 9)
        out['geo'] = (f"{m.group(1)}° {m.group(2)}' {_verbatim(m.group(3))}\" N, "
                      f"{m.group(4)}° {m.group(5)}' {_verbatim(m.group(6))}\" W")
    grids = _grids(text)
    if grids:
        out['grids'] = grids
    used = set()
    # CGVD2013 first: its header sits right before its value; CGVD28 takes what is left.
    h13 = _height_after(text, 'Données altimétriques - CGVD2013', used)
    h28 = _height_after(text, 'Données altimétriques - CGVD28', used)
    if h13 is not None:
        out['hCGVD2013'] = h13
    if h28 is not None:
        out['hCGVD28'] = h28
    m = re.search(r'Altitude géodésique \(m\) :\s+(-?[\d ]+,\d+)', text)
    if m:
        out['hEll'] = _verbatim(m.group(1))
    m = re.search(r'NAD83 \(SCRS\) \((V\d+)\)', text)
    if m:
        out['csrs'] = m.group(1)
    m = re.search(r'Époque : (\d{4}),(\d)', text)
    if m:
        out['epoch'] = f'{m.group(1)}.{m.group(2)}'
    m = re.search(r'Ordre : (\w+)', text)
    if m:
        out['order28'] = m.group(1)
    return out


# ---------- Monument wording → code ----------

_MONUMENT_RULES = (
    (('médaillon', 'disque', 'plaque d\'identification'), 'disk'),
    (('plaque de centrage', 'centrage forcé'), 'pin'),
    (('boulon', 'rivet', 'cheville'), 'bolt'),
    (('pilier', 'borne', 'pylône de béton'), 'pillar'),
    (('tige', 'barre'), 'rod'),
    (('tuyau',), 'pipe'),
    (('croix', 'gravé', 'entaille', 'trou percé', 'marque'), 'cut'),
    (('clou', 'goujon', 'vis'), 'pin'),
    (('clocher', 'flèche', 'cheminée', 'réservoir', 'tour', 'antenne', 'édifice', 'mât'), 'structure'),
    (('roc', 'pierre'), 'stone'),
    (('bloc', 'béton'), 'block'),
)


def monument_code(text):
    t = text.lower()
    for words, code in _MONUMENT_RULES:
        if any(w in t for w in words):
            return code
    return 'other'


def normalize(raw_dir, fiches=None):
    """Bulk rows (+ harvested sheets, keyed by matricule) → build records.

    Destroyed / not-found rows are yielded too, flagged, so dedupe can stop an
    NRCan or OSM twin from bringing them back; the tile step drops them.
    """
    fiches = fiches or {}
    for r in bulk_rows(raw_dir):
        mat = r['matricule']
        if not mat:
            continue
        status = status_of(r['etat'], r['typeRaw'])
        f = fiches.get(mat) or {}
        lat, lng, pos_acc = r['lat'], r['lng'], 2.0
        geo, grids = None, None
        if 'lat' in f and 'lng' in f and abs(f['lat'] - lat) < 0.01 and abs(f['lng'] - lng) < 0.01:
            lat, lng, pos_acc = f['lat'], f['lng'], None
            geo, grids = f.get('geo'), f.get('grids')
        if not grids:
            # The bulk layer's own published grid (Québec Lambert), ±2 m.
            grids = [{'system': 'Québec Lambert (bulk layer, ±2 m)',
                      'e': f"{r['x']:.3f}", 'n': f"{r['y']:.3f}"}]
        h_ortho = []
        for key, vd in (('hCGVD2013', 'CGVD2013'), ('hCGVD28', 'CGVD28')):
            if f.get(key) is not None:
                h_ortho.append({'value': float(f[key]), 'text': str(f[key]), 'datum': vd})
        monument = None
        if f.get('monument'):
            monument = {'code': monument_code(f['monument']), 'text': f['monument']}
        aliases = [a for a in {r['origine']} if a and norm_id(a) != norm_id(mat)]
        yield record(
            SRC, mat, lat, lng, TYPE.get(r['typeRaw'], 'u'), 'nad83csrs-qc',
            name=r['origine'] if r['origine'] and r['origine'] != mat else None,
            aliases=aliases,
            posAcc=pos_acc,
            status=status,
            statusRaw=r['etat'],
            hEll=float(f['hEll']) if f.get('hEll') is not None else None,
            hEllText=str(f['hEll']) if f.get('hEll') is not None else None,
            hOrtho=h_ortho,
            geo=geo,
            grids=grids,
            monument=monument,
            lastVisit=f.get('lastVisit'),
            sheet=mat,
        )

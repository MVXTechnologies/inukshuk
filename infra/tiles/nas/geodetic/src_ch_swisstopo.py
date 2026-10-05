"""Switzerland — swisstopo national fixed points (SOURCES.md #6).

STAC bulk files, rebuilt daily: LFP1 (horizontal, ~634), HFP1 (levelling,
~8,954) shapefiles in LV95, and AGNES (41 permanent GNSS stations, INTERLIS
XML with LV95 and CHTRF95 geocentric coordinates).

swisstopo publishes LV95 E/N (+ LN02 heights), not latitude/longitude, so
the display position is computed: pyproj EPSG:2056 → 4326, validated against
swisstopo's own REFRAME service in test_src_ch.py. AGNES stations use their
published CHTRF95 XYZ (an exact geocentric → geographic conversion).
Each point's PDF protocol URL is kept per record (`url`).
"""
import os
import xml.etree.ElementTree as ET
import zipfile

from common import download, fnum, log, read_shapefile, record
from src_util import ecef_to_geodetic, grid, height, monument_from_words, to_wgs84

SRC = 'ch-swisstopo'
STAC = 'https://data.geo.admin.ch/ch.swisstopo.fixpunkte-{c}/fixpunkte-{c}/fixpunkte-{c}_2056{suffix}'
FILES = {
    'lfp1': '_5728.shp.zip',
    'hfp1': '_5728.shp.zip',
    'agnes': '.xml.zip',
}
ACTIVE = ('aktiv', 'actif', 'attivo', 'active')
MONUMENT = (
    (('pfeiler', 'pilier', 'pilastro', 'pilastr'), 'pillar'),
    (('bolzen', 'boulon', 'bullone', 'kappenbolzen', 'chiodo', 'nagel'), 'bolt'),
    (('granitstein', 'stein', 'pierre', 'pietra', 'borne', 'grenzstein', 'cippo'), 'stone'),
    (('rohr', 'tube', 'tubo'), 'pipe'),
    (('kreuz', 'croix', 'croce', 'meissel', 'gravé'), 'cut'),
    (('kirch', 'turm', 'tour', 'torre', 'église', 'chiesa', 'antenne', 'antenna', 'mast'), 'structure'),
    (('platte', 'plaque', 'piastra', 'scheibe', 'disque'), 'disk'),
)
LV95 = 2056


def fetch(raw_dir):
    os.makedirs(raw_dir, exist_ok=True)
    for c, suffix in FILES.items():
        zpath = os.path.join(raw_dir, f'{c}.zip')
        changed = download(STAC.format(c=c, suffix=suffix), zpath)
        out = os.path.join(raw_dir, c)
        if changed or not os.path.isdir(out):
            os.makedirs(out, exist_ok=True)
            with zipfile.ZipFile(zpath) as z:
                for name in z.namelist():
                    if name.lower().endswith(('.shp', '.dbf', '.xml', '.cpg', '.prj')):
                        with z.open(name) as src, open(os.path.join(out, os.path.basename(name)), 'wb') as dst:
                            dst.write(src.read())
        log(f'{SRC}: {c} {"updated" if changed else "unchanged"}')


def _shp(d):
    for name in sorted(os.listdir(d)):
        if name.lower().endswith('.shp'):
            return os.path.join(d, name[:-4])
    raise FileNotFoundError(d)


def _lv95_rows(raw_dir, c):
    d = os.path.join(raw_dir, c)
    cpg = next((n for n in os.listdir(d) if n.lower().endswith('.cpg')), None)
    enc = 'utf-8'
    if cpg:
        enc = open(os.path.join(d, cpg)).read().strip() or 'utf-8'
    yield from read_shapefile(_shp(d), enc)


def _fixpoint(r, c, type_):
    e, n = fnum(r.get('E95')), fnum(r.get('N95'))
    if e is None or n is None:
        return None
    lat, lng = to_wgs84(LV95, e, n)
    status_raw = (r.get('STATUS') or 'Aktiv').strip()
    acc = fnum(r.get('L_GEN_LV95'))
    h_ortho = []
    h = height(r.get('H02'), 'LN02', r.get('H02'))
    if h:
        h_ortho.append(h)
    mon = (r.get('KENNZEICHN') or '').strip()
    ident = f"{r.get('NBIDENT', '').strip()}_{r.get('NUMMER', '').strip()}"
    name = (r.get('PUNKTNAME') or '').strip()
    g = grid('LV95', r.get('E95'), r.get('N95'))
    return record(
        SRC, ident, lat, lng, type_, 'lv95',
        name=name or None,
        aliases=[a for a in {name, (r.get('NUMMER') or '').strip()} if a and len(a) >= 3],
        # The display position is a computed transform (~0.1 m) on top of the
        # agency's own position accuracy.
        posAcc=acc if acc is not None and acc >= 1 else None,
        status='ok' if status_raw.lower() in ACTIVE else 'unknown',
        statusRaw=status_raw,
        hOrtho=h_ortho,
        grids=[g] if g else [],
        monument={'code': monument_from_words(mon, MONUMENT), 'text': mon} if mon else None,
        url=(r.get('PROTO_URL') or '').strip() or None,
        sheet=ident,
    )


def _agnes(raw_dir):
    d = os.path.join(raw_dir, 'agnes')
    xml = next(os.path.join(d, n) for n in os.listdir(d) if n.lower().endswith('.xml'))
    ns = {'i': 'http://www.interlis.ch/INTERLIS2.3'}
    root = ET.parse(xml).getroot()
    names = {}
    for den in root.iter('{http://www.interlis.ch/INTERLIS2.3}AGNES_V1_1.Stations_Catalogue.Station_Denomination'):
        names[den.get('TID')] = (den.findtext('i:Code', '', ns), den.findtext('i:Name', '', ns))
    for st in root.iter('{http://www.interlis.ch/INTERLIS2.3}AGNES_V1_1.AGNES_Stations.AGNES_Station'):
        ref = st.find('.//i:Reference', ns)
        code, name = names.get(ref.get('REF') if ref is not None else None, ('', ''))
        lv = st.find('i:GeometryLV95/i:COORD', ns)
        xyz = st.find('i:GeometryCHTRF95/i:COORD', ns)
        if not code or xyz is None:
            continue
        x, y, z = (float(xyz.findtext(f'i:C{k}', '', ns)) for k in (1, 2, 3))
        lat, lng, h_ell = ecef_to_geodetic(x, y, z)
        grids = []
        if lv is not None:
            g = grid('LV95', lv.findtext('i:C1', '', ns), lv.findtext('i:C2', '', ns))
            if g:
                grids.append(g)
        yield record(
            SRC, code, lat, lng, 'gnss', 'lv95',
            name=name or None, aliases=[code],
            grids=grids[:2],
            url=(st.findtext('i:URL', '', ns) or '').strip() or None,
            sheet=code,
        )


def normalize(raw_dir):
    n = 0
    for c, type_ in (('lfp1', 'h'), ('hfp1', 'v')):
        for r, _xy in _lv95_rows(raw_dir, c):
            rec = _fixpoint(r, c, type_)
            if rec:
                n += 1
                yield rec
    for rec in _agnes(raw_dir):
        n += 1
        yield rec
    log(f'{SRC}: {n} points')

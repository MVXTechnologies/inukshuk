"""Spain — IGN España geodetic networks (SOURCES.md #8).

OGC API Features (api-features.ign.es), followed by `next` links, 10,000 per
page: ROI (~9,994 vertices), REGENTE (~1,115, a subset of ROI vertices —
same vertex number, so the same uid), REDNAP (~30,334 levelling marks) and
ERGNSS (~125 permanent stations). IGN publishes ETRS89 lat/lon (REGCAN95 in
the Canary Islands), UTM, ellipsoidal and orthometric heights — kept
verbatim; the datasheet ("reseña") URL is per record. No status is published.

Heights: the peninsula's orthometric heights are on REDNAP (Alicante tide
gauge); the islands, Ceuta and Melilla have their own local tide-gauge
datums, labelled "Local vertical datum" rather than guessed.
"""
import os

from common import fnum, log, record
from src_util import features, grid, height, merge_colocated, next_link_pages, text_of

SRC = 'es-ign'
API = 'https://api-features.ign.es/collections/{c}/items?limit=10000&f=json'
COLLECTIONS = ('red_roi', 'red_regente', 'red_nap', 'red_ergnss')
# Provinces whose heights are NOT on the Alicante datum.
ISLANDS = {7, 35, 38, 51, 52}
ISLAND_NAMES = ('balears', 'baleares', 'las palmas', 'santa cruz de tenerife', 'ceuta', 'melilla')


def fetch(raw_dir):
    for c in COLLECTIONS:
        next_link_pages(os.path.join(raw_dir, c), API.format(c=c), label=f'{SRC} {c}')


def _vdatum(cod_prov=None, prov_name=''):
    if cod_prov is not None and int(cod_prov) in ISLANDS:
        return 'Local vertical datum'
    if any(n in (prov_name or '').lower() for n in ISLAND_NAMES):
        return 'Local vertical datum'
    return 'REDNAP (Alicante)'


def _datum(lng, lat):
    return 'regcan95' if lng < -12 and lat < 30 else 'etrs89'


def _utm(p, ex, ny, zone_key='huso'):
    z = fnum(p.get(zone_key))
    if z is None:
        return None
    return grid(f'UTM {int(z)}N', p.get(ex), p.get(ny))


def _vertex(p, f, type_):
    lat, lng = fnum(p.get('lat_etrs89')), fnum(p.get('long_etrs89'))
    if lat is None or lng is None:
        lng, lat = f['geometry']['coordinates'][:2]
    vid = str(f.get('id'))
    h_ortho = [h for h in [height(p.get('alt_orto'), _vdatum(p.get('cod_provincia'), p.get('provincia')))] if h]
    g = _utm(p, 'x_etrs89', 'y_etrs89')
    return record(
        SRC, vid, lat, lng, type_, _datum(lng, lat),
        name=(p.get('nombre') or '').strip() or None,
        aliases=[a for a in {(p.get('nombre') or '').strip()} if a],
        geo=f"{text_of(p.get('lat_etrs89'))}, {text_of(p.get('long_etrs89'))}"
        if p.get('lat_etrs89') is not None else None,
        grids=[g] if g else [],
        hEll=fnum(p.get('alt_elip')), hEllText=text_of(p.get('alt_elip')),
        hOrtho=h_ortho,
        status='unknown',
        lastVisit=None,
        url=p.get('resena'),
        sheet=vid,
    )


def normalize(raw_dir):
    """All networks, a mark in two of them (vertex + REDNAP, vertex + ERGNSS) once."""
    recs = merge_colocated(list(_records(raw_dir)))
    log(f'{SRC}: {len(recs)} marks after merging co-located network entries')
    return iter(recs)


def _records(raw_dir):
    n = 0
    seen = set()
    for c, type_ in (('red_regente', '3d'), ('red_roi', '3d')):
        for f in features(os.path.join(raw_dir, c)):
            rec = _vertex(f['properties'], f, type_)
            if rec['uid'] in seen:
                continue  # a REGENTE vertex is also an ROI vertex
            seen.add(rec['uid'])
            n += 1
            yield rec
    for f in features(os.path.join(raw_dir, 'red_nap')):
        p = f['properties']
        lat, lng = fnum(p.get('latitud_etrs89')), fnum(p.get('longitud_etrs89'))
        if lat is None or lng is None:
            lng, lat = f['geometry']['coordinates'][:2]
        resena = p.get('resena') or ''
        # .../REDNAP/Lin00000/12.pdf → "Lin00000/12": unique (the feature id is per line)
        ident = '/'.join(resena.removesuffix('.pdf').split('/')[-2:]) if resena else f"NAP{f.get('id')}"
        h = height(p.get('ortometrica'), _vdatum(prov_name=p.get('nombre_prov')))
        n += 1
        yield record(
            SRC, ident, lat, lng, 'v', _datum(lng, lat),
            name=(p.get('nombre') or '').strip() or None,
            aliases=[a for a in {(p.get('nombre') or '').split(' (')[0].strip()} if len(a) >= 3],
            geo=f"{text_of(p.get('latitud_etrs89'))}, {text_of(p.get('longitud_etrs89'))}"
            if p.get('latitud_etrs89') is not None else None,
            hEll=fnum(p.get('altitud_elipsoidal')), hEllText=text_of(p.get('altitud_elipsoidal')),
            hOrtho=[h] if h else [],
            status='unknown',
            url=resena or None,
            sheet=ident,
        )
    for f in features(os.path.join(raw_dir, 'red_ergnss')):
        p = f['properties']
        lat, lng = fnum(p.get('latitud')), fnum(p.get('longitud'))
        if lat is None or lng is None:
            lng, lat = f['geometry']['coordinates'][:2]
        code = str(f.get('id'))
        g = _utm(p, 'x_UTM', 'y_UTM')
        h = height(p.get('alt_orto'), _vdatum(prov_name=p.get('nombre_prov')))
        n += 1
        yield record(
            SRC, code, lat, lng, 'gnss', _datum(lng, lat),
            name=(p.get('nombre') or '').strip() or None,
            aliases=[a for a in {code, (p.get('cod_iers') or '').strip()} if a],
            geo=f"{text_of(p.get('latitud'))}, {text_of(p.get('longitud'))}" if p.get('latitud') is not None else None,
            grids=[g] if g else [],
            hEll=fnum(p.get('altura_elipsoidal')), hEllText=text_of(p.get('altura_elipsoidal')),
            hOrtho=[h] if h else [],
            status='ok',
            url=p.get('resena'),
            sheet=code,
        )
    log(f'{SRC}: {n} marks')

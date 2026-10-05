"""Brazil — IBGE Banco de Dados Geodésicos (SOURCES.md #20).

Open WFS geoservicos.ibge.gov.br/geoserver, one layer per network: RN
(levelling benchmarks, ~71.5k), GPS (~3.6k), VT (triangulation vertices,
~3.6k), EP (traverse stations, ~1.1k), DOP (Doppler stations, ~1k). The EG
layer (gravity stations) is out of scope. All SIRGAS2000; heights on the
Imbituba datum (Santana in Amapá), normal heights for levelled marks.

Published lat/lon (decimal + DMS text) is the display position. Numbers use
Brazilian formatting ("1.008,77"): thousands dots dropped, comma → dot.
Positions taken from a map sheet ("Carta 1:50000") or a navigation GPS are
approximate and carry an honest ±. Datasheet: relatorio.asp?L1={ESTACAO}.
"""
import os
import re
import urllib.parse

from common import log, record
from src_util import date_of, features, height, offset_pages

SRC = 'br-ibge'
WFS = 'https://geoservicos.ibge.gov.br/geoserver/wfs'
LAYERS = {'RN': 'v', 'GPS': '3d', 'VT': 'h', 'EP': 'h', 'DOP': '3d'}
PAGE = 10000
STATUS = (('DESTRU', 'destroyed'), ('NÃO ENCONTRADO', 'notFound'), ('NAO ENCONTRADO', 'notFound'),
          ('DANIFICAD', 'damaged'), ('BOM', 'ok'))
# Where the published position comes from → how far it may be off (m).
COORD_SOURCE_ACC = (('1:500000', 250.0), ('1:250000', 125.0), ('1:100000', 50.0), ('1:50000', 25.0),
                    ('1:25000', 12.0), ('GPS NAVEGA', 10.0))
VDATUM = {'IMBITUBA': 'Imbituba', 'SANTANA': 'Santana'}


def fetch(raw_dir):
    for layer in LAYERS:
        def url_for(offset, layer=layer):
            return WFS + '?' + urllib.parse.urlencode({
                'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature',
                'typeNames': f'CGED:BDG_{layer}', 'outputFormat': 'application/json',
                'srsName': 'EPSG:4674', 'count': PAGE, 'startIndex': offset, 'sortBy': 'ESTACAO'})
        offset_pages(os.path.join(raw_dir, layer), url_for, PAGE, label=f'{SRC} {layer}')


def br_text(s):
    """'1.008,77' → '1008.77'; ' 23º 04\\' 27,5"  S' → '23º 04\\' 27.5" S'."""
    if s is None:
        return None
    t = re.sub(r'\s+', ' ', str(s)).strip()
    if re.fullmatch(r'-?[\d.]+,\d+', t):
        return t.replace('.', '').replace(',', '.')
    return re.sub(r'(\d),(\d)', r'\1.\2', t) or None


def _status(s):
    t = (s or '').upper()
    for needle, out in STATUS:
        if needle in t:
            return out
    return 'unknown'


def _acc(source):
    t = (source or '').upper()
    for needle, acc in COORD_SOURCE_ACC:
        if needle in t:
            return acc
    return None


def station(p, layer):
    lat, lng = p.get('LATITUDE'), p.get('LONGITUDE')
    sid = (p.get('ESTACAO') or '').strip()
    if lat is None or lng is None or not sid:
        return None
    vd = VDATUM.get((p.get('DATUM_ALT') or '').strip().upper())
    h_ortho = []
    if vd:
        for key in ('ALT_NORMAL', 'ALT_ORTO'):
            txt = br_text(p.get(key))
            if txt:
                h_ortho.append(height(txt, vd, txt))
                break
    ell = br_text(p.get('ALTGEOM'))
    type_ = LAYERS[layer]
    if type_ == '3d' and not ell:
        type_ = 'h'
    geo = None
    if p.get('LATGMS') and p.get('LONGMS'):
        geo = f"{br_text(p['LATGMS'])}, {br_text(p['LONGMS'])}"
    situ = (p.get('SITUACAO') or '').strip()
    return record(
        SRC, sid, float(lat), float(lng), type_, 'sirgas2000',
        geo=geo,
        posAcc=_acc(p.get('FONTECOORD')),
        status=_status(situ) if situ else 'unknown',
        statusRaw=' · '.join(x for x in (situ, p.get('FONTECOORD') or '') if x) or None,
        hEll=float(ell) if ell else None, hEllText=ell,
        hOrtho=[h for h in h_ortho if h],
        lastVisit=date_of(p.get('VISITA')),
        sheet=sid,
    )


def normalize(raw_dir):
    n = 0
    seen = set()
    for layer in LAYERS:
        for f in features(os.path.join(raw_dir, layer)):
            rec = station(f.get('properties') or {}, layer)
            if rec is None or rec['uid'] in seen:
                continue
            seen.add(rec['uid'])
            n += 1
            yield rec
    log(f'{SRC}: {n} stations')

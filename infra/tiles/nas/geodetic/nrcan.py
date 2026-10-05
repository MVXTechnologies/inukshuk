"""Canada — NRCan Canadian Geodetic Survey passive networks (SOURCES.md #2).

No bulk file. The CSRS webapp's own endpoints, no login:
- getStations.php (bbox, one network) → id, name, lat/lon, status; at most
  500 stations per answer (it says so in `warningHTML`), so boxes are split
  in four until each answers in full;
- stationsDownload.php (POST up to ~40 ids) → CSV with sigmas, ellipsoidal
  height, reference system and CGVD2013 / CGVD28 heights. Traps: west
  longitudes come back POSITIVE, and big batches silently return fewer rows.
"""
import csv
import io
import json
import os
import time
import urllib.parse

from common import fnum, http_get, log, record, resumable

SRC = 'ca-nrcan'
BASE = 'https://webapp.csrs-scrs.nrcan-rncan.gc.ca/geod/process'
NETWORKS = ('cbn', 'hp3d', 'hc', 'pvc')
TYPE = {'CBN': '3d', 'HP3D': '3d', 'HC': 'h', 'PVC': 'v'}
CANADA = (-142.0, 41.0, -52.0, 84.0)
BATCH = 40
PAUSE_S = float(os.environ.get('NRCAN_PAUSE_S', '0.7'))
STATUS = {'GOOD': 'ok', 'BAD': 'damaged', 'DESTROYED': 'destroyed', 'NOT FOUND': 'notFound',
          'NOTFOUND': 'notFound', 'UNKNOWN': 'unknown', 'MISSING': 'notFound'}


def _stations(net, bbox, depth=0):
    w, s, e, n = bbox
    body = urllib.parse.urlencode({
        'map': net, 'maxlatitude': n, 'minlatitude': s, 'minlongitude': w, 'maxlongitude': e,
    }).encode()
    d = json.loads(http_get(f'{BASE}/getStations.php', data=body))
    time.sleep(PAUSE_S)
    if 'Too many' in (d.get('warningHTML') or ''):
        if depth > 12:
            raise RuntimeError(f'{net} {bbox}: still too many at depth {depth}')
        mx, my = (w + e) / 2, (s + n) / 2
        out = []
        for part in ((w, s, mx, my), (mx, s, e, my), (w, my, mx, n), (mx, my, e, n)):
            out.extend(_stations(net, part, depth + 1))
        return out
    return [st for grp in (d.get('networks') or {}).get('stations') or [] for st in grp]


def fetch(raw_dir):
    os.makedirs(raw_dir, exist_ok=True)
    index_path = os.path.join(raw_dir, 'stations.json')
    resume = resumable(index_path)
    if resume:
        stations = json.load(open(index_path))
    else:
        stations = {}
        for net in NETWORKS:
            got = _stations(net, CANADA)
            for st in got:
                prev = stations.get(st['id'])
                nets = sorted(set((prev or {}).get('nets', [])) | {st['net']})
                stations[st['id']] = {**st, 'nets': nets}
            log(f'{SRC}: {net}: {len(got)} stations')
        json.dump(stations, open(index_path + '.tmp', 'w'))
        os.replace(index_path + '.tmp', index_path)
    csv_path = os.path.join(raw_dir, 'details.csv')
    have = set()
    if resume and os.path.exists(csv_path):
        with open(csv_path, encoding='utf-8') as f:
            have = {r['Unique Number'] for r in csv.DictReader(f)}
    elif os.path.exists(csv_path):
        os.remove(csv_path)
    ids = sorted(i for i, st in stations.items()
                 if i not in have and STATUS.get((st.get('status') or '').upper()) != 'destroyed')
    log(f'{SRC}: {len(ids)} station details to fetch ({len(have)} kept)')
    header_written = os.path.exists(csv_path)
    with open(csv_path, 'a', encoding='utf-8', newline='') as out:
        writer = None
        for k in range(0, len(ids), BATCH):
            batch = ids[k:k + BATCH]
            rows = _details(batch)
            missing = set(batch) - {r['Unique Number'] for r in rows}
            for mid in sorted(missing):  # big batches come back short: retry one by one
                rows.extend(_details([mid]))
            if writer is None:
                fields = list(rows[0].keys()) if rows else None
                if fields:
                    writer = csv.DictWriter(out, fieldnames=fields, extrasaction='ignore')
                    if not header_written:
                        writer.writeheader()
            if writer:
                writer.writerows(rows)
                out.flush()
            if (k // BATCH) % 100 == 0:
                log(f'{SRC}: details {k + len(batch)}/{len(ids)}')


def _details(ids):
    body = urllib.parse.urlencode({'id': ','.join(ids), 'type': 'csv', 'map': ''}).encode()
    text = http_get(f'{BASE}/stationsDownload.php', data=body).decode('utf-8-sig', 'replace')
    time.sleep(PAUSE_S)
    return [r for r in csv.DictReader(io.StringIO(text)) if r.get('Unique Number')]


def datum_of(ref):
    ref = (ref or '').upper().replace(' ', '')
    if 'CSRS' in ref:
        return 'nad83csrs'
    return 'nad83-approx'


def normalize(raw_dir):
    stations = json.load(open(os.path.join(raw_dir, 'stations.json')))
    details = {}
    path = os.path.join(raw_dir, 'details.csv')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            details = {r['Unique Number']: r for r in csv.DictReader(f)}
    for sid, st in stations.items():
        d = details.get(sid, {})
        nets = st.get('nets') or [st.get('net')]
        type_ = next((TYPE[n] for n in ('CBN', 'HP3D', 'HC', 'PVC') if n in nets), 'u')
        cond = (d.get('Condition') or st.get('status') or '').upper()
        lat, lng = fnum(d.get('Latitude')), fnum(d.get('Longitude'))
        if lat is None or lng is None:
            lat, lng = st.get('lat'), st.get('lon')
        if lat is None or lng is None:
            continue
        lng = -abs(lng)  # the CSV gives west longitudes as positive
        datum = datum_of(d.get('Reference system'))
        sig = max(fnum(d.get('Latitude sigma')) or 0, fnum(d.get('Longitude sigma')) or 0)
        h_ortho = []
        for vd in ('CGVD2013', 'CGVD28', 'IGLD85'):
            v = fnum(d.get(vd))
            if v is not None:
                h_ortho.append({'value': v, 'text': d[vd].strip(), 'datum': vd})
        # NRCan's own published latitude / longitude text (west given positive).
        lat_t, lng_t = (d.get('Latitude') or '').strip(), (d.get('Longitude') or '').strip()
        geo = f'{lat_t}° N, {lng_t.lstrip("-")}° W' if lat_t and lng_t else None
        ell_t = (d.get('Ellipsoidal height') or '').strip()
        name = (st.get('n') or d.get('Name') or '').strip()
        # The name often carries another agency's designation in brackets:
        # "XLB (82H0380)" — that is how NRCan ↔ MRNF twins are found (DESIGN §4).
        aliases = []
        if '(' in name and name.endswith(')'):
            aliases.append(name[name.rindex('(') + 1:-1].strip())
        if name and name != sid:
            aliases.append(name.split(' (')[0].strip())
        yield record(
            SRC, sid, lat, lng, type_, datum,
            name=name if name and name != sid else None,
            aliases=[a for a in aliases if a],
            posAcc=None if datum == 'nad83csrs' and sig and sig < 1 else 10.0,
            status=STATUS.get(cond, 'unknown'),
            statusRaw=cond or None,
            hEll=fnum(ell_t) if datum == 'nad83csrs' and ell_t else None,
            hEllText=ell_t if datum == 'nad83csrs' and ell_t else None,
            hOrtho=h_ortho,
            geo=geo,
            lastVisit=None,
            sheet=sid,
        )

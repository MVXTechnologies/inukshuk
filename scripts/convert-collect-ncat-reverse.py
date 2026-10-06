#!/usr/bin/env python3
"""Validate the REVERSE NADCON5 directions against NOAA's own tool.

The Phase-1 study queried NCAT for NAD83(2011) → NAD27 / NAD83(1986) only.
The app also offers NAD27 → NAD83(2011) and NAD83(1986) → NAD83(2011); a
round trip of PROJ's grids closes at 2.7 mm, beyond our 1 mm gate, so the
reverse direction gets its own official oracle instead of an assumption.

    scripts/convert-collect-ncat-reverse.py [reference_points.json]

Input points = NCAT's own NAD27 / NAD83(1986) outputs for the 17 study marks
(the `expected` values of the forward pairs). Writes the raw responses to
`scripts/convert-extra-references.json`, which scripts/convert-fixtures.py
merges as two pairs. Polite: one request per second, standard library only.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT = os.path.expanduser('~/Documents/inukshuk-saved/chart-datum-convert/research/validation/reference_points.json')
OUT = os.path.join(HERE, 'convert-extra-references.json')
API = 'https://geodesy.noaa.gov/api/ncat/llh'


def get(params):
    url = API + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'User-Agent': 'inukshuk-convert-validation/1 (MVX Technologies)'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return url, json.loads(r.read())


def main():
    ref = json.load(open(sys.argv[1] if len(sys.argv) > 1 else DEFAULT))
    out = {'collected': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'tool': 'NOAA NCAT llh (NADCON 5.0)', 'pairs': {}}
    for fwd_id, in_datum in (('US-NADCON5-NAD83_2011-to-NAD27', 'nad27'), ('US-NADCON5-NAD83_2011-to-NAD83_1986', 'nad83(1986)')):
        pair = next(p for p in ref['pairs'] if p['pair_id'] == fwd_id)
        rows = []
        for pt in pair['points']:
            lon, lat = pt['expected'][0], pt['expected'][1]
            url, js = get({'lat': f'{lat:.10f}', 'lon': f'{lon:.10f}', 'eht': '0', 'inDatum': in_datum, 'outDatum': 'nad83(2011)'})
            rows.append({'id': pt['id'], 'input': [lon, lat], 'original': pt['input'], 'url': url, 'response': js})
            time.sleep(1.0)
        out['pairs'][fwd_id] = rows
        print(fwd_id, len(rows))
    json.dump(out, open(OUT, 'w'), indent=1)
    print('→', OUT)


if __name__ == '__main__':
    main()

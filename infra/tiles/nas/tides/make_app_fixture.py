#!/usr/bin/env python3
"""Write src/core/tides/__fixtures__/stations.json: real stations encoded by the
pipeline's own `build.props`, so the app's decoder and card are tested on
exactly what the tiles carry.

    python3 infra/tiles/nas/tides/make_app_fixture.py

Ellipsoid values are what derive.py computes from the validation suite's
oracle numbers (fixtures/cd_reference_points.json, VDatum JSON): The Battery
(CO-OPS + GEOID18 vs VDatum), Brest (SHOM zh_elli vs RAF20), Bergen
(Kartverket NN2000 + HREF2018B vs the CD grid). No network.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build  # noqa: E402
import derive  # noqa: E402
import normalize as N  # noqa: E402
from test_tides import FakeGeoid, battery, ram_sites, ref_pair  # noqa: E402

FX = os.path.join(HERE, 'fixtures')
OUT = os.path.join(HERE, '..', '..', '..', '..', 'src', 'core', 'tides', '__fixtures__', 'stations.json')


def main():
    out = {}
    b = battery()
    vd = json.load(open(os.path.join(FX, 'vdatum_battery_MLLW_to_NAD83_2011.json')))
    g = FakeGeoid({('GEOID18', -74.01417, 40.700554): -31.923})
    b['ell'], _ = derive.derive_coops(b, g, lambda r: {'h': float(vd['t_z']), 'unc': None})
    out['battery'] = build.props(b)

    pair = ref_pair('CD-FR-RAM-vs-RAF20')
    pt = next(p for p in pair['points'] if p['id'].startswith('Brest ('))
    brest = N.shom_station(next(p for p in ram_sites() if p['site'] == 'Brest'))
    lon, lat, zh_ref = pt['input']
    brest['ell'], _ = derive.derive_shom(brest, FakeGeoid({('RAF20', round(lon, 6), round(lat, 6)): pt['proj_result'][2] - zh_ref}))
    brest.pop('ellPublished', None)
    out['brest'] = build.props(brest)

    kv = N.kartverket_station(open(os.path.join(FX, 'kv_BGO_cd.xml'), 'rb').read(),
                              open(os.path.join(FX, 'kv_BGO_nn2000.xml'), 'rb').read())
    npt = next(p for p in ref_pair('CD-NO-station-vs-grid')['points'] if p['id'].startswith('BGO'))
    n = 46.0  # placeholder N; the shown value is NN2000 offset + N, checked against grid = proj_result + N
    kv['ell'], _ = derive.derive_kartverket(kv, FakeGeoid({('HREF2018B', 5.320487, 60.398046): n,
                                                           ('NO_CD_2023B', 5.320487, 60.398046): npt['proj_result'][2] + n}))
    out['bergen_no_ellipsoid'] = build.props(dict(kv, ell=None))

    jma = N.jma_stations(open(os.path.join(FX, 'jma_station.html'), encoding='utf-8').read())
    out['wakkanai'] = build.props(jma[0])

    sec = battery()
    sec['id'], sec['name'], sec['kind'], sec['live'] = '8518962', 'SECONDARY (synthetic)', 'sec', None
    sec['levels'] = [lv for lv in sec['levels'] if lv['code'] not in ('HAT', 'LAT')]
    out['secondary_with_reference_port'] = build.props(sec, battery())

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print('wrote', os.path.normpath(OUT))


if __name__ == '__main__':
    main()

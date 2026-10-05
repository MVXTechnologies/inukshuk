"""The v1 catalogue: sources, horizontal datums and vertical datums.

Tiles carry small integers (`s`, `d`, `hd`) that index these lists, so the
lists are APPEND-ONLY: never reorder or remove an entry once published.

`write_json` emits the catalogue the app bundles
(src/core/geodetic/catalog-v1.json); test_geodetic.py fails when the two drift.

Datum `proj` says which projected coordinates the app computes on device
(proj4, from the tile's exact lat/lng): `mtm` (Québec SCOPQ, 3° zones),
`utm`, `lambert93`, `lv95`, `osgb`, `rd`, or null (geographic only).
"""
import json

# key, display name, network/series, licence, attribution (card footer), licence URL,
# datasheet URL template ({id} = the tile's `i`) or None, minimum count gate.
SOURCES = [
    ('qc-mrnf', 'MRNF Québec', 'Réseau géodésique du Québec', 'CC BY 4.0',
     '© Gouvernement du Québec (MRNF) · CC BY 4.0',
     'https://www.donneesquebec.ca/recherche/dataset/points-geodesiques',
     'https://fichegeodesique.mern.gouv.qc.ca/matricule-datum/{id}/2', 70000),
    ('ca-nrcan', 'NRCan', 'Canadian Geodetic Survey', 'OGL-Canada',
     'Contains information licensed under the Open Government Licence – Canada (NRCan)',
     'https://open.canada.ca/en/open-government-licence-canada',
     'https://webapp.csrs-scrs.nrcan-rncan.gc.ca/geod/data-donnees/station/report-rapport.php?id={id}',
     50000),
    ('us-ngs', 'NOAA NGS', 'National Spatial Reference System', 'Public domain',
     'NOAA National Geodetic Survey',
     'https://geodesy.noaa.gov/datasheets/',
     'https://geodesy.noaa.gov/cgi-bin/ds_mark.prl?PidBox={id}', 600000),
    ('osm', 'OpenStreetMap', 'man_made=survey_point', 'ODbL 1.0',
     '© OpenStreetMap contributors',
     'https://www.openstreetmap.org/copyright',
     'https://www.openstreetmap.org/node/{id}', 250000),
    ('fr-ign', 'IGN France', 'Géodésie et nivellement', 'Etalab 2.0',
     'IGN – Géodésie et nivellement · Licence Ouverte 2.0',
     'https://www.etalab.gouv.fr/licence-ouverte-open-licence/',
     None, 400000),
    ('ch-swisstopo', 'swisstopo', 'Fixpunkte LFP1 / HFP1 / AGNES', 'OGD swisstopo',
     '© swisstopo',
     'https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices',
     None, 8000),
    ('ch-cantons', 'Swiss cantons', 'Fixpunkte LFP2 / HFP2 (geodienste.ch)', 'Free with credit',
     '© cantonal surveys (geodienste.ch)',
     'https://www.geodienste.ch/services/fixpunkte',
     None, 15000),
    ('uk-os-trig', 'Ordnance Survey', 'Trig pillar archive', 'OGL v3',
     'Contains OS data © Crown copyright and database right',
     'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
     None, 15000),
    ('uk-os-bm', 'Ordnance Survey', 'Benchmark archive', 'OGL v3',
     'Contains OS data © Crown copyright and database right',
     'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
     None, 400000),
    ('es-ign', 'IGN España', 'ROI · REGENTE · REDNAP · ERGNSS', 'CC BY 4.0',
     '© Instituto Geográfico Nacional de España · CC BY 4.0',
     'https://www.ign.es/resources/licencia/Condiciones_licenciaUso_IGN.pdf',
     None, 30000),
    ('nl-rws', 'Rijkswaterstaat', 'NAP-peilmerken', 'CC0',
     'Rijkswaterstaat (CC0)', 'https://creativecommons.org/publicdomain/zero/1.0/', None, 100000),
    ('nl-kadaster', 'Kadaster', 'RDinfo', 'Public Domain',
     'Kadaster RDinfo', 'https://creativecommons.org/publicdomain/mark/1.0/', None, 3000),
    ('no-kartverket', 'Kartverket', 'Fastmerker', 'CC BY 4.0',
     '© Kartverket · CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', None, 50000),
    ('at-bev', 'BEV', 'Festpunkte', 'CC BY 4.0',
     '© BEV · CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', None, 50000),
    ('de-nw', 'Geobasis NRW', 'Höhenfestpunkte', 'dl-de/zero-2.0',
     'Geobasis NRW (dl-de/zero-2.0)', 'https://www.govdata.de/dl-de/zero-2-0', None, 50000),
    ('de-mv', 'LAiV M-V', 'Festpunkte', 'CC BY 4.0',
     '© GeoBasis-DE/M-V · CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', None, 20000),
    ('de-be', 'Berlin', 'Festpunkte', 'dl-de/zero-2.0',
     'Geoportal Berlin (dl-de/zero-2.0)', 'https://www.govdata.de/dl-de/zero-2-0', None, 4000),
    ('de-hh', 'LGV Hamburg', 'Festpunkte', 'dl-de/by-2.0',
     'Freie und Hansestadt Hamburg, LGV (dl-de/by-2.0)', 'https://www.govdata.de/dl-de/by-2-0', None, 1000),
    ('is-natt', 'Náttúrufræðistofnun', 'Landmælingapunktar', 'CC BY 4.0',
     'Náttúrufræðistofnun Íslands · CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', None, 2000),
    ('eu-epn', 'EUREF EPN', 'EUREF Permanent GNSS Network', 'CC BY 4.0',
     'EUREF Permanent GNSS Network · CC BY 4.0', 'https://epncb.oma.be/',
     'https://epncb.oma.be/_networkdata/siteinfo4onestation.php?station={id}', 300),
    ('au-nsw', 'NSW Spatial Services', 'SCIMS survey marks', 'CC BY 4.0',
     '© State of New South Wales (Spatial Services) · CC BY 4.0',
     'https://creativecommons.org/licenses/by/4.0/', None, 150000),
    ('au-vic', 'Vicmap Position', 'Survey marks', 'CC BY 4.0',
     '© State of Victoria · CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', None, 150000),
    ('au-qld', 'Queensland', 'Survey control', 'CC BY 4.0',
     '© State of Queensland · CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/',
     'https://qspatial.information.qld.gov.au/SurveyReport/{id}.pdf', 100000),
    ('au-sa', 'South Australia', 'Survey marks', 'CC BY 3.0 AU',
     '© Government of South Australia · CC BY 3.0 AU',
     'https://creativecommons.org/licenses/by/3.0/au/', None, 100000),
    ('au-tas', 'Tasmania', 'theLIST survey control', 'CC BY 3.0 AU',
     '© State of Tasmania (theLIST) · CC BY 3.0 AU',
     'https://creativecommons.org/licenses/by/3.0/au/', None, 8000),
    ('br-ibge', 'IBGE', 'Banco de Dados Geodésicos', 'Free with credit',
     'Fonte: IBGE', 'https://www.ibge.gov.br/',
     'http://www.bdg.ibge.gov.br/bdg/pdf/relatorio.asp?L1={id}', 80000),
    ('gl-ngl', 'Nevada Geodetic Laboratory', 'GNSS station list', 'Citation requested',
     'Nevada Geodetic Laboratory (Blewitt et al., 2018)', 'http://geodesy.unr.edu/',
     'http://geodesy.unr.edu/NGLStationPages/stations/{id}.sta', 10000),
    ('gl-igs', 'IGS', 'IGS network', 'IGS open data',
     'International GNSS Service', 'https://igs.org/data-access/',
     'https://network.igs.org/{id}', 300),
]
SOURCE_INDEX = {s[0]: i for i, s in enumerate(SOURCES)}
OSM = SOURCE_INDEX['osm']

# key, display name, epoch, modern (geocentric realization), proj kind
DATUMS = [
    ('nad83csrs-qc', 'NAD83(CSRS)', '1997.0', True, 'mtm'),
    ('nad83csrs', 'NAD83(CSRS)', None, True, 'utm'),
    ('nad83-approx', 'NAD83 (approx. / scaled)', None, False, 'utm'),
    ('nad83-2011', 'NAD83(2011)', '2010.0', True, 'utm'),
    ('nad83-1986', 'NAD83(1986)', None, False, 'utm'),
    ('nad83-harn', 'NAD83(HARN)', None, False, 'utm'),
    ('nad83-2007', 'NAD83(NSRS2007)', '2002.0', False, 'utm'),
    ('nad83-ma11', 'NAD83(MA11)', '2010.0', True, 'utm'),
    ('nad83-pa11', 'NAD83(PA11)', '2010.0', True, 'utm'),
    ('nad27', 'NAD27', None, False, 'utm'),
    ('wgs84', 'WGS 84', None, True, 'utm'),
    ('itrf', 'ITRF', None, True, 'utm'),
    ('rgf93', 'RGF93', None, True, 'lambert93'),
    ('lv95', 'CH1903+ / LV95', None, True, 'lv95'),
    ('osgb36', 'OSGB36', None, False, 'osgb'),
    ('etrs89', 'ETRS89', None, True, 'utm'),
    ('etrs89-rd', 'ETRS89', None, True, 'rd'),
    ('mgi', 'MGI (Gauss-Krüger)', None, False, 'utm'),
    ('gda2020', 'GDA2020', None, True, 'utm'),
    ('gda94', 'GDA94', None, False, 'utm'),
    ('sirgas2000', 'SIRGAS2000', '2000.4', True, 'utm'),
    ('isn2016', 'ISN2016', None, True, 'utm'),
    ('rd-bessel', 'RD (Amersfoort)', None, False, 'rd'),
    # wave 2 (appended)
    ('rgaf09', 'RGAF09', None, True, 'utm'),
    ('rgr92', 'RGR92', None, True, 'utm'),
    ('rgfg95', 'RGFG95', None, True, 'utm'),
    ('rgm23', 'RGM23', None, True, 'utm'),
    ('rgspm06', 'RGSPM06', None, True, 'utm'),
    ('regcan95', 'REGCAN95', None, True, 'utm'),
]
DATUM_INDEX = {d[0]: i for i, d in enumerate(DATUMS)}

# How far a position in this datum, drawn as if it were WGS 84, can be off —
# the honest "±" of the card's "≈ WGS 84 (display)" line. The pipeline never
# shifts datums (agency values are shown as published); the map position is
# the agency's own lat/lon, or its grid values converted with the published
# projection. Default 2 m.
WGS_OFFSET_M = {
    'nad83csrs-qc': 2, 'nad83csrs': 2, 'nad83-approx': 10, 'nad83-2011': 2, 'nad83-1986': 2,
    'nad83-harn': 2, 'nad83-2007': 2, 'nad83-ma11': 2, 'nad83-pa11': 2, 'nad27': 100,
    'wgs84': 1, 'itrf': 1, 'rgf93': 1, 'lv95': 1, 'osgb36': 5, 'etrs89': 1, 'etrs89-rd': 1,
    'mgi': 5, 'gda2020': 1, 'gda94': 2, 'sirgas2000': 1, 'isn2016': 1, 'rd-bessel': 1,
}


def wgs_offset_m(datum_key):
    return WGS_OFFSET_M.get(datum_key, 2)

# name, kind: 'ortho' (orthometric / normal height) or 'chart' (hydrographic
# chart / tidal datum — labelled "Chart datum", never shown as an orthometric H).
VDATUMS = [
    ('CGVD2013', 'ortho'),
    ('CGVD28', 'ortho'),
    ('NAVD88', 'ortho'),
    ('NGVD29', 'ortho'),
    ('IGLD85', 'ortho'),
    ('NGF-IGN69', 'ortho'),
    ('NGF-IGN78', 'ortho'),
    ('LN02', 'ortho'),
    ('LHN95', 'ortho'),
    ('ODN', 'ortho'),
    ('REDNAP (Alicante)', 'ortho'),
    ('NAP', 'ortho'),
    ('NN2000', 'ortho'),
    ('NN1954', 'ortho'),
    ('GHA (Adria)', 'ortho'),
    ('DHHN2016', 'ortho'),
    ('DHHN92', 'ortho'),
    ('ISH2004', 'ortho'),
    ('AHD', 'ortho'),
    ('Imbituba', 'ortho'),
    ('PRVD02', 'ortho'),
    ('GUVD04', 'ortho'),
    ('ASVD02', 'ortho'),
    ('NMVD03', 'ortho'),
    ('VIVD09', 'ortho'),
    ('Chart datum (local tidal)', 'chart'),
    ('Local vertical datum', 'ortho'),
    # wave 2 (appended)
    ('IGN 1988 (Guadeloupe)', 'ortho'),
    ('IGN 1987 (Martinique)', 'ortho'),
    ('IGN 1989 (Réunion)', 'ortho'),
    ('NGG 1977 (Guyane)', 'ortho'),
    ('IGN 2023 (Mayotte)', 'ortho'),
    ('Danger 1950 (Saint-Pierre-et-Miquelon)', 'ortho'),
    ('AHD83 (Tasmania)', 'ortho'),
    ('AHD79 (Tasmania)', 'ortho'),
    ('Santana', 'ortho'),
]
VDATUM_INDEX = {v[0]: i for i, v in enumerate(VDATUMS)}

# Build-record type → rank group for the thinning ladder (DESIGN.md §5.2).
TYPE_RANK = {'gnss': 0, '3d': 0, 'h': 1, 'v': 2, 'u': 3}


def is_modern(datum_key):
    return DATUMS[DATUM_INDEX[datum_key]][3]


def catalog():
    """The JSON the app bundles and the build checks against."""
    return {
        'version': 1,
        'sources': [
            {'key': k, 'name': n, 'network': net, 'licence': lic, 'attribution': att,
             'licenceUrl': url, 'sheet': sheet}
            for k, n, net, lic, att, url, sheet, _ in SOURCES
        ],
        'datums': [
            {'key': k, 'name': n, 'epoch': ep, 'modern': mod, 'wgsOffsetM': wgs_offset_m(k)}
            for k, n, ep, mod, _proj in DATUMS
        ],
        'vdatums': [{'name': n, 'kind': kind} for n, kind in VDATUMS],
    }


def write_json(path):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(catalog(), f, ensure_ascii=False, indent=2)
        f.write('\n')


if __name__ == '__main__':
    import sys

    write_json(sys.argv[1])

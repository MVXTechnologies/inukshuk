"""The tide-station catalogue: sources, chart-datum kinds and level codes.

Tiles carry small integers / short codes that index these lists, so the
SOURCES list is APPEND-ONLY: never reorder or remove an entry once published.

`write_json` emits the catalogue the app bundles (src/core/tides/catalog-v1.json);
test_tides.py fails when the two drift.

Licence gate (owner decision 2026-10-05, PLAN Q1 = c): CHS (Canada) data is
NEVER put in our tiles or side files — the app keeps CHS live-only. There is
no CHS entry here on purpose; `build.py` refuses any record whose source is
not in this list.
"""
import json

# key, display name, network, licence, attribution (card footer), licence URL,
# station page template ({id}), disclaimer shown on the card, minimum station count gate.
SOURCES = [
    ('us-coops', 'NOAA CO-OPS', 'Tides & Currents', 'Public domain',
     'NOAA/NOS/CO-OPS',
     'https://tidesandcurrents.noaa.gov/disclaimers.html',
     'https://tidesandcurrents.noaa.gov/datums.html?id={id}',
     'Not for navigation. Tidal datums are averages over the National Tidal Datum Epoch.',
     1500),
    ('fr-shom', 'Shom', 'Références Altimétriques Maritimes', 'Licence Ouverte 2.0',
     'Shom, 2025. Références Altimétriques Maritimes, doi:10.17183/MAREE_COURANTS_RAM · Licence Ouverte 2.0',
     'https://www.etalab.gouv.fr/licence-ouverte-open-licence/',
     'https://dx.doi.org/10.17183/MAREE_COURANTS_RAM',
     'Ne pas utiliser pour la navigation (not for navigation).',
     350),
    ('no-kartverket', 'Kartverket', 'Se havnivå', 'CC BY 4.0',
     '© Kartverket · CC BY 4.0',
     'https://www.kartverket.no/en/api-and-data/terms-of-use',
     'https://www.kartverket.no/en/at-sea/se-havniva',
     'Not for navigation.',
     25),
    ('jp-jma', 'JMA', '潮位表掲載地点 (tide-table stations)', 'Public Data Licence 1.0',
     '出典：気象庁ホームページ (Japan Meteorological Agency)',
     'https://www.jma.go.jp/jma/kishou/info/coment.html',
     'https://www.data.jma.go.jp/kaiyou/db/tide/suisan/suisan.php?stn={id}',
     'Not for navigation. The tide-table datum is close to, but not guaranteed equal to, the chart datum.',
     200),
]
SOURCE_INDEX = {s[0]: i for i, s in enumerate(SOURCES)}

# Chart-datum kinds: code, column label, long description (card's CD box).
CD_KINDS = [
    ('mllw', 'MLLW', 'Chart datum = Mean Lower Low Water (MLLW), US tidal datum, National Tidal Datum Epoch'),
    ('lwd', 'LWD', 'Chart datum = Low Water Datum of the lake (IGLD 1985)'),
    ('zh', 'ZH', 'Zéro hydrographique (chart datum), ≈ lowest astronomical tide'),
    ('sjokartnull', 'CD', 'Sjøkartnull (chart datum) = lowest astronomical tide (LAT)'),
    ('jma-tt', 'Tide-table datum', 'JMA tide-table datum (潮位表基準面) — close to, not guaranteed equal to, chart datum'),
]
CD_KIND_INDEX = {c[0]: i for i, c in enumerate(CD_KINDS)}

# Level code → English name. Agency codes are kept as published (SHOM's French
# acronyms, Kartverket's, NOAA's); the card shows the code plus this name.
LEVELS = {
    'HAT': 'Highest astronomical tide',
    'MHHW': 'Mean higher high water',
    'MHWS': 'Mean high water springs',
    'MHW': 'Mean high water',
    'MHWN': 'Mean high water neaps',
    'DTL': 'Mean diurnal tide level',
    'MTL': 'Mean tide level',
    'MSL': 'Mean sea level',
    'MLWN': 'Mean low water neaps',
    'MLW': 'Mean low water',
    'MLWS': 'Mean low water springs',
    'MLLW': 'Mean lower low water',
    'LAT': 'Lowest astronomical tide',
    # SHOM (RAM), French acronyms as published
    'PHMA': 'Plus haute mer astronomique (≈ HAT)',
    'PMVE': 'Pleine mer de vives-eaux moyenne (≈ MHWS)',
    'PMME': 'Pleine mer de mortes-eaux moyenne (≈ MHWN)',
    'NM': 'Niveau moyen (≈ MSL)',
    'BMME': 'Basse mer de mortes-eaux moyenne (≈ MLWN)',
    'BMVE': 'Basse mer de vives-eaux moyenne (≈ MLWS)',
    'PBMA': 'Plus basse mer astronomique (≈ LAT)',
    # recorded extremes
    'HOWL': 'Highest observed water level',
    'LOWL': 'Lowest observed water level',
}

# Vertical datums a CD offset may be given in (the table's middle column).
NATIONAL = {
    'NAVD88': 'NAVD88',
    'IGLD85': 'IGLD 1985',
    'IGN69': 'NGF-IGN69',
    'IGN78': 'NGF-IGN78 (Corse)',
    'NN2000': 'NN2000',
    'JGD2024': '標高 (GSI 測地成果2024)',
}


def catalog():
    return {
        'version': 1,
        'sources': [
            {'key': k, 'name': n, 'network': net, 'licence': lic, 'attribution': att,
             'licenceUrl': url, 'page': page, 'disclaimer': disc}
            for k, n, net, lic, att, url, page, disc, _ in SOURCES
        ],
        'cdKinds': [{'key': k, 'label': lab, 'description': d} for k, lab, d in CD_KINDS],
        'levels': LEVELS,
        'national': NATIONAL,
    }


def write_json(path):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(catalog(), f, ensure_ascii=False, indent=2)
        f.write('\n')


if __name__ == '__main__':
    import sys

    write_json(sys.argv[1])

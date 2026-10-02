# Québec ZEC maps — research (2026-10-02)

Question from the owner: _"All the ZECs in Québec probably have maps. Could
those be added to Explore?"_

Short answer: **yes, every zec has an official, free, georeferenced map — but
none is published under a licence, and the official download links are not
public.** So Explore now **links out** to all 63 zecs (the Sépaq pattern,
`scripts/catalog/collections/zecs.json`), and nothing is added to the download
catalog until Réseau Zec says yes. Nothing was rehosted, and no organisation
was contacted.

## What exists

- **Réseau Zec** (the network; brand "Zecs Québec") is at **reseauzec.com**.
  `zecquebec.com` is _not_ Réseau Zec any more — it is an unrelated hunting
  site. Each zec lives at `https://<name>.reseauzec.com/`, except Martin-Valin
  (`zecmartinvalin.com`). All 63 sites answered HTTP 200 on 2026-10-02
  (Martin-Valin returns 406 to scripted requests; fine in a browser).
- **Official territory maps, 1:40 000, one per zec, all 63.** Réseau Zec made
  them.
  - The **cartothèque** (<https://reseauzec.com/cartotheque/>) promises "free
    geospatial PDF downloads for all 63 zecs". Every link points to Réseau
    Zec's SharePoint and returns _"Désolé. Vous ne pouvez pas accéder à ce
    document"_ to an anonymous visitor (organisation-only or expired shares).
    Not tested logged in.
  - The same maps are **free ($0.00) in Avenza Maps** — 65 "Zec X (2025)"
    listings covering all 63 zecs, georeferenced, in-app only, no file URL.
    <https://store.avenza.com/collections/zecs-quebec>
- **23 zecs host at least one map file on their own site**, about 12 of them a
  whole-territory map; **8 are verified georeferenced** (GeoPDF markers in the
  first/last 64 KB), **5 cover the whole territory**.

## Licence / terms

- reseauzec.com footer: **"© 2021 Réseau Zec, Inc. Tous droits réservés."**
  No terms-of-use page (`/conditions-dutilisation/`, `/mentions-legales/`
  → 404).
- Avenza listings carry only a disclaimer ("Malgré tout le soin apporté par
  Zecs Québec … L'utilisateur dégage Zecs Québec de toute responsabilité").
- **No zec states a licence. Every row below is "needs permission"** for
  anything beyond a link to the zec's own website.
- Open data, for the record:
  - Données Québec, _Territoires fauniques structurés_ (zec boundaries):
    **CC-BY-NC-ND 4.0** — non-commercial, no derivatives; not usable as-is.
    <https://www.donneesquebec.ca/recherche/dataset/territoires-fauniques-structures>
  - Données Québec, _Couche des territoires récréatifs du Québec_ (includes
    zecs): **CC-BY 4.0**, updated 2026-09-02 — the usable boundary source if
    we ever draw zec outlines.
    <https://www.donneesquebec.ca/recherche/dataset/couche-des-territoires-recreatifs-du-quebec>
  - Réseau Zec open-data hub <https://data-reseauzec.opendata.arcgis.com/>:
    18 layers (lakes, campsites, trails, boat launches…) all **CC-BY 4.0**.
    The zec boundary layer `Public_zec` (63 polygons — the bboxes below) is
    public but its licence field is blank. Only each territory's _centre_
    (a fact, rounded to 4 decimals) is used in `zecs.json`.

## Recommendation (for the owner's pitch to Réseau Zec)

1. Ask Réseau Zec for permission to **link the cartothèque GeoPDFs** directly
   (made public), or to link the zecs' own PDFs. The five whole-territory
   GeoPDFs below are ready to become catalog items the day they say yes.
2. Ask what the licence of the `Public_zec` boundary layer is (would let the
   cards draw the real territory outline instead of a pin).
3. Until then, the link-out collection sends users to each zec's site, which
   links the free Avenza map.

### Ready-to-link GeoPDFs (whole territory, verified georeferenced)

All answer `206 application/pdf` to range requests. Bbox = the GeoPDF's map
frame. The `gestionnaire/<n>/<n>/<n>_documents_<n>.pdf` paths are CMS-generated
and will change when a zec replaces its file — re-verify before adding.

| Zec               | URL                                                                                                                 | Bytes      | Bbox [W,S,E,N]                     | Notes                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------- | ------------------------------------------------------ |
| Bas-Saint-Laurent | https://zecbasstlaurent.reseauzec.com/wp-content/uploads/gestionnaire/43/1695/9_documents_0.pdf                     | 4,836,602  | [-68.510, 47.935, -67.473, 48.428] | MTM 6                                                  |
| Mitchinamecus     | https://zecmitchinamecus.reseauzec.com/wp-content/uploads/gestionnaire/34/2257/0_documents_0.pdf                    | 2,589,410  | [-75.539, 46.917, -74.873, 47.485] | UTM 18N                                                |
| Chapais           | https://zecchapais.reseauzec.com/wp-content/uploads/gestionnaire/59/1238/9_documents_0.pdf                          | 4,932,221  | [-70.040, 47.047, -69.439, 47.440] | Orthophoto edition, MTM 7                              |
| Batiscan-Neilson  | https://zecbatiscanneilson.reseauzec.com/wp-content/uploads/gestionnaire/60/74/12_documents_0.pdf                   | 4,898,991  | [-72.165, 46.766, -71.555, 47.490] | Big-game observation zones, UTM 19N                    |
| Rivière-Blanche   | SharePoint share link (cartothèque 2022 edition), `…/:b:/s/Site-Web/EcpJWSf3CcBFvodRWPpuoiQBIg-K-ebVuVRmpYyDC6U0Lw` | 39,913,687 | [-72.296, 47.152, -71.822, 47.597] | Needs the share-link cookie; 2022; Web Mercator; large |

Several of these carry `/LPTS` — mind the LPTS point-order trap in the PDF
overlay pipeline when testing them.

## Per-zec table

`G/` = `https://<site>/wp-content/uploads/gestionnaire/`. Sites are
`<sub>.reseauzec.com`. "Avenza" = the free, georeferenced Zecs Québec 2025
territory map in Avenza Maps (in-app only). "Cartothèque" = the official
GeoPDF on SharePoint, denied to anonymous visitors for **every** zec (not
repeated per row). Licence for every row: **unclear — © Réseau Zec, tous
droits réservés → needs permission**. Bbox from Réseau Zec's `Public_zec`
layer.

| Zec                  | Region                | Site (sub)            | Map URL (own hosting)                                                                                                                           | Format         | Georef?                          | Licence          | Notes / bbox [W,S,E,N]                                               |
| -------------------- | --------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------- | ---------------- | -------------------------------------------------------------------- |
| Capitachouane        | Abitibi-Témiscamingue | zeccapitachouane      | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-76.845,47.511,-76.304,47.903]                                      |
| Dumoine              | Abitibi-Témiscamingue | zecdumoine            | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-78.327,46.215,-77.742,46.746]                                      |
| Festubert            | Abitibi-Témiscamingue | zecfestubert          | G/17/3834/8_documents_0.png; G/17/3834/11_documents_0.pdf "27 secteurs" (3.9 MB)                                                                | PNG + PDF      | no (print-to-PDF)                | needs permission | [-76.477,47.655,-75.679,48.036]                                      |
| Kipawa               | Abitibi-Témiscamingue | zeckipawa             | G/29/310/13_documents_0..3.pdf (canoe circuits); G/29/2078/6_documents_0..4.pdf (bathymetry)                                                    | PDF            | no                               | needs permission | [-79.0,46.841,-77.902,47.375]                                        |
| Maganasipi           | Abitibi-Témiscamingue | zecmaganasipi         | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-78.853,46.261,-78.092,46.566]                                      |
| Restigo              | Abitibi-Témiscamingue | zecrestigo            | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-78.756,46.514,-78.026,46.942]                                      |
| Bas-Saint-Laurent    | Bas-Saint-Laurent     | zecbasstlaurent       | **G/43/1695/9_documents_0.pdf** territory (4.8 MB); G/43/1695/29_documents_0.pdf hunting sectors; 2026 caches map on SharePoint (22 MB, public) | PDF            | **yes** (MTM 6)                  | needs permission | Many JPEG sector sketches. [-68.465,48.0,-67.585,48.327]             |
| Casault              | Bas-Saint-Laurent     | zeccasault            | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-67.247,48.114,-66.811,48.576]                                      |
| Chapais              | Bas-Saint-Laurent     | zecchapais            | **G/59/1238/9_documents_0.pdf** orthophoto (4.9 MB)                                                                                             | PDF            | **yes** (MTM 7)                  | needs permission | Links its Avenza map. [-69.887,47.067,-69.54,47.371]                 |
| Owen                 | Bas-Saint-Laurent     | zecowen               | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-68.666,47.49,-68.383,47.962]                                       |
| Batiscan-Neilson     | Capitale-Nationale    | zecbatiscanneilson    | **G/60/74/12_documents_0.pdf** "Zone d'observation – territoire global" (4.9 MB)                                                                | PDF            | **yes** (UTM 19N)                | needs permission | Whole territory. [-72.15,46.919,-71.559,47.338]                      |
| Buteux-Bas-Saguenay  | Capitale-Nationale    | zecbuteux             | G/52/49/1_documents_0.pdf territory (1.1 MB); G/52/78/3_documents_0.pdf circuit                                                                 | PDF            | no markers (geo likely stripped) | needs permission | [-70.065,47.924,-69.792,48.179]                                      |
| des Martres          | Capitale-Nationale    | zecdesmartres         | G/48/269/17_documents_1.pdf "carte" (3.1 MB); trail maps G/48/78/30, 35, 45                                                                     | PDF            | yes, frame much wider than zec   | needs permission | [-70.78,47.675,-70.322,47.875]                                       |
| Lac-au-Sable         | Capitale-Nationale    | zeclacausable         | G/53/76/2_documents_0.pdf; G/53/78/1_documents_0.pdf                                                                                            | PDF (Excel)    | no                               | needs permission | [-70.398,47.713,-70.095,48.032]                                      |
| Rivière-Blanche      | Capitale-Nationale    | zecriviereblanche     | SharePoint "Zec Rivière-Blanche (2022).pdf" (40 MB, public share)                                                                               | PDF            | **yes** (Web Mercator)           | needs permission | 2022 edition. [-72.257,47.178,-71.861,47.571]                        |
| Jaro                 | Chaudière-Appalaches  | zecjaro               | SharePoint Jaro_JN_Chasse_2022.pdf (124 MB)                                                                                                     | PDF            | yes (youth-hunt sector only)     | needs permission | [-70.443,45.826,-70.253,46.031]                                      |
| Louise-Gosford       | Estrie                | zeclouisegosford      | G/40/78/13_documents_1.pdf, …_2.pdf (trails)                                                                                                    | PDF            | no                               | needs permission | [-70.913,45.229,-70.621,45.514]                                      |
| Saint-Romain         | Estrie                | zecsaintromain        | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-71.141,45.679,-71.038,45.771]                                      |
| Forestville          | Côte-Nord             | zecforestville        | G/6/69/2_documents_0.pdf — broken (HTML)                                                                                                        | Avenza         | Avenza: yes                      | needs permission | [-69.758,48.742,-68.959,49.179]                                      |
| Iberville            | Côte-Nord             | zeciberville          | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-69.734,48.469,-69.279,48.683]                                      |
| Labrieville          | Côte-Nord             | zeclabrieville        | — (links free Avenza map; iFaune hunting maps $9.99–19.99)                                                                                      | Avenza         | Avenza: yes                      | needs permission | [-69.904,49.164,-69.553,49.442]                                      |
| Matimek              | Côte-Nord             | zecmatimek            | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-67.098,50.2,-66.456,50.952]                                        |
| Nordique             | Côte-Nord             | zecnordique           | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-70.086,48.388,-69.581,48.702]                                      |
| Trinité              | Côte-Nord             | zectrinite            | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-67.493,49.393,-67.233,49.709]                                      |
| Varin                | Côte-Nord             | zecvarin              | personal OneDrive "Carte de la Zec Varin.pdf" (6.3 MB)                                                                                          | PDF            | no (print-to-PDF)                | needs permission | [-68.902,49.335,-68.451,49.718]                                      |
| Baillargeon          | Gaspésie              | zecbaillargeon        | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-64.903,48.753,-64.776,48.826]                                      |
| Cap-Chat             | Gaspésie              | zeccapchat            | G/12/69/11_documents_0.pdf river map (1.3 MB)                                                                                                   | PDF            | no markers                       | needs permission | [-66.98,48.818,-66.694,48.982]                                       |
| des Anses            | Gaspésie              | zecdesanses           | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-65.101,48.313,-64.734,48.445]                                      |
| Lesueur              | Laurentides           | zeclesueur            | — (Avenza has a 2026 edition)                                                                                                                   | Avenza only    | Avenza: yes                      | needs permission | [-75.754,47.002,-75.196,47.532]                                      |
| Maison-de-Pierre     | Laurentides           | zecmaisondepierre     | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-75.016,46.588,-74.551,47.044]                                      |
| Mazana               | Laurentides           | zecmazana             | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-74.986,46.997,-74.415,47.234]                                      |
| Mitchinamecus        | Laurentides           | zecmitchinamecus      | **G/34/2257/0_documents_0.pdf** (2.6 MB)                                                                                                        | PDF            | **yes** (UTM 18N)                | needs permission | [-75.504,46.948,-74.878,47.467]                                      |
| Normandie            | Laurentides           | zecnormandie          | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-75.113,47.053,-74.426,47.636]                                      |
| Petawaga             | Laurentides           | zecpetawaga           | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-76.148,46.817,-75.62,47.319]                                       |
| Boullé               | Lanaudière            | zecboulle             | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-74.575,46.872,-74.104,47.182]                                      |
| Collin               | Lanaudière            | zeccollin             | G/64/80/149_documents_0.pdf; camping maps G/64/80/9_documents_0..3                                                                              | PDF (Word)     | no                               | needs permission | [-74.311,46.599,-73.988,46.974]                                      |
| des Nymphes          | Lanaudière            | zecdesnymphes         | G/20/49/5_documents_4.pdf "carte général" (2.0 MB) + 4 sector maps                                                                              | PDF (Canva)    | no                               | needs permission | [-73.766,46.383,-73.431,46.691]                                      |
| Lavigne              | Lanaudière            | zeclavigne            | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-74.112,46.302,-73.702,46.622]                                      |
| Bessonne             | Mauricie              | zecdelabessonne       | SharePoint KML of moose-hunting sectors                                                                                                         | KML + Avenza   | yes (KML)                        | needs permission | [-72.713,47.256,-72.329,47.56]                                       |
| Borgia               | Mauricie              | zecborgia             | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-72.729,47.644,-72.315,48.004]                                      |
| Chapeau-de-Paille    | Mauricie              | zecchapeaudepaille    | G/30/59/1_documents_0.pdf InterZEC map; ~20 forestry-worksite PDFs                                                                              | PDF            | no                               | needs permission | [-73.807,46.828,-73.035,47.274]                                      |
| Frémont              | Mauricie              | zecfremont            | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-73.929,47.413,-73.486,47.732]                                      |
| Gros-Brochet         | Mauricie              | zecgrosbrochet        | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-74.029,47.099,-73.332,47.559]                                      |
| Jeannotte            | Mauricie              | zecjeannotte          | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-72.39,47.28,-72.142,47.525]                                        |
| Kiskissink           | Mauricie              | zeckiskissink         | G/45/1048/78_documents_0.pdf Zoune sector                                                                                                       | PDF            | yes (sector only)                | needs permission | [-72.426,47.66,-71.913,48.004]                                       |
| La Croche            | Mauricie              | zeclacroche           | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-72.937,47.551,-72.728,47.888]                                      |
| Menokéosawin         | Mauricie              | zecmenokeosawin       | G/15/3952/2_documents_1..6.pdf (bathymetry)                                                                                                     | PDF            | unverified                       | needs permission | [-72.573,47.657,-72.278,47.909]                                      |
| Tawachiche           | Mauricie              | zectawachiche         | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-72.624,46.934,-72.355,47.196]                                      |
| Wessonneau           | Mauricie              | zecwessonneau         | G/33/370/7_documents_0.pdf — broken (HTML)                                                                                                      | Avenza         | Avenza: yes                      | needs permission | [-73.476,47.137,-72.922,47.513]                                      |
| Bras-Coupé-Désert    | Outaouais             | zecbrascoupedesert    | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-76.706,46.303,-76.07,46.808]                                       |
| Pontiac              | Outaouais             | zecpontiac            | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-76.891,46.241,-76.259,46.705]                                      |
| Rapides-des-Joachims | Outaouais             | zecrapidesdesjoachims | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-77.859,46.183,-77.422,46.619]                                      |
| St-Patrice           | Outaouais             | zecstpatrice          | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-77.625,46.051,-76.945,46.535]                                      |
| Anse-Saint-Jean      | Saguenay–Lac-St-Jean  | zecansestjean         | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-70.364,48.029,-70.103,48.239]                                      |
| Chauvin              | Saguenay–Lac-St-Jean  | zecchauvin            | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-70.292,48.294,-69.816,48.596]                                      |
| des Passes           | Saguenay–Lac-St-Jean  | zecdespasses          | G/3/80/36_documents_1.pdf, …_2.pdf N/S sectors; Petite Péribonka canoe PDF                                                                      | PDF (from PNG) | no                               | needs permission | [-71.891,48.906,-71.27,49.612]                                       |
| La Lièvre            | Saguenay–Lac-St-Jean  | zeclalievre           | trail leaflet in a SharePoint folder view                                                                                                       | Avenza         | Avenza: yes                      | needs permission | [-72.895,48.069,-72.386,48.569]                                      |
| Lac-Brébeuf          | Saguenay–Lac-St-Jean  | zecdulacbrebeuf       | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-70.743,47.974,-70.426,48.264]                                      |
| Lac-de-la-Boiteuse   | Saguenay–Lac-St-Jean  | zeclacdelaboiteuse    | —                                                                                                                                               | Avenza only    | Avenza: yes                      | needs permission | [-71.368,48.726,-71.133,49.036]                                      |
| Mars-Moulin          | Saguenay–Lac-St-Jean  | zecmarsmoulin         | — (links free Avenza map)                                                                                                                       | Avenza         | Avenza: yes                      | needs permission | [-71.201,47.989,-70.92,48.29]                                        |
| Martin-Valin         | Saguenay–Lac-St-Jean  | zecmartinvalin.com    | https://zecmartinvalin.com/uploads/Carte-Zec-Martin-Valin-web.pdf (0.6 MB); …/Carte-Martin-Valin-Canot-Camping.pdf (4.9 MB)                     | PDF            | no                               | needs permission | Own domain; 406 to scripted requests. [-70.845,48.428,-70.283,48.84] |
| Onatchiway           | Saguenay–Lac-St-Jean  | zeconatchiwayest      | G/5/514/3_documents_0.pdf territory (4.6 MB)                                                                                                    | PDF            | no markers (unverified)          | needs permission | [-71.055,48.775,-70.58,49.349]                                       |
| Rivière-aux-Rats     | Saguenay–Lac-St-Jean  | zecriviereauxrats     | — (links free Avenza map)                                                                                                                       | Avenza         | Avenza: yes                      | needs permission | [-72.51,49.092,-72.048,50.0]                                         |

## Counts

| Measure                                                      | Count                         |
| ------------------------------------------------------------ | ----------------------------- |
| Zecs (all sites up)                                          | 63                            |
| Official GeoPDF exists (cartothèque)                         | 63 — 0 links work anonymously |
| Free georeferenced map in Avenza (in-app only)               | 63                            |
| Host at least one map file on their own site                 | 23                            |
| Whole-territory map on their own site                        | ~12                           |
| Verified georeferenced PDF                                   | 8                             |
| Verified GeoPDF covering the whole territory                 | 5                             |
| Explicit licence permitting redistribution or direct linking | **0**                         |
| Needs permission                                             | **63**                        |

## Method

Web research and HTTP checks only (2026-10-02): `HEAD`, and range requests of
≤ 64 KB to read PDF headers/trailers for georeferencing markers (`/LGIDict`,
`/Measure`, `/GPTS`, `/LPTS`, `GEOGCS`, `PROJCS`, `/VP`). "No markers" is not
proof — they can sit in compressed streams. No file was downloaded in full,
nothing was rehosted, no organisation was contacted.

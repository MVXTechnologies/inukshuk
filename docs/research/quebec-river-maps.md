# Québec river-descent maps — research (2026-10-02)

Owner request: _"I'd like to include all river maps in Québec for river
descending (maps that include rapids and waterfalls). Can you search which
organisation provides that and include it?"_

## Short answer

- **One organisation maps essentially every paddleable river in Québec:
  Canot Kayak Québec (CKQ, formerly the FQCK).**
  - Its _Répertoire et archives des relevés de rivières_ lists **353 rivers**
    (about 44,000 km), with surveys dated 1973–2024.
  - **188** rivers have a free PDF survey ("relevé"), **96** have an ArcGIS
    web map, and CKQ publishes **918 free georeferenced maps in Avenza** (254
    river listings plus 664 section sheets).
  - The maps show rapids with their class (I–VI), falls, portages, put-ins and
    campsites.
  - **None of it is licensed for us.** The terms grant a personal,
    non-commercial licence and forbid any "représentation, diffusion,
    reproduction" without written permission. **Needs permission.**
- **Cartes Plein-air** (cartespleinair.org), a volunteer site, holds **366** river
  and canoe-circuit maps. They are free PDFs, but "All rights reserved", and
  each map belongs to its author. **Needs permission.**
- **COBARIC**, the Chaudière watershed organisation, publishes **7 routes on 6
  rivers as genuine GeoPDFs.** Our own parser places every map page. They are
  "© COBARIC" with no licence. This is the quickest win once COBARIC agrees.
- The rest is small and regional, all "tous droits réservés" or silent. See the
  table.
- **No publisher of river-descent maps uses an open licence** (CC BY, OGL or
  public domain). The catalog requires one (docs/CATALOG-SOURCES.md), and it
  treats non-commercial terms as an exclude (the Brazil DHN precedent).
  - So category (a), "include now", is **empty**.
  - What ships in this PR is the permission-gated source, ready to publish the
    day a publisher says yes. The 6 COBARIC GeoPDFs are already curated in it.
- **Open data does have the hazards themselves.**
  - The Québec government's GRHQ (CC BY 4.0) maps falls, rapids and dams.
  - OpenStreetMap has 32,290 rapids and 1,581 waterfalls in Québec.
  - We can draw both ourselves as an overlay. That is category (c): it shows
    where the hazards are, not their class.

## Sources

Checked on 2026-10-02 by web search, page fetches and `curl -I`. No
organisation was contacted. "Georef." means the file itself carries a
GeoPDF/OGC georeference.

- **Measured georeferencing:** our `parseGeoPdf` placed every map page of the
  COBARIC Victoria and Chaudière fiches.
- **Measured not georeferenced:** the CKQ Godbout relevé is a Xerox scan, and
  the Cartes Plein-air 2025 Basse-Malbaie map is a LibreOffice export.

| Organisation                                                                                                                                  | Coverage                                                                                                                                                          | Format                                                                                  | Georef.                                                      | Price                     | Licence / terms                                                                                                                                                                                                                                                                                    | URL                                                                                                                                                                                                                  | Quality, date                                                                                                                                                                                      | Verdict                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Canot Kayak Québec**: river survey directory                                                                                                | **353 rivers**, ~44,000 km. 188 have a PDF relevé; 96 an ArcGIS map                                                                                               | PDF (scanned annotated topo), ArcGIS web maps                                           | No (PDFs are scans)                                          | Free                      | "© Canot kayak Québec 2025. Tous droits réservés." The terms of use (2025-08-11) grant a "licence limitée … personnelle et non commerciale" and say "Toute représentation, diffusion, reproduction … sans l'autorisation préalable, expresse et écrite du partenariat, est strictement interdite." | [répertoire](https://canot-kayak.qc.ca/repertoire-et-archives-des-releves-de-rivieres/), [terms](https://canot-kayak.qc.ca/wp-content/uploads/2025/08/Conditions_d_utilisation_carte_interactive_ckq_20250811-1.pdf) | Latest survey per river spans 1973–2024 (117 in the 2020s, 95 in the 2000s). Sources mix field surveys, the 2005 guide, FQCK archives and blogs. CKQ itself flags "recension" data as unvalidated. | **(b)**                                                                                      |
| **Canot Kayak Québec**: Avenza store                                                                                                          | **918 listings**: 254 rivers and 664 section sheets                                                                                                               | Georeferenced PDF, inside Avenza only                                                   | Yes                                                          | Free ($0.00)              | Avenza in-app licence; no downloadable file                                                                                                                                                                                                                                                        | [store](https://store.avenza.com/collections/canot-kayak-quebec)                                                                                                                                                     | Published 2023 (650), 2025 (249), 2026 (19). Same content as the relevés, georeferenced.                                                                                                           | **(b)**, same ask                                                                            |
| **La Route bleue** (a CKQ programme)                                                                                                          | Certified paddling routes across Québec                                                                                                                           | ArcGIS Experience web map                                                               | n/a                                                          | Free                      | "© La route bleue – Tous droits réservés"                                                                                                                                                                                                                                                          | [laroutebleue.ca](https://laroutebleue.ca/carte-interactive-des-parcours/)                                                                                                                                           | Certified and signposted routes, mostly flat water and the St. Lawrence                                                                                                                            | **(b)**, same ask                                                                            |
| **Eau Vive Québec**                                                                                                                           | Whitewater sections; co-owner of CKQ's interactive maps                                                                                                           | Web                                                                                     | n/a                                                          | Free                      | Bound by the CKQ terms above (named as a partner)                                                                                                                                                                                                                                                  | via CKQ                                                                                                                                                                                                              | —                                                                                                                                                                                                  | **(b)**, cc'd on the CKQ ask                                                                 |
| **Cartes Plein-air** (volunteers: C. Leduc, P. Dionne, N. Boisclair)                                                                          | **366 maps**: river runs, canoe-camping circuits, Nunavik expeditions; many authors                                                                               | PDF on S3 (`assets.cartespleinair.org`)                                                 | No (2025 sample)                                             | Free                      | "© 2026 Cartes Plein-air. All rights reserved." Each map credits its author.                                                                                                                                                                                                                       | [cartespleinair.org/cartes](https://cartespleinair.org/cartes)                                                                                                                                                       | 1989–2026, field surveys by named paddlers, very detailed. Also a river-flow page.                                                                                                                 | **(b)**                                                                                      |
| **COBARIC** (Chaudière watershed organisation)                                                                                                | **7 routes, 6 rivers**: Chaudière (Breakeyville), Prévost-Gilbert, Arnold (haute and basse), aux Araignées, Clinton, Victoria                                     | One technical fiche per river: a multi-page **GeoPDF**, 1.3–4.8 MB, plus per-sheet PDFs | **Yes** (NAD83 Québec Lambert; our parser places every page) | Free                      | "© Copyright - COBARIC, 2024". No reuse clause.                                                                                                                                                                                                                                                    | [parcours](https://cobaric.qc.ca/projets/en-cours/parcours-canotables/)                                                                                                                                              | 2020–2021 editions. Rapids, obstacles, access, parking and difficulty level. Designed for offline use (Avenza guide).                                                                              | **(b)**, quick win; curated already                                                          |
| **Sépaq** (parcs nationaux, réserves fauniques)                                                                                               | Canoe-camping and river routes in the parks: Jacques-Cartier, La Vérendrye, Mastigouche and others                                                                | PDF fiches on sepaq.com; Avenza                                                         | Avenza only                                                  | Free                      | Copyright; sepaq.com refuses scripts (403 + CAPTCHA)                                                                                                                                                                                                                                               | [sepaq.com](https://www.sepaq.com/)                                                                                                                                                                                  | Official                                                                                                                                                                                           | Already a **link-out** collection; the partnership draft exists (docs/CATALOG-SOURCES.md §6) |
| **Parks Canada**: La Mauricie                                                                                                                 | 4 canoe-camping sectors (lakes and portages, not river descents)                                                                                                  | PDF                                                                                     | No                                                           | Free                      | Non-commercial reproduction permitted ("you may reproduce the materials … for non-commercial purposes"). [parks.canada.ca/termes-terms](https://parks.canada.ca/termes-terms)                                                                                                                      | [maps](https://parcs.canada.ca/pn-np/qc/mauricie/activ/camping/canot-camping-canoe/guide/cartes-secteurs-maps-sectors)                                                                                               | 2026 edition                                                                                                                                                                                       | Out of scope (lakes); and NC fails the catalog licence test                                  |
| **Nunavik Parks / Kativik Regional Government**                                                                                               | Koroc River (Kuururjuaq)                                                                                                                                          | Safety-protocol PDF; the route map itself is not public                                 | —                                                            | Free                      | "© Administration régionale Kativik"                                                                                                                                                                                                                                                               | [nunavikparks.ca](https://nunavikparks.ca/assets/documents/Koroc-Safety-Protocol.pdf)                                                                                                                                | 2013                                                                                                                                                                                               | Not usable                                                                                   |
| **Accès Plein Air / Tourisme Abitibi-Témiscamingue**                                                                                          | At least 6 "carte-guides": Outaouais supérieur, Harricana, Gens-de-Terre, Grand Lac Victoria, Cabonga, Decelles                                                   | PDF (9.5 MB example)                                                                    | Not checked                                                  | Free                      | "Tous droits réservés 2026, Tourisme Abitibi-Témiscamingue"                                                                                                                                                                                                                                        | [example](https://accespleinair.org/medias/Parcours/Canot_kayak/Rouyn-Noranda/Outaouais/cg_outaouais.pdf)                                                                                                            | 2010 edition                                                                                                                                                                                       | (b), lower priority                                                                          |
| **CAPSA** (rivière Sainte-Anne, Portneuf)                                                                                                     | One interpretive stretch                                                                                                                                          | PDF panel                                                                               | No                                                           | Free                      | "2021 La CAPSA. Tous droits réservés."                                                                                                                                                                                                                                                             | [capsa-org.com](https://www.capsa-org.com/territoire/acces-et-recreatif)                                                                                                                                             | Not a descent map                                                                                                                                                                                  | No                                                                                           |
| **OBAKIR** (rivière Kamouraska)                                                                                                               | 1 river, illustrated (children's book)                                                                                                                            | PDF                                                                                     | Not checked                                                  | Free                      | "© 2026 OBAKIR. Tous droits réservés"                                                                                                                                                                                                                                                              | [cartes](https://www.obakir.qc.ca/wp-content/uploads/2022/05/cartes-1-a%CC%80-6.pdf)                                                                                                                                 | 2022; no rapid classes                                                                                                                                                                             | No                                                                                           |
| **Ville de Lévis** (rivière Beaurivage)                                                                                                       | 1 route, 14 km                                                                                                                                                    | PDF said to exist; URL not extracted (JS page)                                          | Unverified                                                   | Free                      | "© 2026, Ville de Lévis. Tous droits réservés."                                                                                                                                                                                                                                                    | [page](https://www.ville.levis.qc.ca/loisirs/installations-sportives/riviere-beaurivage/)                                                                                                                            | —                                                                                                                                                                                                  | (b) if ever                                                                                  |
| **GAM** (rivière Montmorency whitewater)                                                                                                      | 6 sections described                                                                                                                                              | Web map only                                                                            | n/a                                                          | Free                      | "© GAM 2018 - 2026"                                                                                                                                                                                                                                                                                | [legam.qc.ca](https://www.legam.qc.ca/index.php/la-montmorency/les-sections-d-eau-vive)                                                                                                                              | —                                                                                                                                                                                                  | No file to link                                                                              |
| Other watershed organisations and parks: CARA, CGRMP (Matapédia/Patapédia), GPAT, COBAMIL, OBV Capitale, ABRINORD, OBV Charlevoix-Montmorency | —                                                                                                                                                                 | No standalone descent PDF found; most link to CKQ/Avenza                                | —                                                            | —                         | —                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                    | —                                                                                                                                                                                                  | —                                                                                            |
| **Hydro-Québec**                                                                                                                              | —                                                                                                                                                                 | Safety pages about dams only; no paddler maps                                           | —                                                            | —                         | —                                                                                                                                                                                                                                                                                                  | [safety](https://www.hydroquebec.com/safety/hydropower-facilities/safety-measures.html)                                                                                                                              | —                                                                                                                                                                                                  | Nothing to link; dams are in GRHQ                                                            |
| **American Whitewater**, **quebecwhitewater.com**, **Rivermap**                                                                               | AW describes a few dozen Québec runs                                                                                                                              | Web pages and web maps                                                                  | —                                                            | Free                      | Site terms                                                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                    | Community descriptions                                                                                                                                                                             | No downloadable maps                                                                         |
| **FQCK _Guide des parcours canotables du Québec_** (ISBN 978-2-89000-658-4)                                                                   | ~200 route fiches, all of Québec                                                                                                                                  | Print book (Broquet)                                                                    | —                                                            | ~$50, listed out of print | Commercial                                                                                                                                                                                                                                                                                         | [listing](https://www.leslibraires.ca/livres/guide-des-parcours-canotables-du-quebec-federation-quebecoise-du-canot-9782890006584.html)                                                                              | 2005; the basis of many CKQ relevés                                                                                                                                                                | No                                                                                           |
| CEHQ / CDRSM _Guide du plaisancier_, Saint-Maurice                                                                                            | Grand-Mère to La Tuque                                                                                                                                            | PDF                                                                                     | —                                                            | Free                      | Not checked                                                                                                                                                                                                                                                                                        | —                                                                                                                                                                                                                    | Motorboat channel guide                                                                                                                                                                            | Out of scope                                                                                 |
| **GRHQ** (MRNF + MELCCFP, Données Québec)                                                                                                     | All of Québec: `chute`, `rapide`, `barrage`, `écueil` as points, lines and polygons                                                                               | FGDB/SHP per watershed unit; WMS                                                        | —                                                            | Free                      | **CC BY 4.0**                                                                                                                                                                                                                                                                                      | [dataset](https://www.donneesquebec.ca/recherche/dataset/grhq)                                                                                                                                                       | BDTQ 1:20 000 in the south, CanVec 1:50 000 in the north. Updated 2026-09-23.                                                                                                                      | **(c)**                                                                                      |
| **CanVec** hydro features (NRCan)                                                                                                             | All of Canada: waterfalls, rapids                                                                                                                                 | Vector                                                                                  | —                                                            | Free                      | **OGL-Canada 2.0**                                                                                                                                                                                                                                                                                 | open.canada.ca                                                                                                                                                                                                       | 1:50 000                                                                                                                                                                                           | **(c)** fallback                                                                             |
| **OpenStreetMap**                                                                                                                             | Québec: `waterway=rapids` 32,290, `waterway=waterfall` 1,581, `portage=yes` 146, `route=canoe` 45 relations, `whitewater:section_grade` 17 (Overpass, 2026-10-02) | Vector                                                                                  | —                                                            | Free                      | **ODbL 1.0**                                                                                                                                                                                                                                                                                       | —                                                                                                                                                                                                                    | Mostly CanVec imports; grades almost absent                                                                                                                                                        | **(c)**                                                                                      |
| Données Québec put-in layers (Repentigny, Shawinigan "rampes de mise à l'eau")                                                                | Two cities                                                                                                                                                        | GeoJSON/SHP                                                                             | —                                                            | Free                      | CC BY 4.0                                                                                                                                                                                                                                                                                          | [Repentigny](https://www.donneesquebec.ca/recherche/dataset/rampe-mise-a-l-eau)                                                                                                                                      | Local                                                                                                                                                                                              | (c), optional                                                                                |

## Recommendation

### (a) Include now: nothing qualifies, and the pipeline is ready

The catalog's licence test asks whether the licence lets a third-party app link
the file, and lets the user download it and keep it offline. No river-descent
publisher passes it.

- The only explicit reproduction grant found is the Government of Canada's,
  and it is non-commercial. The catalog already excludes NC sources: the paid
  sync on the roadmap would breach them.
- It covers lake canoe-camping in La Mauricie, not river descents, anyway.

**A no-permission alternative, not built here:** a link-out collection, the
Sépaq pattern (docs/CATALOG-SOURCES.md §6). It would list places in Explore and
open the publisher's own web page, never a file.

- It fits COBARIC (6 rivers, one page) and Cartes Plein-air (a page per map).
- It fits CKQ poorly: the répertoire is one page with no per-river link.
- Adding it would touch the collections files that the ZEC branch is also
  changing, so it is left for the owner to decide.

**What this PR adds instead** is a permission-gated catalog source, so that a
"yes" turns into published maps in one edit:

- `scripts/catalog/sources/quebec-rivers.json`: the curated list.
  - It holds 3 publishers (COBARIC, CKQ, Cartes Plein-air), each with
    `permission.status: "pending"` and the quoted terms.
  - It holds 6 COBARIC GeoPDF fiches. Each has its URL and a bbox read from the
    file's own `/GPTS`, excluding the regional locator page.
- `src/core/catalog/riverMaps.ts` with tests (100% coverage).
  - It validates the list: a slug, a publisher, an https URL, and a bbox inside
    Québec no more than 3° across.
  - A publisher must record its permission state and evidence.
  - Only `granted` publishers' maps are emitted.
  - Rows are category `river`, kind `trail`, activity `paddling`, region
    `CA-QC`, with a bbox. So they appear under Paddling, in "near you" and on
    the map browse.
- `scripts/catalog/fetch-quebec-rivers.ts`.
  - It HEADs each publishable URL for its size and date, never downloading.
  - It drops any URL that does not answer 200 with a PDF.
  - It writes `fragments/quebec-rivers.json` for `build-manifest.ts`.
  - With nothing granted it writes no fragment, so the published catalog is
    unchanged. The shards were therefore **not** regenerated in this PR.

**Day permission arrives:**

1. Set the publisher's `permission` to `granted`, quoting the email.
2. Set `licence` to what they allow, e.g. "Used with permission (2026-10-…)".
3. Run `npx tsx scripts/catalog/fetch-quebec-rivers.ts`, then
   `npx tsx scripts/catalog/build-manifest.ts`.

The granted path was dry-run on 2026-10-02 with COBARIC temporarily set to
granted:

- **Fragment:** 1 source and 6 items with real sizes (1.26–4.81 MB) and dates,
  then reverted.
- **Note:** a full `build-manifest.ts` run needs the gitignored US Topo and
  FSTopo fragments and the terrain cache. Plan for about 1 GB of DEM transfer
  and about 18,000 USFS requests on a fresh machine.

For CKQ, a curated list is the wrong tool for 350 rivers. With permission, ask
CKQ for a data export or an agreed feed. Their répertoire page already embeds
each river's coordinates and section lines, which would give exact bboxes.
Building a feed from that embedded data before they agree would break their
terms, which forbid any "exploitation partielle ou totale des contenus" without
written permission. So we only counted from it, once, and stored nothing.

### (b) Needs permission: three asks, in priority order

1. **Canot Kayak Québec**, with Eau Vive Québec, co-owner of the interactive
   maps. This is the whole province. The best outcome is the Avenza GeoPDFs as
   direct downloads. The fallback is the scanned relevés, which users would
   place by hand.
2. **COBARIC.** Six GeoPDFs are curated and ready, and the organisation is
   small and local, so this is likely a fast yes. It would prove the flow end to
   end.
3. **Cartes Plein-air.** 366 maps; the site has to agree per author.

Optional later: Tourisme Abitibi-Témiscamingue (Accès Plein Air carte-guides),
and Sépaq (its partnership proposal already exists and is kept out of the repo).

Ask for permission **not limited to non-commercial use.** The app is free
today, but the catalog policy excludes NC because of the paid sync on the
roadmap.

**Nothing has been sent.** Send from marc-andre.vigneault@mvxtechnologies.com.

#### Email 1 — Canot Kayak Québec (cc Eau Vive Québec)

**Objet : Inukshuk — demande d'autorisation pour lier vos cartes de rivières**

Bonjour,

Je m'appelle Marc-André Vigneault et je développe Inukshuk, une application
québécoise gratuite de navigation hors ligne pour le plein air (iOS et Android).
Elle affiche des cartes PDF géoréférencées par-dessus un fond OpenStreetMap et
enregistre les traces GPS.

Votre répertoire des relevés de rivières est la référence pour la descente de
rivières au Québec : plus de 350 rivières, 188 relevés PDF et des centaines de
cartes gratuites dans Avenza. Nos utilisateurs aimeraient trouver ces cartes
près d'eux dans l'application.

Vos conditions d'utilisation (11 août 2025) interdisent toute diffusion sans
autorisation écrite. Nous n'avons donc rien publié, et nous aimerions votre
accord pour l'une des options suivantes, à votre choix :

1. **Lien direct vers vos fichiers.** Notre catalogue listerait chaque carte
   avec son nom, sa région et son emprise. Le téléchargement se ferait
   directement depuis votre site : nous n'hébergeons ni ne modifions aucun
   fichier. « Canot Kayak Québec » et un lien vers votre site apparaîtraient sur
   chaque carte.
2. **Versions géoréférencées.** Vos cartes Avenza sont déjà géoréférencées. Si
   les mêmes PDF étaient téléchargeables depuis votre site, la position GPS du
   pagayeur s'afficherait directement sur votre carte, hors ligne.
3. **Un partenariat plus large.** Par exemple : mettre en valeur la Route bleue
   et votre classification des rapides dans l'application, ou vous transmettre
   les corrections signalées par les pagayeurs.

L'application est gratuite aujourd'hui. Certaines fonctions futures, comme la
synchronisation entre appareils, pourraient devenir payantes. Nous préférerions
donc une autorisation qui ne soit pas limitée à un usage non commercial. Nous
respecterons toute condition d'attribution ou de mise à jour que vous fixerez,
et nous retirerons les liens dans les 24 heures sur simple demande.

Auriez-vous un moment pour un court appel ?

Merci pour votre travail auprès des pagayeurs,

Marc-André Vigneault
MVX Technologies — Inukshuk
marc-andre.vigneault@mvxtechnologies.com
https://inukshuk.mvxtechnologies.com

**Subject: Inukshuk — permission to link your river maps**

Hello,

My name is Marc-André Vigneault and I build Inukshuk, a free offline outdoor
navigation app from Québec, for iOS and Android. It shows georeferenced PDF
maps over an OpenStreetMap base layer and records GPS tracks.

Your river survey directory is the reference for river descents in Québec: more
than 350 rivers, 188 PDF surveys and hundreds of free maps in Avenza. Our users
would like to find those maps near them in the app.

Your terms of use (11 August 2025) forbid distribution without written
permission, so we have published nothing. We would like your agreement to one
of these options, as you prefer:

1. **Direct links to your files.** Our catalog would list each map with its
   name, region and extent. The download would come straight from your site: we
   never host or modify a file. Each map would show "Canot Kayak Québec" and a
   link to your site.
2. **Georeferenced versions.** Your Avenza maps are already georeferenced. If
   the same PDFs could be downloaded from your site, the paddler's GPS position
   would appear right on your map, offline.
3. **A broader partnership.** For example: featuring La Route bleue and your
   rapid classification in the app, or forwarding corrections that paddlers
   report.

The app is free today. Some future features, such as sync between devices, may
become paid, so we would prefer permission that is not limited to
non-commercial use. We will follow any attribution or update terms you set,
and we will remove the links within 24 hours on request.

Would you have time for a short call?

Thank you for your work for paddlers,

Marc-André Vigneault
MVX Technologies — Inukshuk
marc-andre.vigneault@mvxtechnologies.com
https://inukshuk.mvxtechnologies.com

#### Email 2 — COBARIC

**Objet : Inukshuk — lier vos fiches de parcours canotables**

Bonjour,

Je m'appelle Marc-André Vigneault et je développe Inukshuk, une application
québécoise gratuite de navigation hors ligne pour le plein air.

Vos fiches techniques de parcours canotables sont excellentes : Chaudière
(Breakeyville), Prévost-Gilbert, Arnold, aux Araignées, Clinton et Victoria. Ce
sont de vrais PDF géoréférencés, que notre application sait déjà afficher avec
la position GPS du pagayeur, hors ligne.

Le site ne précise pas de licence, alors nous vous demandons la permission
avant tout. Accepteriez-vous que notre catalogue liste ces six fiches (nom,
rivière, emprise), avec un téléchargement fait directement depuis cobaric.qc.ca ?
Nous n'hébergeons ni ne modifions aucun fichier, nous affichons « COBARIC » et
un lien vers votre page sur chaque fiche, et nous retirons les liens sur simple
demande. L'application est gratuite aujourd'hui, mais certaines fonctions
futures pourraient devenir payantes ; nous préférerions donc une autorisation
qui ne soit pas limitée à un usage non commercial.

Merci de rendre ces rivières accessibles,

Marc-André Vigneault
MVX Technologies — Inukshuk
marc-andre.vigneault@mvxtechnologies.com

**Subject: Inukshuk — linking your canoe-route fiches**

Hello,

My name is Marc-André Vigneault and I build Inukshuk, a free offline outdoor
navigation app from Québec.

Your canoe-route fiches are excellent: Chaudière (Breakeyville),
Prévost-Gilbert, Arnold, aux Araignées, Clinton and Victoria. They are true
georeferenced PDFs, which our app can already show with the paddler's GPS
position, offline.

The site does not state a licence, so we are asking first. Would you agree to
our catalog listing these six fiches (name, river, extent), with the download
coming straight from cobaric.qc.ca? We never host or modify a file, we show
"COBARIC" and a link to your page on each fiche, and we remove the links on
request. The app is free today, but some future features may become paid, so
we would prefer permission that is not limited to non-commercial use.

Thank you for opening these rivers to paddlers,

Marc-André Vigneault
MVX Technologies — Inukshuk
marc-andre.vigneault@mvxtechnologies.com

#### Email 3 — Cartes Plein-air

**Objet : Inukshuk — pourrions-nous lier les cartes de Cartes Plein-air ?**

Bonjour,

Je m'appelle Marc-André Vigneault et je développe Inukshuk, une application
québécoise gratuite de navigation hors ligne pour le plein air.

Votre collection de plus de 360 cartes de rivières et de circuits de canot,
entièrement bénévole, est remarquable. Le site indique « Tous droits réservés »
et chaque carte appartient à son auteur, alors nous n'avons rien publié.

Accepteriez-vous que notre catalogue liste vos cartes (titre, auteur, année,
emprise), avec un téléchargement fait directement depuis cartespleinair.org ?
Nous n'hébergeons aucun fichier, nous affichons l'auteur et un lien vers votre
site sur chaque carte, et nous retirons tout lien sur simple demande. Si
certains auteurs préfèrent ne pas être listés, nous respecterons leur choix
carte par carte. L'application est gratuite aujourd'hui, mais certaines
fonctions futures pourraient devenir payantes ; nous préférerions donc une
autorisation qui ne soit pas limitée à un usage non commercial.

Merci pour ce travail bénévole,

Marc-André Vigneault
MVX Technologies — Inukshuk
marc-andre.vigneault@mvxtechnologies.com

**Subject: Inukshuk — could we link to the Cartes Plein-air maps?**

Hello,

My name is Marc-André Vigneault and I build Inukshuk, a free offline outdoor
navigation app from Québec.

Your collection of more than 360 river and canoe-circuit maps, built entirely
by volunteers, is remarkable. The site says "All rights reserved" and each map
belongs to its author, so we have published nothing.

Would you agree to our catalog listing your maps (title, author, year, extent),
with the download coming straight from cartespleinair.org? We host no files, we
show the author and a link to your site on every map, and we remove any link on
request. If some authors prefer not to be listed, we will respect that map by
map. The app is free today, but some future features may become paid, so we
would prefer permission that is not limited to non-commercial use.

Thank you for this volunteer work,

Marc-André Vigneault
MVX Technologies — Inukshuk
marc-andre.vigneault@mvxtechnologies.com

### (c) Build it ourselves: a "Rapids & falls" overlay from open data

Open data does not hold rapid _classes_ (I–VI); those come only from the
surveys above. What it does hold is **where** the rapids, falls and dams are.
That is the safety-critical half of a descent map, and we can draw it over the
basemap and over any PDF.

**Inputs**

- **GRHQ** (CC BY 4.0) is the primary source.
  - Thematic classes `C_hyd_P`, `C_hyd_L` and `C_hyd_S` carry `chute`,
    `rapide`, `barrage` and `écueil`, as points, lines and polygons.
  - It is published as an FGDB per watershed unit (UDH) and as a province-wide
    WMS.
- **CanVec** (OGL-Canada 2.0) is the fallback outside Québec.
- **OSM** (ODbL) adds names and the rare `whitewater:*` grades.

**Steps**

1. **Build, on the NAS, monthly, next to the vector basemap.**
   - Download GRHQ.
   - Extract `chute`, `rapide` and `barrage` with their name and source scale,
     and reproject to WGS84.
   - Optionally merge OSM `waterway=rapids|waterfall`, deduplicated within
     about 50 m.
   - Tile with tippecanoe into one small `qc-hydro-hazards.pmtiles`
     (estimated at a few MB).
   - If OSM is merged, the layer becomes an ODbL produced work. Attribute it
     and offer it under the ODbL.
2. **Host** it on the same Cloudflare R2 bucket and Worker as the basemap
   pieces: a range-served PMTiles file.
3. **App.**
   - Add an optional layer in Live layers, "Rapids & falls (QC)".
   - Style it with a falls glyph, a hatched line for rapids and a red bar for
     dams, labelled from `name`.
   - Draw it above PDF overlays too, so a scanned CKQ relevé placed by hand
     still shows the hazards.
   - Include it in offline-region downloads.
4. **Attribution.**
   - "Contient de l'information sous licence CC BY 4.0 — Gouvernement du Québec
     (GRHQ)".
   - "Contains information licensed under the Open Government Licence – Canada"
     (CanVec).
   - "© OpenStreetMap contributors" (if merged).
5. **Safety copy.** Say plainly that the layer shows where rapids and falls are
   mapped, not how hard they are. Northern positions are 1:50 000 and can be off
   by hundreds of metres. The layer does not replace scouting.

**Effort:** about 2–3 days for the build and tiles, and about 2 days for the
app layer and its toggle, then device QA in light and dark themes. No
permission is needed.

**Check first:** whether Protomaps v4 already carries waterfalls. Its `pois`
layer documentation lists no waterfall or rapids kind, so assume not.

## Method notes

- **CKQ counts** come from the répertoire page's embedded data (353 rivers),
  read once to size the source. Nothing from it is stored in the repo.
- **Avenza counts** come from the store's public product listing (918, all
  $0.00).
- **Cartes Plein-air** count: map links on `/cartes`.
- **COBARIC bboxes:** the fiches' own `/GPTS` arrays, cross-checked with
  `parseGeoPdf` + `primaryGeoreferenceForPage`.
- **OSM counts:** one Overpass `out count` query over the CA-QC area.
- **Total downloads:** about 30 MB, all deleted afterwards. No account was
  created and no form was submitted.

# Map store filters — design mockup (issue #250)

> _"The current filters don't do anything. There should be category/type,
> country/type, activity type — good filtering, and very, very pretty so you
> want to use it."_ — owner, 2026-09-08

This is the **mockup**, not the app. It lives in the playground so the shape can
be argued over from screenshots before any React Native is written (the standing
pre-ship rule). Open it at:

```
http://localhost:5175/?view=store            # or ?screen=store
http://localhost:5175/?view=store&sheet=1    # …with the filter sheet up
http://localhost:5175/?view=store&sheet=1&near=500&country=CA
http://localhost:5175/?view=store&sheet=1&w=wide&near=2500
```

Every facet is in the URL and is written back as you tap, so any screenshot in
this document is a link (see **URL state** below).

---

## What the data actually is

Measured over `docs/catalog/v2` (the documents the phone fetches), build
`2026-09-02`:

| facet                   | reality today                                                            |
| ----------------------- | ------------------------------------------------------------------------ |
| **items**               | **67 983**                                                               |
| `category`              | **1 value** — `topo`, 100 %                                              |
| `sourceId`              | 3 — USGS US Topo 65 240 · NRCan CanTopo 2 234 · Geoscience Australia 509 |
| country (from `region`) | US 65 240 · AU 509 · **CA 2 234 with no `region` at all**                |
| `lang`                  | `en` 65 749 · `bilingual` 2 234 (no `fr`)                                |
| scale                   | not a field — a per-source constant (24k / 50k / 250k)                   |
| activity / tags         | no field                                                                 |
| download size           | median 35.1 MB (USGS) · 2.5 MB (CanTopo) · 10.5 MB (AUSTopo)             |
| regions                 | 54 published (US + AU) + 13 Canadian **derived here** (see below)        |

Two facts drove every decision on this screen:

1. **A category grid divides nothing.** 100 % of the catalogue is `topo`. A
   category-first UI is a grid of one live tile and eight dead ones. So category
   is not the entry point — it is the _phase-2 preview_ at the bottom of the
   sheet.
2. **The catalogue is wildly uneven, and empty exactly where the owner lives.**
   There is **nothing within 25 km of Québec City** and only 14 sheets within
   100 km, all of them USGS quads in Maine; the nearest CanTopo sheet is
   226 km away in New Brunswick. Alaska alone has 11 177. A filter that lets you
   tap into an empty list to discover that is the filter we already have — hence
   **a live count on every option, and options with a zero count disabled**.

---

## The facet order, and why

The sheet reads top to bottom in the order the questions are actually asked.

1. **Near me** — a radius (25 / 100 / 500 / 2 500 km / Anywhere) around the
   playground's fixed Québec City origin (`HOME_VIEW`, the same coordinate every
   other capture uses; the playground has no device GPS by design). It leads
   because it is the only facet that turns 67 983 into a handful, and because it
   is the reason someone opens a map store on a phone at all. Above the chips is
   a nine-bar **distance histogram** of the real distribution, which is what
   makes "25 km · 0" legible as _the catalogue is empty here_, not _the app is
   broken_.
2. **Country** — three flag tiles with counts. The coarsest true split, the
   parent of (4), and instantly readable.
3. **Scale** — 1:24 000 / 1:50 000 / 1:250 000, each with the publisher under
   it. This is what a person means by "detailed enough to walk with". It is 1:1
   with the source today and the caption says so ("one per source today"); when
   a second 1:50k source lands the group stops being redundant without the UI
   changing.
4. **Region / province** — the second level under country. 67 of them, so the
   ten biggest _under the current filter_ show and the rest are one tap away.
   Choosing a country scopes the list, which is what keeps Alaska's 11 177 from
   being the first thing a Québec user sees.
5. **Language** — `en` / `bilingual`. Small today, decisive in Québec, and the
   first group that grows when French sources land.
6. **Download size** — Under 10 MB / Under 50 MB / Any. Not in the issue's list;
   added because on a phone, offline, the size **is** the cost of the tap, and
   it is the one facet where CanTopo (2.5 MB median) beats USGS (35 MB) outright.
   Easy to drop if it is not wanted.
7. **Activity + Map type** — visibly **coming soon**, greyed, non-interactive,
   with one line saying what they need. Showing the shape of phase 2 is itself a
   decision worth reviewing; a greyed group says "planned" better than a
   paragraph, and it is honest in a way that a live-looking chip filtering
   nothing is not.

### The three rules that make it usable

- **Counts are live, exact, and per-option.** Within a group the options are
  OR'd; across groups they are AND'd; the number beside an option is what you
  would get **if you tapped it** — it ignores its own group's current selection,
  so options inside a group read as alternatives rather than as a description of
  what is already chosen.
- **Zero-count options are disabled, with the zero showing.** You can see the
  dead end without walking into it.
- **No Apply button.** The footer count and the map footprints update on every
  tap; the sheet stops short of the top of the column so the header count stays
  visible under your thumb. (The Library's "the list is the confirmation" rule,
  kept without the Library's inline layout — see _Differences_ below.)

---

## Where the numbers come from

`web/scripts/build-store-facets.mjs` sweeps **the real catalogue in this repo**
(`docs/catalog/v2/index.json` + all 281 shards, 24 MB, 67 983 items) once and
writes `web/src/store/facets.generated.json` (~215 KB, checked in). Nothing is
fetched from the network, and nothing is invented. Re-run it with:

```bash
cd web && node scripts/build-store-facets.mjs
```

It emits two things:

- **A facet cube** — 207 rows, one per distinct
  `(source, region, language, distance bucket, size bucket)` with its count.
  Every number in the UI is a sum over this cube, so "1 : 50 000 · 40" is the
  true count over all 67 983 items, computed synchronously with no network.
  The bucket edges **are** the radius/size options offered, so the cumulative
  sums are exact rather than interpolated.
- **A 783-sheet sample of real items** for the result list — the 400 nearest
  Québec City plus the six nearest in every region, so no chip combination lands
  on an empty list. The list is a sample; **the counts are not**, and a footnote
  under the list says exactly that. On device this list would be the existing
  `@core/catalog` shard pull.

Distances are point-to-bbox great-circle from the fixed origin, measured once in
the generator.

### The Canadian region gap — the one place data is faked, and it is flagged

`scripts/catalog/fetch-cantopo.ts` emits **no `region` at all**, so all 2 234
CanTopo sheets are region-less in the live catalogue. A region facet with a
2 234-item "?" bucket cannot be judged, so the generator **derives**
`CA-<province>` from each sheet's bbox centroid with a coarse box table plus two
hand-fitted diagonals for the Maritimes (2 208 placed, 26 unplaceable). Every
derived region is marked `derived: true` and the UI badges it **≈**, with a line
in the sheet explaining that this is mockup scaffolding.

**Do not ship the box table.** It cannot be made right: a 1:50k sheet is 0.25°
of longitude — about the width of the Isthmus of Chignecto — so a centroid rule
is guaranteed to misfile the sheets that straddle a border. The real derivation
belongs in the fetcher, against the NTS polygons it already loads.

---

## What the RN build needs (the non-UI half of #250)

1. **`region` on CanTopo** — `scripts/catalog/fetch-cantopo.ts` already loads the
   NTS index polygons (`@core/catalog/ntsIndex`) to resolve each sheet's extent;
   the province should come from the same lookup and be written as
   `region: 'CA-<PROV>'`. Until it does, the country facet is broken for Canada
   and the region facet is guesswork. **This is the blocking data fix.**
2. **`scale` on `CatalogItem`** — a per-source constant today
   (USGS 24 000, CanTopo 50 000, AUSTopo 250 000), so it costs one line per
   fragment writer. Without it the scale chips have to be inferred from
   `sourceId`, which stops working the moment one publisher ships two scales.
3. **Pure facet derivation in `src/core/catalog/`** with the live index as a
   fixture and co-located tests (AGENTS.md): country-from-region,
   scale-from-source, and the per-option counting rule above. The cube
   arithmetic in `web/src/store/facets.ts` is the reference implementation and
   should move there rather than be rewritten.
4. **A count endpoint the phone can afford.** The counts here are free because
   the cube is 207 rows. On device the same trick works — publish the cube in
   `index.json` (a few KB) rather than making the phone pull shards to count.
   That is a generator change, not a client one.
5. **Phase 2**: `tags[]` / `activities[]` on `CatalogItem` plus non-topo sources
   before the Activity and Map-type groups become real.
6. `.maestro/store.yaml` taps "Around you" / Download and must keep passing on
   the fixture catalogue.

---

## Where this deliberately differs from the Library's filter

The two surfaces are the same visual language on purpose (same chips, same
`.panel`/`.micro`/`.num` tokens, same Phone/Wide switch, same "no Apply
button"). Three differences, each a decision to accept or reject:

1. **A sheet, not an inline section.** The Library expands its filter in place
   and says so in `web/README.md`. Six groups and ~90 chips would push the store
   list a screen and a half down. The sheet keeps the facets scrollable in their
   own area while the count, the applied strip and the top of the list stay
   above it — the Library's principle without the Library's layout. In `wide`
   the same component docks as a 320 px left column instead.
2. **A count-first header.** `27 706 maps match · 1 facet` in a 20 px tabular
   number, above the list. The Library never tells you how much of anything you
   are looking at; the store must.
3. **An applied-filters strip.** Removable pills between the count and the list.
   After the sheet closes it is the only thing that explains the number, and
   removing one filter should not require reopening the sheet.

And one addition that is not a filter at all: **the matched sheets are drawn on
the map** as their real bbox footprints (`web/src/map/useStoreLayers.ts`, capped
at 400). It costs ~90 lines, it uses data already in the catalogue, and it is
what turns "40 maps" into "40 maps, and they are all in New Brunswick" — which
is how the Québec coverage hole becomes visible instead of merely counted.

---

## URL state

Added to the playground's existing `?` conventions (`web/src/lib/urlState.ts`):

```
?view=store            the store screen  (?screen=store is accepted too)
?sheet=1               open the filter sheet
?near=25|100|500|2500  radius in km, around the fixed Québec City origin
?country=US,CA,AU      comma list
?region=US-VT,CA-QC    comma list, ISO 3166-2
?scale=24000,50000     comma list of scale denominators
?lang=en,bilingual     comma list
?maxsize=10|50         download ceiling in MB
?q=<text>              search text (matches the sampled rows)
?w=phone|wide          390 px column or 720 px, as in the Library
```

The values are the UI's own units (km, MB, ISO codes) rather than internal
bucket indices, so a capture link survives a regenerated fixture and is legible
in a bug report.

---

## Open questions for the owner

1. **Does "Near me" belong first?** It is the highest-yield facet by far, but on
   a phone the top of a bottom sheet is the _least_ reachable place. Country
   first (three big flag tiles) would put the prettiest group under the thumb and
   push the radius down. The screenshots show it first — say if it should move.
2. **Keep the download-size group?** It is not in the issue's phase-1 list. It
   is real, decision-relevant data and the only facet CanTopo wins, but it is the
   sixth group and the sheet is not short.
3. **How loud should the empty-near-Québec truth be?** Today it shows as
   "25 km · 0" (disabled) plus a flat histogram. The alternative is an explicit
   line — _"no 1:50k coverage of Québec City in the catalogue yet"_ — which is
   more honest but also advertises a gap on the first screen of the store.
4. Secondary: **sheet vs. inline** (difference 1 above), and whether the phase-2
   "coming soon" group should ship at all or wait for `tags[]`.

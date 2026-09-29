# Inukshuk — feature & bug backlog

Owner-maintained wishlist. Claude reads this at the start of a session to pick
up where we left off; items move to ~~struck~~ with the shipping PR when done.
Ordered roughly by priority (top = next).

## In progress

- **System info should show the installed app version (next store build).** "Version" reads
  `Constants.expoConfig.version` — the running bundle's config — so a 1.7.0 install running an
  OTA reads 1.7.0 even after the owner expected 2.0.0 (2026-09-28). Show the binary's version
  and build too (e.g. "2.0.0 (57)"). Needs `expo-application` (native) — ship it with the next
  store build, not over the air (it changes the fingerprint and would cut 2.0.0 off from OTAs).

- **Road navigation mode + real place search (owner request, 2026-09-28).**
  - Want: type any place into "Search places" and find it the way Google does (businesses,
    addresses, trailheads, lakes). Then a **2D turn-by-turn navigation mode**: route line,
    next-maneuver banner ("In 300 m, turn left onto Rue Saint-Jean"), distance and ETA,
    re-routing when off route, and voice later.
  - Today the "Search places" pill only accepts coordinates (revamp phase 1).
  - **Google's place index can't be used as-is.** Google Maps Platform terms forbid showing
    Places/Geocoding results on a non-Google map, and ours is MapLibre with our own tiles. Using
    Google would mean a Google map for that screen (cost, look, and not offline).
  - Options to weigh:
    - **Search:** Photon or Pelias (OSM geocoders), self-hostable on the NAS next to the tiles.
      Or a paid API that allows any map (Mapbox Search, HERE, Stadia/Pelias hosted). Check
      coverage of Québec POIs and French names.
    - **Routing and turn-by-turn:** Valhalla (car, bike, foot profiles, turn-by-turn narrative,
      can run offline on-device from tiles), GraphHopper or OSRM. Self-host on the NAS or a
      small VM behind the Cloudflare Worker. `maplibre-navigation` has the UI patterns.
  - Fits the new vector base map (road classes are already styled). Needs a design pass: a
    driving HUD next to the existing recording panel.
- **UI revamp follow-ups (from the PR 9 store-screenshot pass, 2026-09-27).**
  - ~~**Bug — map maker stuck on "Calculating…" at Mont-Sainte-Anne**~~ FIXED in #423
    (onDidFinishLoadingMap never fired, so `mapLoaded` stayed false).
    (47.0755, −70.9075, iOS 26 sim, Release). Reproducible: Next never
    enables, even after Cancel and reopening on a settled map; the same
    flow works around the Plains of Abraham. The box converts through
    `useOfflineDownload`'s cached flat bounds, and only a region change
    re-reads them, so one failed read with an idle map waits forever.
    Find why the read fails there, and have the overlay's retry re-read
    the bounds rather than only re-convert the cache.
  - Trail inspect panel still draws descent in red (spec forbids red for
    data) and the route in the old red, not route orange.
  - Night: the heat glow and category colours are still orange/green.
  - Trail 3D view renders blank in the iOS simulator (fine on device?).
  - Maps tab "Near you" from Québec City lists New Brunswick CanTopo
    sheets 300+ km away (CanTopo has no Québec City sheet).
  - Refresh the marketing site's `docs/assets/screens/*.webp` and the Play
    store phone/tablet sets from the new UI (needs a local Android build).

- **Weather UX v2 — Windy-style (owner spec, 2026-08-09).** ~~M1~~ SHIPPED
  (PR #195, OTA'd 1.5.0 + 1.4.0, 2026-08-09): thumbnail layer picker, dark
  translucent chrome, floating time scrubber (radar past / forecast to
  horizon), gradient legend pill, temperature layer, muted basemap, two
  Windy-reference polish rounds. Aesthetic bar = Windy (standing gate).
  ~~M2~~ SHIPPED (PR #196, OTA'd 1.5.0 + 1.4.0, 2026-08-09): HRDPS/RDPS/
  GDPS model picker on the scrubber chevron (drape + timeline re-key on
  switch, time-proportional ticks) + Windy-style model comparison table
  with live spread and run age. ~~M3~~ SHIPPED (PR #197, OTA'd
  1.5.0 + 1.4.0, 2026-08-09): GPU wind particles — thin gust-scaled flow
  streaks over the scalar speed gradient (no arrows), self-throttling
  28 fps ladder, kill-switch in Settings → Map. Owner verdict pending on
  real hardware (emulator = software GL). Weather v2 program COMPLETE
  except owner-judged polish + the open multi-model source decision. Multi-model beyond ECCC: NAS-hosted GFS/
  ECMWF/ICON relay recommended as M2.5 — owner has NOT yet chosen relay vs Open-Meteo (~€29/mo).

## In progress — weather/marine/store field-feedback round (owner, 2026-08-09)

~~Wave A~~ SHIPPED (PR #199, OTA'd 2026-08-09). ~~Wave C~~ SHIPPED
(PR #198, OTA'd 2026-08-09).
~~Wave B~~ SHIPPED (PR #200, OTA'd both runtimes 2026-08-10): OpenFreeMap
labels + coastlines above weather/marine drapes (incl. a maplibre-native
TileJSON-url bug found and fixed — tiles resolved in JS at runtime);
worldwide GDPS auto-fallback with honest AUTO caption; radar "Canada
only" hints. Global radar = paid RainViewer, future line item.
Wave D (marine deep, designing): higher-res chart sources, tap-for-depth,
"download free local marine map" prompt on low-res regions (ties into
marine M4 offline packs). Honesty note: navigation-grade CHS charts remain
licensed — "data which would allow navigation" needs the GeoGarage-type
paid route or stays not-for-navigation.
Open: owner to confirm wind particles visible after M3 OTA; marine+weather
simultaneous UX TBD; multi-model source decision still open.

## Shipped overnight 2026-08-09/10 (owner away, autonomous)

All OTA'd to 1.5.0 + 1.4.0:

- **Wind particles FIXED** (PR #202) — 8 root causes; the killer was a
  shader that never compiled, the second an `endFrameEXP` that queues an
  async present our RAF loop never delivered (the debug probe's blocking
  `readPixels` was masking it — the overlay only worked while watched).
  Verified by pixel diff (196k px, 8/8 bands). New permanent gate:
  `npm run wind:motion`.
- **Overlays drill-down** (PR #201) — Topology/Weather/Marine groups with
  in-place sub-menus, Marine a single toggle, "Locally downloaded only"
  moved to Settings → Data settings. Review pass caught invisible labels
  (flex:1 in a non-flex touchable) + an a11y-container defect that also
  affected VoiceOver.
- **Marine ENC chart mode** (PR #203) — client-rendered depth bands,
  contours, spot soundings, chart-tan land (the CHS server's rendering was
  the "awful resolution", not the data); tap-for-depth; unified tap chip
  (coords / weather / depth). Render budget raised 1.5× after visual
  review vs the iBoating reference.

Rig lessons: never share one device between two Maestro sessions; the
drill-down panel is near full-width so flow dismiss taps must go ABOVE it;
a persistent disk guard now purges intermediates under 3 GB free.

- **Marine worldwide + offline packs** (PR #204) — jurisdiction ladder
  CHS→NOAA→EMODnet→GEBCO with the active source named in the legend and
  tap chip; free local packs (~2 MB/cell after fixing a 4× tile-padding
  waste) with the owner's low-res download banner; pack management in
  Settings → Data settings.

Next build wave (no owner input needed): store M2 (regions, USGS/NPS
sources), trim-button move, trail navigation mode (needs a design pass).

## Awaiting owner design review (Checkpoint 1 — mockups published 2026-08-09)

Review page (private artifact) covers, with decisions D-1..D-7: marine
depth client-rendering (palette A/B, contours), the 13 m data ceiling +
GeoGarage quote email, worldwide chart ladder timing, the unified
mode-aware tap inspector (base = coordinates [new], weather = value
[shipped], marine = depth), and the overlays drill-down menu redesign
(Topology/Weather/Marine groups, in-place sub-menus, "Locally downloaded
only" likely moving to Settings). Build agents launch only on the owner's
calls. New process: [[pre-ship-review-checkpoints]] — mockup approval
before build, device screenshots/recordings before merge.

## Queued (owner requests, 2026-08-07)

1. ~~**Bottom-left map chrome must go**~~ — shipped in PR #185 (OTA'd to
   1.5.0 + 1.4.0, 2026-08-08). Logo + attribution (i) removed; the OSM/Esri/
   MapLibre credit line lives in Settings → About → "Maps & data".
2. ~~**Recording card sits lower**~~ — shipped in PR #185 (same OTA); the
   recording UI now sits just above the tab bar in the freed space.
3. ~~**BUG: waypoint button off-screen after expand→collapse**~~ — fixed in
   PR #185 (same OTA); verified with a dedicated expand→collapse Maestro
   flow on both platforms.
4. ~~**Settings grouped into expandable categories**~~ — shipped in PR #187
   (OTA'd to 1.5.0 + 1.4.0, 2026-08-08): App settings / Data settings /
   Third party / System settings / System info, one open at a time. Bonus
   from its E2E gate: a real field bug (ghost paused recording restored
   after a saved hike) was caught and fixed in PR #188, same OTA wave.
5. **Trail navigation mode** — tapping a navigation-category trail offers
   "Start navigating": guidance along the trail, and an off-trail alarm
   (beep/vibrate) that works with the screen off.
6. ~~**Move the trim (scissors) button out of trail focus**~~ — shipped in PR #226 (2026-09-03, OTA'd 1.5.0 + 1.4.0): beside the title, right side; device-verified light + dark.
   Original ask: — it edits the GPX
   (different from map viewing); move it next to the GPX title (right side) or
   to the bottom of the trail view.
7. ~~**Carousel zoom still too far out (verify first)**~~ — verified correct in PR #227 (2026-09-03): the fit is width-limited at 91.9% of the viewport, 32 px of padding headroom total; pinned by `core/geo/cameraFit.test.ts`. If still seen on device after two restarts, the remaining lead is an iOS follow-mode timing race, not the arithmetic.
   Original ask: — multi-trace carousel
   should zoom so all trails fit roughly centred; content under the carousel
   is fine. A border-to-border fit shipped via OTA on 2026-08-07 — re-test
   after two app restarts before more tuning.

## Shipped 2026-09-03 — Tier 1 + Tier 2 pass (all OTA'd to 1.5.0 + 1.4.0)

- **Perf:** saving a recording is ONE index write instead of 1+N (PR #219).
- **Core purity:** `format` moved into `@core` and made pure (units explicit;
  store-bound wrapper in `@state/formatters`); `filterTracks`/`groupByFolder`
  generic; map style constants hoisted to `@core/weather/weatherLook` (PR #220).
- **Library:** rename maps + waypoints (PR #221, also fixed `makeMap` badge
  numbering that rename would have exposed); sort by date/distance/duration/
  D+/pace/name, persisted (PR #225); collapsible accent-insensitive search on
  name/folder/note (PR #228).
- **Dashboard:** y-axis clipping at two-digit totals fixed, same latent clip
  fixed in `ElevationProfile` (PR #222); lifetime totals with per-category
  breakdown (PR #228, closes #99).
- **Map (#97, PR #224):** scale bar (zoom + latitude aware, Settings switch),
  coordinate readout/entry (DD/DDM/DMS, strict parser), drop-a-pin destination
  with live bearing/distance. Routing deliberately left for #95.
- **Web playground** rebased and merged (PR #223); its `@core` workarounds
  deleted.
- **Play listing:** dead contact URL replaced.

**OPEN, HIGH for iOS — needs a decision:** `library.json` persists ABSOLUTE
`file://` URIs (`storage.ts` returns `file.uri`; read paths use them
verbatim; no relativising helper). iOS changes the app-container UUID on
updates, so every trail/map/photo path goes stale after an App Store update —
files intact, index unopenable. Reproduced on the simulator 2026-09-03. Fix =
store Documents-relative paths, resolve on read, migrate on hydrate; OTA-able.
Android container paths are stable; the Android auto-reports are a different
cause. #127 (iOS pack shows 0 KB) is plausibly the same class.

- **[Parked] Navigation like Google Maps** (#241, owner 2026-09-07): route by
  road / on foot / straight line with turn guidance, plus a places search bar.
  Anchored to #95, #231, #232 and backlog item 5; needs a routing engine
  (Valhalla/OSRM on the NAS first, on-device graphs for true offline) — Google
  Places/Directions are paid and their ToS forbid use on non-Google maps.

- **Map store: real filters + design pass** (#250, owner 2026-09-08): the
  current chips divide nothing (100% of items are `topo`; CanTopo has no
  `region`). Phase 1 facets from existing data (country/source, scale, region,
  near-me, language), phase 2 categories/activity tags as sources grow.
  Mockup in the web playground first.

## Larger initiatives (planned 2026-08-08 — owner approved all recommendations)

Design packages live in `docs/plans/`. Shipped 2026-08-08/09 (all OTA'd to
1.5.0 + 1.4.0): meteo M1 (PR #189, ECCC radar/wind/precip + forecast card),
map store M1 (PR #191, Search tab + 128-sheet CanTopo catalog live at
/catalog/v1/), sync M0 (PR #190, pure LWW core), marine M2+M3 (PR #194,
St. Lawrence tides in the forecast card + NONNA bathymetry/seamark layer
with 'Not for navigation' chip). Same wave: FAB corner nudge (PR #192),
tinted settings category headers (PR #193).

Next milestones when prioritized: sync M1 (accounts; NAS = UGREEN DXP4800
Plus, Docker — unblocked, needs owner-side Cloudflare Tunnel/SMTP/B2
setup), map store M2 (regions/bbox search + USGS/NPS) and M3 (GeoTIFF →
BDTQ Québec depth), marine M4 (offline chart regions). Still owed by the
owner: SÉPAQ / Canot Kayak Québec outreach (drafts on request).

- **Profiles + paid cloud sync ($2.99/mo)** — accounts with profile image,
  email, etc.; traces + trail photos synced across devices; backend on the
  owner's NAS. The app stays free; cloud sync is the paid tier. Note: Apple
  and Google both require in-app purchase for digital subscriptions (their
  15-30% cut applies) — pricing/billing architecture must account for that.
- **Map & trail search / store (Avenza-style)** — a bottom "Search" tab: a
  centralized catalog of free maps and charts by category (parks, forest,
  hunting, topo, touristic, nautical charts, geological, aerial, river runs
  with rapid classes R1-R3...), searchable; download straight into the
  Library choosing the destination folder, rendered like any imported map.
- **Nautical + meteo** — marine charts and weather-map integration (owner:
  "would make the app extremely complete"). Owner named Navionics marine
  charts as the reference (2026-08-08). Note: Navionics is Garmin-owned and
  its API/licensing is paid and restrictive — the planning session must weigh
  it against open sources (OpenSeaMap, NOAA/CHS raster charts) for charts and
  the usual free tile/API options for weather overlays. Scope TBD; not
  started.

- **CI verifies store uploads** (from closed PR #283, 2026-09-28) — make
  release.yml wait for each EAS build and store submission and fail loudly
  when an upload doesn't land (today it reports success once EAS work is
  scheduled; iOS submit fails for lack of an ASC secret and Android
  auto-submit never lands). Needs the App Store Connect API key and the Play
  service account as GitHub secrets first. #283 also carried ideas worth
  re-deriving on the current workflows: retry a failed submit by build ID,
  check build-number history before submit, check production-channel binary
  history before an OTA publish, keep Maestro diagnostics after a green
  retry. Until then, releases are verified directly against the store APIs.

- **Map explorer, next steps** (after #447/#449/#450, 2026-09-29) —
  1. **GeoTIFF import**: unlocks Québec topo 1:20 000 (Données Québec BDTQ,
     CC-BY, 2,765 sheets whose PDFs are not georeferenced), NRCan CanMatrix
     (covers Québec City), swisstopo, Norway N50, NZ Topo50, Spain MTN25.
  2. **Sépaq partnership**: Avenza's Map Store takes no new maps since the
     April 2026 merger; Sépaq publishes ~2,200 free maps there. A pitch is
     drafted for the owner (kept out of this public repo). Until Sépaq
     agrees in writing, Parcs Québec stays link-out.
  3. **Paid maps**: in-app purchase per map via our backend + reseller deals
     (Avenza's split was 50/50 of net). Only once a publisher signs; outside
     purchase links are forbidden on the Canadian App Store.
  4. **More brands**: Polar AccessLink (self-serve, FIT/GPX) first, then COROS
     (new self-serve MCP access, 50 FIT/day — confirm app use with
     api@coros.com), Wahoo by request. Garmin direct stays declined
     (unofficial access means impersonating Garmin's app).
  5. **Strava review**: after 2.0.1 is on phones, apply to lift the
     10-athlete cap (screenshots + brand guidelines).
- **Android developer verification**: Play Console requires registering the
  apps by 2026-09-30 (owner, identity step).

- **Screenshots for 2.0.1** (owner, 2026-09-29) — retake the App Store
  set on the iPhone simulator in light mode: the tab is "Explore" now (the
  current set still says "Maps"), and add an **Explore** shot (popular near
  you, by activity / terrain). Put the Explore shot in the website carousel
  too (`docs/assets/screens/`, EN + FR captions).
- **Privacy decisions before the 2.0.1 store reviews** — (1) trails imported
  from Apple Health / Health Connect can still be shared as GPX or sent to
  Strava by the user; hide those actions for health-imported trails if the
  policy should say health data never leaves the phone. (2) App files are not
  excluded from device backups; consider excluding imported trails (Apple
  5.1.3: no health data in iCloud).
- **Release tag**: `v2.0.1` points at `07f8696`, but the shipped 2.0.1 builds
  (iOS 14, Play vc59) are from `9b28be7` (Expo patch rebuild). Move the tag
  only if a rerun of release.yml is intended (it would start builds).

## On ice

- **iOS map performance** — paused 2026-08-08 (owner has no iPhone access for
  the two diagnostic readings). Findings so far: simulator JS rates clean
  (~1 render/s while panning); Samsung error queue was a red herring; the
  iPhone TestFlight build has the dead ERROR_REPORT_TOKEN baked in, so iOS
  errors queue invisibly — resume = ask the 4 diagnostic questions, then
  TestFlight build 5 (rotated token + FPS overlay). Probe parked on branch
  `ios-perf-probe`.
- **Garmin Connect sync + third-party hub** — the official Connect
  Developer Program answered negatively (upgrade, no timeline). New plan
  (2026-09-27): sync through an unofficial Garmin Connect API library from
  GitHub (username/password login, same endpoints as the web app) instead.
  To assess before building: pick a maintained library (licence, activity
  upload support), where the login runs (on device vs. our backend — never
  store the user's Garmin password), rate limits / breakage risk when
  Garmin changes its web API, and store-review wording. Reuse the hub UI
  parked on PR #171 (branch `third-party-sync`).
- **Strava — parked (2026-09-27).** Strava's API now needs a premium
  (subscriber) account for users, so it isn't worth pursuing for now. OTA
  updates no longer require the Strava keys (repo variable
  `OTA_REQUIRED_EXTRA=none`); installs that take an update show the Strava
  row disabled ("not configured in this build").

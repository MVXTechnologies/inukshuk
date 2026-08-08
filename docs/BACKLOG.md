# Inukshuk — feature & bug backlog

Owner-maintained wishlist. Claude reads this at the start of a session to pick
up where we left off; items move to ~~struck~~ with the shipping PR when done.
Ordered roughly by priority (top = next).

## Queued (owner requests, 2026-08-07)

1. ~~**Bottom-left map chrome must go**~~ — shipped in PR #185 (OTA'd to
   1.5.0 + 1.4.0, 2026-08-08). Logo + attribution (i) removed; the OSM/Esri/
   MapLibre credit line lives in Settings → About → "Maps & data".
2. ~~**Recording card sits lower**~~ — shipped in PR #185 (same OTA); the
   recording UI now sits just above the tab bar in the freed space.
3. ~~**BUG: waypoint button off-screen after expand→collapse**~~ — fixed in
   PR #185 (same OTA); verified with a dedicated expand→collapse Maestro
   flow on both platforms.
4. **Settings grouped into expandable categories** — Settings is getting
   scattered; group into collapsible sections, roughly: Third party / App /
   System info / System settings / Data settings.
5. **Trail navigation mode** — tapping a navigation-category trail offers
   "Start navigating": guidance along the trail, and an off-trail alarm
   (beep/vibrate) that works with the screen off.
6. **Move the trim (scissors) button out of trail focus** — it edits the GPX
   (different from map viewing); move it next to the GPX title (right side) or
   to the bottom of the trail view.
7. **Carousel zoom still too far out (verify first)** — multi-trace carousel
   should zoom so all trails fit roughly centred; content under the carousel
   is fine. A border-to-border fit shipped via OTA on 2026-08-07 — re-test
   after two app restarts before more tuning.

## Larger initiatives (need a planning session each)

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

## On ice

- **iOS map performance** — paused 2026-08-08 (owner has no iPhone access for
  the two diagnostic readings). Findings so far: simulator JS rates clean
  (~1 render/s while panning); Samsung error queue was a red herring; the
  iPhone TestFlight build has the dead ERROR_REPORT_TOKEN baked in, so iOS
  errors queue invisibly — resume = ask the 4 diagnostic questions, then
  TestFlight build 5 (rotated token + FPS overlay). Probe parked on branch
  `ios-perf-probe`.
- **Garmin Connect sync + third-party hub** — Garmin's developer program is
  being upgraded, no timeline. Full package parked on PR #171 (branch
  `third-party-sync`); ships as 1.6.0 when thawed.

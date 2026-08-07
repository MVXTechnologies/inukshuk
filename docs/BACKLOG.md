# Inukshuk — feature & bug backlog

Owner-maintained wishlist. Claude reads this at the start of a session to pick
up where we left off; items move to ~~struck~~ with the shipping PR when done.
Ordered roughly by priority (top = next).

## In progress

- **iOS map performance** — on a fresh install on the latest iPhone the map is
  laggy to the point of unusable; find the bottleneck (JS re-render churn vs
  native render stack), fix, and improve map load time. Android is fine.
  _Status: instrumented measurement running (2026-08-07)._

## Queued (owner requests, 2026-08-07)

1. **Bottom-left map chrome must go** — the MapLibre logo and the clickable
   attribution (i) icon take too much space. Note: OSM/Esri attribution is a
   license requirement, so it needs a new, smaller home (e.g. Settings → About
   or a one-line combined mark), not plain deletion.
2. **Recording card sits lower** — when a recording starts, the whole controls
   card (buttons + stats) should sit further down, in the space the map logo
   used to occupy, clearing more map.
3. **BUG: waypoint button off-screen after expand→collapse** — expanding the
   recording stats card and collapsing it again pushes the third (waypoint)
   button off-screen. Only happens after an expand→collapse cycle.
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
- **Nautical + meteo** — nautical charts and weather integration (owner:
  "would make the app extremely complete"). Scope TBD.

## On ice

- **Garmin Connect sync + third-party hub** — Garmin's developer program is
  being upgraded, no timeline. Full package parked on PR #171 (branch
  `third-party-sync`); ships as 1.6.0 when thawed.

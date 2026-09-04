# Reply to App Review — Guideline 2.1 "Information Needed" (1.5.0 build 5)

Paste sections 2–6 into the Resolution Center reply. Attach the screen
recording from section 1. The same content (condensed) is in the App Review
Notes field of the version, as Apple requested.

## 1. Screen recording — what to capture (physical iPhone, latest iOS)

Start from the Home Screen, tap the Inukshuk icon, and record one continuous
take (~3 min). There is **no** account, login, user-generated content or paid
content in the app, so none of those flows exist to show; say so in the reply.

1. **Launch** → the Map tab opens on your position. Pan/zoom once.
2. **Search tab** → "Around you" lists free government topo sheets → tap one
   → Download → it appears in the Library and draws on the map. (Shows
   the app is not empty on a fresh install and needs no sample file.)
3. **Map tab → "+" → Record track** → pick "Hike" → Start. Walk a few metres
   so the HUD distance moves. Lock the phone for ~10 s, unlock — recording
   continued (this is the background-location justification). Stop → Save.
4. **Library tab** → the saved trail card → open it: 2D map with the route,
   elevation profile, notes; tap **3D**.
5. **Settings** → System settings → Privacy → show "Automatic error
   reporting" toggle; → System info → "Maps & data" attribution.
6. Optional: Airplane Mode on, return to the Map — the downloaded sheet still
   renders (offline claim).

## 2. Purpose and target audience

Inukshuk is an offline trail-navigation app for hikers, backcountry skiers,
snowshoers, paddlers and hunters — anyone whose map matters more than their
signal. It solves one problem: official topographic maps are published as
georeferenced PDFs that phones cannot navigate on. Inukshuk renders those PDFs
(imported by the user, or downloaded free from the in-app catalogue of USGS,
Natural Resources Canada and Geoscience Australia sheets) and draws the user's
GPS position on them entirely offline, records the outing as a standard GPX
track with elevation profile and notes, and shows the terrain in 3D. It is
free, open source (MIT), has no account, no ads, no analytics and no tracking.

## 3. Setup and access

Nothing to set up. No login, no credentials, no sample files needed:
- Open the **Search** tab: it lists free topographic sheets around the
  device's location (works anywhere in the US, Canada and Australia; elsewhere
  use the name search, e.g. "Denver"). Tap Download; the sheet lands in the
  Library and renders on the Map.
- Or import any georeferenced PDF / GPX via the Library's Import button or
  iOS "Open with".
- **Record**: Map → "+" → Record track → activity → Start. Live stats in the
  HUD; Stop saves to the Library.
- **Trail view**: Library → tap a trail → 2D/3D, elevation profile, notes,
  trim, export PDF/GPX.
- **Offline**: Map → "+" → Download map area (or Settings → Data settings →
  "Locally downloaded only").

## 4. External services used for core functionality

All are called directly from the device over HTTPS; the app has no backend of
its own and no service receives an account or identity.
- **OpenStreetMap** (tile.openstreetmap.org) — 2D base map tiles.
- **Esri / ArcGIS Online** (server.arcgisonline.com) — Satellite and Relief
  (World Topo) base maps.
- **AWS Terrain Tiles** (s3.amazonaws.com/elevation-tiles-prod) — open DEM for
  3D terrain, contours and elevation profiles.
- **OpenFreeMap** (tiles.openfreemap.org) — vector labels/fonts;
  **Waymarked Trails** (tile.waymarkedtrails.org) — optional marked-trail overlay.
- **OpenStreetMap Nominatim** and the **platform (Apple) geocoder** — naming a
  downloaded map area / a saved recording.
- **Map catalogue** (inukshuk.mvxtechnologies.com, our static site) — the
  index of free sheets; the sheets themselves download from **USGS**
  (prd-tnm.s3.amazonaws.com), **Natural Resources Canada**
  (ftp.maps.canada.ca) and **Geoscience Australia**.
- **Expo EAS Update** — over-the-air JavaScript updates.
- **GitHub Issues** (github.com/MVXTechnologies/inukshuk) — optional automatic
  error reports (message, stack, app/OS version, device model; no location or
  content; off in Settings).
Present in the codebase but **disabled in this release** and not reachable
from the UI: weather layers (Environment Canada GeoMet), marine charts
(CHS/NOAA/EMODnet), and a Strava upload (no Strava credentials are configured
in this build, so it cannot connect). No AI services, no payment processor,
no authentication provider.

## 5. Regional differences

The app functions identically in every region. The only regional variation is
data coverage: the free map catalogue holds government sheets for the United
States, Canada and Australia, so the "Around you" list is fuller there;
everywhere else the OpenStreetMap/Esri base maps, recording, 3D terrain and
imported PDFs work the same. No feature is geo-restricted.

## 6. Regulated industry / protected material

Not applicable. The app is not in a regulated industry and contains no
proprietary third-party material. All map data is openly licensed and
attributed in Settings → System info → "Maps & data": OpenStreetMap (ODbL),
Esri basemaps (Esri terms of use), AWS Terrain Tiles (open data), USGS US Topo
(US public domain), Natural Resources Canada CanTopo (Open Government Licence –
Canada 2.0), Geoscience Australia (CC-BY 4.0). We link to the agencies' own
downloads; we do not rehost them.

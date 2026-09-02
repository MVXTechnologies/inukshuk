# App Store submission — the owner's checklist

Everything that can be prepared in the repo **is** prepared. What is left is the
part Apple only lets the Account Holder do: the App Store Connect (ASC) forms
and the Submit button.

Work top to bottom. Every step names the exact screen and field.

- Apple Team **8S5UZVMQFA** (Individual), Apple ID **marc-andre.vigneault.02@hotmail.com**
- ASC app record **Inukshuk**, Apple ID **6797629589**, bundle `com.inukshuk.app`,
  SKU `inukshuk-001`, primary language **English (Canada)**
- Version to ship: **1.5.0**, build **4** (`app.config.ts`)

Ready-made copy lives in [`store/appstore/`](../store/appstore); screenshots in
[`store/screenshots/ios/6.9-inch/`](../store/screenshots/ios/6.9-inch) and
[`store/screenshots/ipad/13-inch/`](../store/screenshots/ipad/13-inch).

---

## 0. Pre-flight (do this first — it changes later answers)

| Check                  | How                                                                                                   | Why it matters                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Privacy policy is live | open <https://inukshuk.mvxtechnologies.com/privacy/>                                                  | ASC rejects a 404 policy URL                                          |
| Support URL is live    | open <https://github.com/MVXTechnologies/inukshuk/issues>                                             | same                                                                  |
| Error-report channel   | `eas env:list --environment production` — is `ERROR_REPORT_TOKEN` **or** `ERROR_REPORT_ENDPOINT` set? | decides the **Diagnostics** answers in §4                             |
| Strava                 | same command — are `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` set?                                   | if set, the app can upload a GPX track to Strava, which changes §4    |
| Map catalogue          | open <https://inukshuk.mvxtechnologies.com/catalog/v2/index.json>                                     | the Search tab is empty (and looks broken to a reviewer) if this 404s |

**Known gap — fix before submitting:** `docs/privacy/index.html` is out of date
relative to the code. It does not mention (a) the Strava upload, (b) the map
store and the USGS / NRCan / Geoscience Australia download hosts, (c) that
naming a saved recording reverse-geocodes its first point through the platform
(Apple) geocoder, or (d) the Waymarked Trails and OpenFreeMap tile hosts. The
App Privacy answers below must not contradict the published policy, so update
the policy page first, or soften §4's location answer as noted there.

---

## 1. Build and upload the binary

Nothing in ASC works until a build has finished processing. From the repo root,
with `asc-api-key.p8` present (gitignored) and `eas login` done:

```sh
eas build --platform ios --profile production
eas submit --platform ios --profile production --latest
```

`eas.json → submit.production.ios` already carries `ascAppId 6797629589`,
`ascApiKeyId KLFW83ZF9L`, issuer `f0545d6d-…`, team `8S5UZVMQFA`, so `eas submit`
needs no extra flags. (The tag-driven path in `docs/DEPLOYMENT.md` —
`npm version …` + `git push --follow-tags` — does the same thing through
`release.yml`; use whichever you prefer, but do **not** bump `version`: 1.5.0
build 4 is what these screenshots and this checklist describe.)

Wait for **TestFlight → Builds → iOS** to show `1.5.0 (4)` in state **Ready to
Submit** / **Valid** (processing is 5–30 min). If it lands in _Missing
Compliance_, see §6.

---

## 2. App Information (App Store → General → App Information)

| Field                | Value                                                                                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                 | `Inukshuk` (`store/appstore/name.txt`)                                                                                                                                                                                                                                              |
| Subtitle             | `Offline trail maps & GPS` (`store/appstore/subtitle.txt`)                                                                                                                                                                                                                          |
| Privacy Policy URL   | `https://inukshuk.mvxtechnologies.com/privacy/`                                                                                                                                                                                                                                     |
| Category — Primary   | **Navigation**                                                                                                                                                                                                                                                                      |
| Category — Secondary | **Sports**                                                                                                                                                                                                                                                                          |
| Content Rights       | Tick **"This app contains, shows, or accesses third-party content"** and confirm you have the rights. (True: OpenStreetMap tiles under ODbL, Esri basemaps, AWS Terrain Tiles, and the USGS / Natural Resources Canada / Geoscience Australia topo sheets the Search tab links to.) |
| License Agreement    | Leave Apple's standard EULA                                                                                                                                                                                                                                                         |
| Age Rating           | see §3                                                                                                                                                                                                                                                                              |

---

## 3. Age Rating (App Information → Age Rating → Edit)

Answer **None / No** to every content question — the app has no violence, no
sexual or suggestive content, no profanity, no alcohol/tobacco/drug references,
no horror, no simulated gambling, no contests, no in-app purchases, no medical
or treatment information, and no user-generated content shared with others.

Two questions that are easy to get wrong:

- **"Unrestricted Web Access"** → **No.** The app has no in-app browser; the only
  WebView is an offscreen, non-navigable PDF rasterizer.
- **"Does the app allow users to communicate / share user-generated content?"**
  → **No.** Notes and photos stay on the device; sharing is a system share sheet
  the user invokes.

Expected result: **4+**.

---

## 4. App Privacy (left sidebar → App Privacy)

This is the longest form and the one most likely to cause a rejection if it
disagrees with the app or the policy page. Click **Get Started** on
_Data Collection_.

### 4.1 "Do you or your third-party partners collect data from this app?"

**Yes.** (Crash/error reports are sent automatically. Answering "No" would be
wrong unless _both_ `ERROR_REPORT_TOKEN` and `ERROR_REPORT_ENDPOINT` are unset —
see §0 — in which case nothing ever leaves the device and you may answer "No".)

### 4.2 Data types to tick

Tick exactly these; leave every other category unticked (no contact info, no
health, no financial info, no contacts, no user content, no search or browsing
history, no identifiers, no usage data, no purchases, no sensitive info).

**Location → Precise Location**

- Used for: **App Functionality** only.
- Linked to the user's identity: **No.**
- Used for tracking: **No.**
- _Why tick it:_ the app is location-first, and coordinates do leave the device
  in two narrow cases — naming a downloaded region via OpenStreetMap Nominatim
  (`src/features/map/regionNaming.ts`) and auto-naming a just-saved recording
  through the platform reverse geocoder (`src/state/recorderStore.ts`) — plus
  the Strava upload if Strava is configured. Over-declaring here is safe;
  under-declaring is what gets labels rejected.
- Do **not** tick Coarse Location.

**Diagnostics → Crash Data** and **Diagnostics → Other Diagnostic Data**

- Used for: **App Functionality** only (not Analytics — these are bug reports
  the developer reads, not product analytics).
- Linked to the user's identity: **No.**
- Used for tracking: **No.**
- _What is actually sent_ (`src/lib/errorReporting/`, `src/core/errors/types.ts`):
  `message`, `stack`, `componentStack`, `isFatal`, a static `context` string,
  two fixed breadcrumb strings, first/last seen timestamps, a count, and
  `environment` = app version, runtime version, update id, OS version, device
  model. **No location, no map or trail content, no account, no device
  identifier.** On by default; the user can switch it off at
  _Settings → System settings → Privacy → Automatic error reporting_.
- Leave **Performance Data** unticked — no performance metrics are sent.

**Only if Strava credentials are configured in the production build (§0):**
add **Health & Fitness → Fitness** — App Functionality, not linked to identity,
not used for tracking. (The user's saved GPX track is uploaded to Strava, but
only on an explicit "Send to Strava" / "Push to Strava?" action, and only after
they connect their own Strava account.) If Strava is not configured, the feature
is inert ("Strava is not configured in this build") and this must stay unticked.

### 4.3 Tracking

**No.** There is no advertising identifier, no ad SDK, no analytics SDK
(verified: no Sentry, Firebase, Amplitude, PostHog, Segment, Mixpanel, GA,
AppsFlyer or Facebook SDK anywhere in the project), and no App Tracking
Transparency prompt.

Click **Publish** on the privacy answers — they will not take effect otherwise.

---

## 5. Pricing and Availability (left sidebar)

1. **Price Schedule → Price** → **Free** (CAD 0 / Tier 0), no scheduled changes.
2. **Availability** → **All countries and regions**.
3. No pre-orders, no custom app distribution.
4. Check **Business** (formerly _Agreements, Tax, and Banking_): the
   **Free Apps** agreement must read **Active**. A yellow "Action needed" banner
   there silently blocks submission — clear it before §7.

---

## 6. The 1.5.0 version page (App Store → iOS App → 1.5.0 Prepare for Submission)

### 6.1 Screenshots

Apple requires the **6.9-inch iPhone** set, and — because `ios.supportsTablet`
is `true`, so the binary is universal — a **13-inch iPad** set as well.

Upload, in this order, from `store/screenshots/ios/6.9-inch/` (1320 × 2868):

| #   | File                           | Shows                                                                  |
| --- | ------------------------------ | ---------------------------------------------------------------------- |
| 1   | `01-map-live-trail.png`        | Your live position on a recorded loop, with the repeat-visit heat glow |
| 2   | `02-trail-elevation-notes.png` | Trail focus: route, numbered notes, interactive elevation profile      |
| 3   | `03-library-folders.png`       | Library — folders, activity categories, per-outing stats               |
| 4   | `04-offline-download.png`      | Download offline area — basemap, detail level, tile count              |
| 5   | `05-map-maker.png`             | Make a map — a printable georeferenced topo PDF with contours          |
| 6   | `06-map-store.png`             | The free catalogue of official topo sheets                             |

Then the iPad tab, from `store/screenshots/ipad/13-inch/` (2064 × 2752):
`01-map-live-trail.png`, `02-trail-elevation-notes.png`, `03-library-folders.png`,
`04-offline-download.png`.

The old 6.1-inch set is kept, unused, in `store/screenshots/ios/legacy-6.1-inch/`
— **do not upload it**, Apple no longer accepts 1170 × 2532 as a primary size.

### 6.2 Text fields

Paste verbatim from `store/appstore/`:

| ASC field        | File                        | Length                               |
| ---------------- | --------------------------- | ------------------------------------ |
| Promotional Text | `promotional-text.txt`      | 158 / 170                            |
| Description      | `description.txt`           | 3 475 / 4 000                        |
| Keywords         | `keywords.txt`              | 97 / 100                             |
| Support URL      | `urls.txt`                  | —                                    |
| Marketing URL    | `urls.txt`                  | —                                    |
| What's New       | `whats-new.txt`             | (only shown from the 2nd version on) |
| Copyright        | `2026 Marc-André Vigneault` | —                                    |

### 6.3 Build

**Build** section → **+** → pick `1.5.0 (4)`.

### 6.4 App Review Information

- **Sign-in required** → **unchecked**. No account exists.
- **Contact Information** → your name, phone and
  marc-andre.vigneault.02@hotmail.com.
- **Notes** → paste `store/appstore/review-notes.txt`. It pre-answers the two
  things reviewers ask a trail app: why `UIBackgroundModes: location` is
  declared, and why the app runs a loopback HTTP server. Skipping this is the
  most likely cause of a first-round rejection.
- **Attachment** → none needed.

### 6.5 Version Release

**Manually release this version** — so a passed review does not go live while
you are asleep.

### 6.6 Export compliance

`ITSAppUsesNonExemptEncryption: false` is already in the Info.plist
(`app.config.ts`), so ASC should not ask. If the build shows **Missing
Compliance** anyway, open it under _TestFlight → Builds_ and answer:

- "Does your app use encryption?" → **Yes** (it uses HTTPS).
- "Does it qualify for the exemptions?" → **Yes** (standard OS-provided TLS
  only; no proprietary or non-exempt cryptography).

No CCATS or year-end self-classification report is required for this app.

---

## 7. Submit

**Add for Review** → confirm → **Submit to App Review**.

Then: state goes _Waiting for Review_ → _In Review_ → _Pending Developer
Release_ (because of §6.5). Release it from the version page when you are ready.
First reviews typically land within 24–48 h.

If it comes back rejected, the two plausible grounds are:

- **Guideline 2.5.4 / background location** — answer with the §6.4 note: the
  background mode is used only to continue a user-started recording, it starts
  at "Start recording" and stops at "Stop", and the app works with
  _While Using the App_ permission alone.
- **Guideline 5.1.1 / privacy label mismatch** — means the App Privacy answers
  in §4 disagree with the published policy page; fix the policy (§0) rather than
  the label.

---

## 8. Repo-side notes for later

Not blockers for this submission, but worth doing:

- The privacy policy update listed in §0.
- The Dashboard's distance chart clips its y-axis labels once weekly totals
  reach two digits ("0.00 km" instead of "10.00 km"), which is why no Dashboard
  screenshot is in the store set.
- 3D terrain does not render in the iOS Simulator (expo-gl), so the 3D screen
  could not be captured here. If you want a 3D screenshot in the listing, take
  it on a device and drop it into `store/screenshots/ios/6.9-inch/`.
- Weather and marine are parked behind `WEATHER_ENABLED` / `MARINE_ENABLED` on
  `release/park-weather-marine`. Nothing in the listing copy or the screenshots
  mentions either — but make sure the branch you actually build from is the one
  where they are parked, or the app will ship features the listing does not
  describe (and that pull data from ECCC/CHS).

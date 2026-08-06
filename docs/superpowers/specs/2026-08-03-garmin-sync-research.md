# Garmin Connect auto-import — research (2026-08-03)

Goal: auto-import activities recorded on a user's Garmin watch into Inukshuk's
existing GPX track library. Status: research only, no code.

## 1. Official route — Garmin Connect Developer Program

- **What it offers.** The [Activity API](https://developer.garmin.com/gc-developer-program/activity-api/)
  delivers full activity data (30+ activity types) as **FIT, GPX and TCX** files
  plus JSON summaries. The Health API is the wellness side (steps, sleep, HR
  time series) — for track import only the Activity API matters.
- **Delivery model.** "Ping/Pull or Push": Garmin **pushes webhooks to a
  callback URL you register** when the user's watch syncs. There is no
  poll-on-demand endpoint. **This requires a backend server** — Inukshuk
  currently has none (offline-first, no accounts).
- **Auth.** [OAuth 2.0 + PKCE](https://developerportal.garmin.com/sites/default/files/OAuth2PKCE_1.pdf);
  doable in Expo with `expo-auth-session` (a
  [worked RN/Expo example exists](https://dev.to/alexanderhodes/implement-garmin-connect-oauth2-authentication-in-react-native-with-expo-1j55)),
  but token exchange + webhook receipt still belong on a server.
- **Cost.** No licensing or maintenance fees ([program FAQ](https://developer.garmin.com/gc-developer-program/program-faq/)).
- **Friction (the real problem).** The program is explicitly **enterprise /
  business oriented**; review is "within two business days" plus an integration
  call, but the access-request form has been reported
  ["under construction" / on hold](https://forums.garmin.com/developer/connect-iq/f/discussion/434761/apply-for-connect-developer-program-access-request-form-down)
  and the site says "stay tuned for more updates on the program". Indie/hobby
  approval is unproven; contact is `connect-support@developer.garmin.com`.
  Third-party aggregators ([Terra](https://tryterra.co/integrations/garmin),
  [Open Wearables](https://openwearables.io/docs/providers/garmin-api-integration))
  resell official access but are paid, per-user services.

## 2. Unofficial route — reverse-engineered Connect API

- **Landscape.** [`garth`](https://github.com/matin/garth) (Python, the
  reference implementation) is now **deprecated**: Garmin changed the auth flow
  and, since ~mid-March 2026, **blocks automated hits to the SSO login
  endpoints (`/sso/signin`, `/mobile/api/login`) at the Cloudflare level**.
  Browser-based login still works, and projects like
  [peloton-to-garmin](https://github.com/philosowaffle/peloton-to-garmin/issues/837)
  survive by having the user log in in a real browser, capturing the **service
  ticket**, exchanging it for DI OAuth2 tokens at `diauth.garmin.com`, then
  living on **refresh tokens (~30 days, auto-refreshable)**.
  [`python-garminconnect`](https://github.com/cyberjunky/python-garminconnect)
  and the npm [`garmin-connect`](https://github.com/Pythe1337N/garmin-connect)
  (v1.6+, `saveTokenToFile`/`loadTokenByFile`, `getActivities`,
  `downloadOriginalActivityData`) remain maintained but are in constant churn;
  headless credential login is effectively dead in 2026.
- **Endpoints that matter** (once a bearer token exists):
  - list: `connect.garmin.com/activitylist-service/activities/search/activities?start=0&limit=20`
    → JSON with `activityId`, type, start time, distance.
  - GPX: `connect.garmin.com/download-service/export/gpx/activity/{activityId}`
  - original FIT (zip): `download-service/files/activity/{activityId}`
- **Rate limits / ban risk.** Aggressive 429s are on the **login** endpoints
  ([#213](https://github.com/cyberjunky/python-garminconnect/issues/213),
  [#337](https://github.com/cyberjunky/python-garminconnect/issues/337)); data
  endpoints tolerate polite polling. Community consensus: poll a small
  activity-list page a few times a day per account; no widespread account bans
  reported, but this violates Garmin ToS and can break without notice — the
  March 2026 Cloudflare change is the proof.
- **Key mobile insight.** The Cloudflare block targets _headless_ clients. A
  **WebView inside the app is a real browser**: let the user log in on
  Garmin's own SSO page (MFA included, credentials never touch our code),
  intercept the resulting ticket/cookies, exchange for OAuth2 tokens, refresh
  silently thereafter. This is the one environment where the unofficial route
  is still robust.

## 3. Mobile constraints (Expo SDK 56)

- **CORS**: native `fetch` has none — direct calls to `connect.garmin.com`
  work from the app. (Web build would need a proxy; ignore for now.)
- **Tokens**: `expo-secure-store` (Keychain/Keystore) for OAuth2
  access+refresh tokens; never store the password.
- **Background sync**:
  [`expo-background-task`](https://docs.expo.dev/versions/v56.0.0/sdk/background-task/)
  (BGTaskScheduler on iOS, WorkManager on Android; ≥15 min interval, timing
  entirely OS-discretionary, needs battery/network, dies if the app is
  swipe-killed). Fine as opportunistic best-effort, never as the primary
  mechanism. **Primary should be sync-on-app-open** (plus pull-to-refresh in
  the Library) — matches the offline-first design: no network, no sync, no
  error spam.

## 4. Fit with the existing import pipeline

- `src/core/geo/gpx/index.ts` (`parseGpx`) already handles Garmin exports
  well: tolerant parsing, `<trk>` name fallback ("Garmin/Strava exports name
  the `<trk>`"), **`gpxtpx:hr` at any depth → `heartRateBpm`**, and
  `gpxtpx:speed`. Imports arrive today via `content://` intents
  (`+native-intent`); a Garmin fetch just needs to hand the same GPX string to
  the same core path.
- **Garmin GPX exports include** per-point `ele`, `time`, and
  `gpxtpx:TrackPointExtension` with **hr, cadence (`gpxtpx:cad`), temperature
  (`gpxtpx:atemp`)** when recorded. HR flows through already; cadence/temp are
  currently dropped (no `TrackPoint` fields) — optional model extension.
- **FIT-only gaps**: laps/splits, per-point power, running dynamics,
  training-load metrics, precise per-point speed. Not needed for the trail use
  case; if ever wanted, parse the original FIT zip with `@garmin/fitsdk`
  in a later phase.
- **Dedupe**: Garmin `activityId` is stable and unique — store it on the
  imported track (e.g. `source: 'garmin'`, `garminActivityId`) and skip
  already-imported ids; also lets a re-sync repair a partial import.

## 5. Recommendation — phased plan

**Phase 1 — unofficial sync, WebView auth (ships without any backend).**

1. Settings → "Connect Garmin": open Garmin SSO (`sso.garmin.com/sso/embed`
   flow) in a WebView; user logs in on Garmin's page (MFA works natively);
   intercept the service ticket, exchange for DI OAuth2 tokens, store in
   `expo-secure-store`. Show connected-account state + "Disconnect".
2. Small in-repo TS client (port the token-exchange + two endpoints from
   `Pythe1337N/garmin-connect` / `garth` patterns rather than depending on a
   Node-targeted lib): `listActivities(start, limit)` + `downloadGpx(id)`.
   Keep it in `src/data` (it's platform/IO, not core).
3. Sync on app open (+ manual refresh): fetch newest ~20 activities, filter to
   unseen `activityId`s (optionally to outdoor types), download GPX, run
   through `parseGpx` → existing library save. Optionally register an
   `expo-background-task` (12 h interval) doing the same, silently.
4. Failure posture: 401 → one silent refresh attempt, then a non-blocking
   "reconnect Garmin" badge (no Portal/Dialog on launch paths). Offline → skip.

**Phase 2 — official API swap (if/when the program reopens to indies or via an
aggregator).** Apply to the Connect Developer Program; stand up a minimal
webhook receiver (could be an EAS-hosted API route) that stores pushed
activity files keyed by user; app pulls from it. Auth becomes OAuth2 PKCE via
`expo-auth-session`. The client seam from Phase 1 (list + fetch-GPX behind an
interface) makes this a swap, not a rewrite.

**Open design questions**

1. Is a backend ever acceptable for this app, or must Phase 2 wait for a
   server-optional shape (aggregator, or user-hosted)?
2. Sync scope: all activities, or only hike/run/walk/ski types? Everything
   since connect, or only activities after link date?
3. Extend `TrackPoint` with cadence/temperature (and tests) now, or HR-only?
4. Is background sync worth its testing burden in 1.x, or is
   on-app-open + pull-to-refresh enough?
5. Comfort level shipping a ToS-gray integration in a store app (Strava-style
   "works until Garmin changes something") — feature-flag it?

**Sources**: linked inline above; also
[garmin-connect-export](https://github.com/pe-st/garmin-connect-export)
(endpoint reference), [garth docs](https://garth.readthedocs.io/),
[SSO widget-flow analysis (#344)](https://github.com/cyberjunky/python-garminconnect/issues/344),
[Playwright token bootstrap gist](https://gist.github.com/centic9/5c8bb2473211ad92a91a88a1b7a16131).

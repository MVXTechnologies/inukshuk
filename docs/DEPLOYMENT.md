# Deployment — publishing Inukshuk to the App Store & Play Store

The pipeline is built and ready (`.github/workflows/release.yml` + `eas.json`).
But **publishing to the stores cannot be fully automated by code alone** — Apple
and Google require developer accounts, legal agreements, and signing identities
that only you can create. This document is the exact checklist.

## TL;DR of what only a human can do

| Thing                                     | Who / cost                               | Why it can't be scripted away                              |
| ----------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| Apple Developer Program                   | You — **$99 / year**                     | Required to ship any app on iOS. Legal identity + payment. |
| Google Play Developer account             | You — **$25 one-time**                   | Required to ship on Android.                               |
| App listings (name, screenshots, privacy) | You, in App Store Connect & Play Console | Stores require store-page content + a privacy policy.      |
| Review approval                           | Apple/Google reviewers                   | Both stores manually review the first submission.          |

The app itself stays **free to download**. The fees above are the developer's
cost of being on the stores, not the user's.

> If you only want people to install it without the stores, you can skip all of
> this: `eas build --profile preview` produces an installable Android APK and an
> iOS build you can distribute via TestFlight or ad-hoc — far less overhead.

## One-time setup

### 0. Expo / EAS

1. Create a free Expo account at [expo.dev](https://expo.dev).
2. `npm i -g eas-cli && eas login`
3. From the project root: `eas init` — this creates the EAS project and prints a
   **project id**. Put it in the repo as the `EAS_PROJECT_ID` env/secret (the
   app config already reads `process.env.EAS_PROJECT_ID`).
4. Configure the OTA update URL: `eas update:configure` (sets `EAS_UPDATE_URL`).
5. Create a GitHub Actions secret **`EXPO_TOKEN`** — generate it at
   _expo.dev → Account → Access Tokens_. Until this secret exists, the
   `release.yml` and `ota-update.yml` workflows safely no-op.

### 1. iOS — App Store

1. Enrol in the **Apple Developer Program** ($99/yr).
2. In **App Store Connect**, create an app record with bundle id
   `com.inukshuk.app` (matches `app.config.ts`).
3. Create an **App Store Connect API key** (Users and Access → Integrations →
   App Store Connect API). Download the `.p8` once. Note the **Key ID**,
   **Issuer ID**, and your **Team ID**.
4. Fill those non-secret IDs into `eas.json → submit.production.ios`
   (`ascApiKeyId`, `ascApiKeyIssuerId`, `appleTeamId`).
5. Add the `.p8` contents as the GitHub secret **`ASC_API_KEY_P8`**.

EAS manages the distribution certificate and provisioning profile for you
(`eas build` will create them on first run, or run `eas credentials`).

Going from TestFlight to a **public App Store release** needs a pile of App
Store Connect forms only the account holder can fill in (App Privacy, age
rating, pricing, screenshots, review notes). That ordered checklist — plus the
ready-made listing copy in `store/appstore/` and the screenshot sets in
`store/screenshots/` — is in **`docs/APP-STORE-SUBMISSION.md`**.

### 2. Android — Play Store

1. Create a **Google Play Developer account** ($25 once).
2. In **Play Console**, create the app, package name `com.inukshuk.app`.
3. Create a **Google Cloud service account** with the _Play Android Developer
   API_ enabled, grant it access in Play Console (Users and permissions →
   Release manager), and download its **JSON key**.
4. Add the JSON contents as the GitHub secret **`GOOGLE_SERVICE_ACCOUNT_JSON`**.
5. The first upload to a new Play app must be done manually once (Google
   requires the initial APK/AAB through the console); subsequent submissions go
   through `eas submit` to the `internal` testing track (configured in
   `eas.json`). Promotion to production is a manual Play Console step — see
   _Releasing_ below.

EAS manages the Android upload keystore for you.

## Local iOS builds — machine prerequisites

Building the prebuilt `ios/` workspace locally (`npx expo prebuild -p ios`,
then `xcodebuild` or a run from Xcode) needs more than Xcode alone (#130):

- **Xcode** (current stable) with its iOS platform/simulators installed.
- **CocoaPods** — `sudo gem install cocoapods` or `brew install cocoapods`;
  `pod install` runs as part of `npx expo prebuild -p ios`.
- **cmake** — `brew install cmake`. **Not bundled with Xcode** and easy to
  miss: `react-native-static-server`'s pod compiles its native Lighttpd
  dependency with CMake in a build script phase, and without it the very first
  `xcodebuild` fails with the cryptic
  `Script-….sh: line 21: cmake: command not found`. The script phase inherits
  the invoking shell's `PATH`, so make sure `/opt/homebrew/bin` is on the
  `PATH` of whatever launches the build (a terminal-launched Xcode or
  `xcodebuild` from your shell both qualify; GitHub's macOS runners preinstall
  cmake already).
- **`DEVELOPER_DIR`** — if `xcode-select -p` points at
  `/Library/Developer/CommandLineTools`, either
  `sudo xcode-select -s /Applications/Xcode.app` or export
  `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` before building;
  the CLT-only toolchain cannot build iOS apps.

EAS iOS builds run `scripts/eas-pre-install.sh` before dependency installation.
The hook installs CMake with Homebrew only when it is missing, then verifies
that it is on the worker PATH. This supplies the same Lighttpd build dependency
required locally; the Android hook is a no-op.

## Releasing

Once the secrets above exist, a release is a bump, a commit and a tag:

```bash
npm run release:bump -- --version 1.6.0   # or: major | minor | patch
# Rewrite the release-note comments it lists, add the CHANGELOG section,
# commit ("Release 1.6.0 (iOS build 9, Play vc55)") and merge as usual. Then
# tag the merged commit:
git tag v1.6.0 <commit> && git push origin v1.6.0
```

`release:bump` (`scripts/release/bump-version.mjs`) moves `version` in
`package.json`, `app.config.ts` and the lock file's root together, and adds
one to the iOS `buildNumber` and the Android `versionCode` — both stores
refuse a build number they have seen. It refuses to go backwards, refuses
when `package.json` and `app.config.ts` disagree, and refuses when a field is
not where it expects; `--dry-run` shows the plan without writing. It does no
git itself: it prints the tag to create. (It replaces `npm version patch`,
which moved only `package.json` and left the store-facing numbers to hand
edits.)

`release.yml` then:

1. builds production binaries on EAS for both platforms, and
2. auto-submits them — iOS to TestFlight, Android to the Play **internal
   testing** track with `releaseStatus: completed` (rolled out to internal
   testers at once; valid for the internal track).

Neither store goes public on its own. The binary reaches real users only
when you promote it:

- **Android:** Play Console → _Test and release_ → _Internal testing_ →
  the release → **Promote release** → _Closed testing_ (the beta) or
  _Production_ (or a staged rollout). Submitting straight to `production`
  made every tag a public release, with no chance to install the signed store
  build first; the internal track is that chance — testers get it within
  minutes.
- **iOS:** App Store Connect → the version → select the TestFlight build →
  **Submit for Review**, as before.

You can also trigger it manually from the Actions tab (choose `ios`, `android`,
or `all`).

## Field updates without a store release

For JS/asset-only fixes, you don't need a store round-trip. Merging to `main`
triggers `ota-update.yml`, which publishes an **EAS Update** to the `production`
channel; installed apps pick it up on next launch. Native changes (new modules,
permission changes) still require a full store release.

### Which installs receive an update: the runtime fingerprint

`runtimeVersion` uses the **fingerprint** policy (`app.config.ts`): the runtime
is a hash of the native project — native dependencies and their versions,
config plugins, `modules/`, `eas.json`, and the native parts of the Expo
config. An update reaches exactly the binaries built from the same native
project. `fingerprint.config.js` lists what is deliberately left out of the
hash (the environment-filled `extra`, the version and build numbers, npm
scripts, `.gitignore`) and why.

What that means in practice:

- A JS-only merge publishes to the runtime of the binaries in the stores, as
  before.
- A merge that changes native code — a native dependency bump included —
  publishes to a new runtime that no installed binary has. It reaches no one
  until a store build carries it. Nothing breaks; the fix simply waits for
  the release.
- A JS-only store release (version bump, same native project) keeps the
  runtime, so installs of the previous version keep receiving updates.
- To see the runtime of a checkout:
  `npx expo-updates fingerprint:generate --platform ios` (or `android`).

The old `app_version_override` input is gone. Under `appVersion` it
republished HEAD for an older runtime by rewriting `version`; under the
fingerprint it would change nothing, and shipping HEAD's JS to an older
binary is exactly the skew the fingerprint prevents. To fix an older binary
in the field, branch from its release tag, cherry-pick the fix, and run
**OTA Update** on that branch from the Actions tab (_Run workflow_ → pick the
branch). If the branch's native project matches the binary, the fingerprint
matches and the update lands on it.

### Credentials in an update

Installed apps read `extra` (Strava keys, error-report channel) from the
running **update's** manifest, not from the store binary, and that `extra`
is `app.config.ts` evaluated on the GitHub runner that publishes. A value
missing there is missing on every install that takes the update — Strava
turns into "not configured in this build".

- `eas update` runs with `--environment production`, which loads the EAS
  production variables with **plain text** or **sensitive** visibility.
- **Secret**-visibility EAS variables never leave EAS's servers, so they
  cannot reach an update. `ERROR_REPORT_TOKEN` must therefore also exist as
  a **GitHub Actions secret**, with the same value as in EAS. `STRAVA_CLIENT_ID` and `ERROR_REPORT_ENDPOINT` go in
  GitHub **variables** (or stay EAS-only, but then the check below cannot
  see them).
- Before publishing, `scripts/ci/assert-update-extra.mjs` evaluates the same
  public config and **fails the job** if `extra.stravaClientId` or
  `extra.stravaClientSecret` would be empty (it prints which keys are set,
  never their values). The repo variable `OTA_REQUIRED_EXTRA` overrides that
  list (comma-separated; `none` turns the check off). A missing error-report
  channel is only a warning, since reports then just stay queued.

## Error reporting (one-time, optional but recommended)

Crashes and swallowed failures are captured, queued on disk, and filed as GitHub
issues **automatically and silently** (`src/lib/errorReporting`). The app never
asks the user to open GitHub or file anything themselves; without a delivery
channel configured, reports simply stay queued on the device and nothing is
shown. Reports become public issues, so on the way out each one is scrubbed of
file paths and URIs, container ids, quoted text (map and trail names) and
coordinates (`src/core/errors/scrub.ts`), which is what lets the privacy page
promise "no location, no map or trail content". Pick **one** of the two
channels below.

### A. Embedded fine-grained token (simplest)

Create a **fine-grained personal access token** at _github.com → Settings →
Developer settings → Personal access tokens → Fine-grained tokens_ with:

- **Repository access**: only `MVXTechnologies/inukshuk`
- **Repository permissions**: `Issues` → **Read and write** (nothing else)

Then register it as an EAS environment variable, so builds pick it up:

```sh
eas env:create --name ERROR_REPORT_TOKEN \
  --value <fine-grained PAT> \
  --environment production --visibility secret
```

Add the same value as the GitHub Actions secret `ERROR_REPORT_TOKEN`, so OTA
updates carry it too (a secret EAS variable never reaches the runner that
publishes them — see _Credentials in an update_).

`app.config.ts` reads `process.env.ERROR_REPORT_TOKEN` into
`extra.errorReportToken`, so the token is **baked into the shipped binary** at
build time. Anyone who unpacks the app can extract it — the narrow scope is the
mitigation: the worst it can do is open/comment on issues in this one repo, and
it can be revoked and re-issued at any time. Never grant it code, contents, or
Actions permissions, and never reuse a classic PAT here.

### B. Relay endpoint (no secret in the binary)

Alternatively, host a tiny endpoint that holds the token server-side and set:

```sh
eas env:create --name ERROR_REPORT_ENDPOINT \
  --value https://your-relay.example/error-report \
  --environment production --visibility plaintext
```

The app then POSTs each report as JSON (`ErrorReportPayload`:
`{ fingerprint, marker, title, body, comment, report }`) and files nothing
itself, so no credential ships in the binary at all. The relay forwards
`title`/`body` to the Issues API, deduping on `marker` (an existing open issue
with that marker gets `comment` instead of a duplicate). It should return 2xx on
success; 5xx/429 make the app retry with backoff, 400 makes it drop the report.
When both variables are set, the endpoint wins.

Users can opt out entirely in _Settings → Privacy → Automatic error reporting_
(on by default). The row below it shows the pending-report count and can force a
flush — diagnostics only; it never interrupts anyone.

## Strava (one-time, optional)

The Strava integration (Settings → Connections → Connect Strava; "Push to
Strava?" after saving a recording; "Send to Strava" in the Library ⋮ menu;
importing Strava activities into the Library) needs a Strava API application,
and the token proxy on the tile Worker. Without the credentials the feature stays visible but
disabled ("Strava is not configured in this build") — nothing else changes.

### 1. Create the API app

At <https://www.strava.com/settings/api> (log in as the account that owns the
app), create an application:

- **Category**: whatever fits (e.g. "Mobile App").
- **Authorization Callback Domain**: exactly `localhost` — the app's OAuth
  redirect is the custom-scheme URL `inukshuk://localhost/strava-auth`
  (`STRAVA_REDIRECT_URI` in `src/core/strava/oauth.ts`), and Strava validates
  only the domain part (`localhost`) against this field. Do **not** enter a
  scheme or path here.

Note the **Client ID** and **Client Secret** it shows.

Since 2026-06-01 a Standard-tier Strava API app needs the **developer's**
Strava subscription (athletes who connect need none). New apps start with an
athlete cap of 1; raise it to 10 yourself in the API settings, and ask Strava
for a review beyond that (screenshots, brand-guideline compliance).

### 2. Put the secret on the token proxy, the id in the app

Strava's token endpoint needs the client secret and supports no PKCE, and the
June-2026 API agreement forbids shipping the secret in a binary. The tile
Worker (`infra/tiles/worker`, routes `POST /strava/token` and
`POST /strava/refresh`) adds it server-side:

```sh
cd infra/tiles/worker
npx wrangler secret put STRAVA_CLIENT_SECRET   # paste the secret
# STRAVA_CLIENT_ID goes in wrangler.toml [vars]; then:
npx wrangler deploy
```

The app only needs the public client id:

```sh
eas env:create --name STRAVA_CLIENT_ID \
  --value <client id> \
  --environment production --visibility plaintext
```

plus the same value as the GitHub repo **variable** `STRAVA_CLIENT_ID` (OTA
updates evaluate `app.config.ts` on the runner — see _Credentials in an
update_). Regenerating the secret on Strava only needs a new
`wrangler secret put`; no app release.

### 3. Token & data handling (already implemented)

- Tokens (access + rotating refresh token + expiry), the granted scopes and
  the athlete name are stored on-device in `strava.json`
  (`src/state/stravaStore.ts`); refresh happens automatically through the
  proxy, always keeping the rotated refresh token. The proxy stores nothing.
- Requested scopes: `activity:write` (upload) and `activity:read_all`
  (import). The athlete may untick either; the app offers what was granted.
- Imported activity data is shown only to the athlete who imported it, as the
  API agreement requires.
- Nothing is uploaded without an explicit user action, and _Disconnect_ in
  Settings also revokes the grant via `/oauth/deauthorize`.

## Support Inukshuk: tips and the public accounts (#476)

### In-app tips (store consoles, one-time)

Five **consumable** in-app products, same ids on both stores, all unlocking
nothing:

| Product id   | USD base price | Name in the app         |
| ------------ | -------------- | ----------------------- |
| `tip_small`  | $2.99          | Coffee at the trailhead |
| `tip_medium` | $6.99          | Lunch at the lookout    |
| `tip_large`  | $14.99         | A day on the trail      |
| `tip_xlarge` | $29.99         | A season of trails      |
| `tip_patron` | $99.99         | Patron of the trail     |

The USD base prices are mirrored in `TIP_USD` (`src/core/support/tips.ts`) and
used only to add up a person's own giving for the donors list. The app shows the
store's localized price and offers only the tiers the store returns, so a tier
can be added, repriced or withdrawn from the console with no release. The
library is `expo-iap` (config plugin `expo-iap` in `app.config.ts`), wrapped by
`src/lib/iap.ts`; it is native, so it ships in a store build, never by OTA.
Older binaries simply show "Tips aren't available on this device right now".

### `docs/support/costs.json` — the one source of truth

Read by the website's `/support/` and `/fr/support/` pages (inline fetch; the
page is complete without it) and by the app's Support screen (cached a day,
`src/data/supportCosts.ts`; validated by `src/core/support/costs.ts`, which
drops bad rows and hides the numbers if a required field is wrong). Update it
by hand at the start of each month from the App Store / Google Play reports:

```jsonc
{
  "year": 2026, // the calendar year the figures cover
  "currency": "USD", // ISO 4217, upper case
  "goal": 1267, // what the year costs: the sum of the recurring costs below
  "raised": 0, // net tips received this year
  "supporters": 0, // number of people who gave (integer)
  "updated": "2026-09-30", // YYYY-MM-DD of this edit
  "costs": [
    // period: "year" | "month" | "once" ("once" is shown, not counted in goal)
    {
      "label_en": "Apple developer account",
      "label_fr": "Compte développeur Apple",
      "amount": 99,
      "period": "year",
    },
  ],
  "ledger": [
    // one row per closed month; balance may be negative
    { "month": "2026-10", "costs": 113, "gifts": 0, "balance": -113 },
  ],
  "donors": [
    // opt-in, published by hand (see below); hidden in the app and site while empty
    { "name": "Anne T.", "place": "Rimouski", "since": 2026 },
  ],
}
```

A unit test parses the checked-in file and checks that `goal` equals the
annualized recurring costs, so a typo fails CI rather than the website.

### Prominent donors: `POST /donors` on the tile Worker

People whose tips add up to $100 (USD base prices, counted on the device in
`support.json`) may send a display name from the thank-you screen or Settings ›
System info. The app posts
`{ name (≤ 40), place (≤ 60, optional), platform, transactionIds (1–20) }` to
`POST /donors` on the tile Worker (`infra/tiles/worker/src/donors.ts`). The
Worker validates it, rate-limits per client IP (the `DONOR_LIMITER` binding in
`wrangler.toml`: 3 a minute, plus a per-isolate 3 an hour; the IP is never
stored) and writes it to R2 as `donors/pending/<ts>-<rand>.json`. Nothing is
published automatically:

1. List pending files: `wrangler r2 object get inukshuk-tiles/donors/pending/…`
   (or the dashboard).
2. Check each transaction id against App Store Connect / Play Console reports.
3. Add `{ "name", "place", "since" }` to `donors` in `docs/support/costs.json`,
   then delete the pending file. Removal requests (by email) are the same edit
   in reverse.

## Secrets summary (GitHub → Settings → Secrets → Actions)

| Secret                        | Needed for                                        |
| ----------------------------- | ------------------------------------------------- |
| `EXPO_TOKEN`                  | all EAS workflows                                 |
| `ASC_API_KEY_P8`              | iOS submit                                        |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Android submit                                    |
| `ERROR_REPORT_TOKEN`          | OTA updates, if that channel is used (same value) |

Repo **variables** (not secrets): `STRAVA_CLIENT_ID`, `ERROR_REPORT_ENDPOINT`
(if used), and optionally `OTA_REQUIRED_EXTRA` — see _Credentials in an
update_ above.

And in `app.config.ts` env: `EAS_PROJECT_ID`, `EAS_UPDATE_URL`. Store builds
take `ERROR_REPORT_TOKEN` **or** `ERROR_REPORT_ENDPOINT` — see _Error
reporting_ above — and the optional `STRAVA_CLIENT_ID` — see _Strava_ above
— from the EAS environment (the Strava secret is a Worker secret only); OTA
updates need the GitHub copies listed here as well.

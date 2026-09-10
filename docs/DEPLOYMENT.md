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
   _expo.dev → Account → Access Tokens_. Release and OTA workflows fail with an explicit missing-credential error if this secret is absent.

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
   requires the initial APK/AAB through the console); subsequent submissions can use `eas submit`. The release workflow defaults to `internal`; choose the exact closed-test track API ID or explicitly choose `production` after Play grants access.

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

Use the procedure in [CI/CD](CI.md#release-procedure). Update the marketing version in both package/config files and increment both native build numbers before building. The workflow checks for mismatches and previously used EAS build numbers.

Run **Release (Build & Submit to Stores)** on `main`, choosing `ios`, `android`, or `all`. Choose the exact Google track API ID; the default is `internal`. A version tag on main also starts the workflow, targeting internal Google testing. Production requires explicit selection and Play production eligibility.

The workflow waits separately for each signed build and its submission. It submits a validated **build ID**, never whichever binary happens to be latest. A failed submission can retry that ID from the same source commit without paying for another build.

**Apple submission uploads to App Store Connect/TestFlight.** It does not submit App Review or make the app public. Complete App Review in App Store Connect using [APP-STORE-SUBMISSION.md](APP-STORE-SUBMISSION.md). Google may also require review before users receive the release.

As of September 9, 2026, Play production access is not yet available for this account; internal/custom closed testing are the available release routes. App Store version 1.5.0 was waiting for review. Consult the consoles for current state instead of inferring it from a green GitHub run.

## Field updates without a store release

Main pushes can publish production OTA updates after code checks and compatibility checks against the current runtime's finished store binaries. Native input changes require a new binary/runtime. The workflow no longer allows rewriting the app version to force an update onto older native runtimes. See [OTA compatibility](CI.md#ota-compatibility) for its conservative checks and limits.

## Error reporting (one-time, optional but recommended)

Crashes and swallowed failures are captured, queued on disk, and filed as GitHub
issues **automatically and silently** (`src/lib/errorReporting`). The app never
asks the user to open GitHub or file anything themselves; without a delivery
channel configured, reports simply stay queued on the device and nothing is
shown. Pick **one** of the two channels below.

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
Strava?" after saving a recording; "Send to Strava" in the Library ⋮ menu) needs
a Strava API application. Without the credentials the feature stays visible but
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

### 2. Register the credentials as EAS env vars

```sh
eas env:create --name STRAVA_CLIENT_ID \
  --value <client id> \
  --environment production --visibility plaintext

eas env:create --name STRAVA_CLIENT_SECRET \
  --value <client secret> \
  --environment production --visibility secret
```

`app.config.ts` reads both into `extra.stravaClientId/stravaClientSecret`, so —
like `ERROR_REPORT_TOKEN` — **the client secret is baked into the shipped
binary**. This is unavoidable: Strava's token endpoint requires the client
secret and supports no PKCE. Strava's own mobile guidance tolerates this for
personal/small apps; the mitigations are the narrow requested scope
(`activity:write` only), Strava's per-app rate limits, and the ability to
regenerate the secret at any time (regenerating invalidates old binaries'
ability to _connect new accounts_; existing connections keep working until
their refresh token is rejected, at which point the app asks the user to
reconnect).

New Strava API apps start with an athlete cap of 1 (just the owner); request a
higher cap from Strava if others should connect.

### 3. Token & data handling (already implemented)

- Tokens (access + rotating refresh token + expiry) and the athlete name are
  stored on-device in `strava.json` (`src/state/stravaStore.ts`); refresh
  happens automatically, always keeping the rotated refresh token.
- Nothing is uploaded without an explicit user action, and _Disconnect_ in
  Settings also revokes the grant via `/oauth/deauthorize`.

## Secrets summary (GitHub → Settings → Secrets → Actions)

| Secret                        | Needed for        |
| ----------------------------- | ----------------- |
| `EXPO_TOKEN`                  | all EAS workflows |
| `ASC_API_KEY_P8`              | iOS submit        |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Android submit    |

And in `app.config.ts` env / repo variables: `EAS_PROJECT_ID`, `EAS_UPDATE_URL`,
and (EAS environment, not GitHub Actions) `ERROR_REPORT_TOKEN` **or**
`ERROR_REPORT_ENDPOINT` — see _Error reporting_ above — plus the optional
`STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` — see _Strava_ above.

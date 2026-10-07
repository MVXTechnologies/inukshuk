# CI/CD & self-checkups

All automation lives in `.github/workflows/`. The goal is a project that builds,
tests, and corrects itself without anyone watching.

| Workflow                   | Trigger                              | What it does                                                                                         |
| -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `ci.yml`                   | every push / PR                      | typecheck · lint · format-check · unit + script tests · tiles Worker · expo-doctor (advisory)        |
| `native-build.yml`         | every PR (builds if native); nightly | real **iOS** (`xcodebuild`) + **Android** (`gradlew assembleDebug`) compiles on latest runners       |
| `e2e.yml`                  | nightly; manual                      | Maestro flows on Android emulators, in parallel shards (`.maestro/shards.json`)                      |
| `release-path.yml`         | PRs/main touching the hook; weekly   | runs the EAS `eas-build-pre-install` hook like EAS does (Android + iOS → `pod install`)              |
| `runtime-check.yml`        | every PR; push to `main`             | compares the native runtime fingerprint with the latest store builds; warns, never fails             |
| `nightly.yml`              | nightly; manual                      | full gate + **blocking** expo-doctor + high+ audits (app, Worker); opens a tracking issue on failure |
| `ota-update.yml`           | push to `main` (JS/assets)           | publishes an EAS Update so installed apps self-correct                                               |
| `release.yml`              | version tag `v*`; manual             | EAS build + auto-submit to App Store & Play Store                                                    |
| `dependabot-automerge.yml` | Dependabot PRs; CI completion        | never merges: labels green minor/patch, non-native updates `ready-for-review` for a human            |
| `ci-health.yml`            | every 3 h; manual                    | one `ci-health` issue listing every workflow whose latest run on `main` (24 h) is red; auto-closes   |

Plus `.github/dependabot.yml` (weekly npm + actions updates, grouped).

## Why two kinds of "build test"

- **`native-build.yml`** is the free, fast answer to "does it still compile on
  the latest iOS/Android toolchains?" It runs entirely on GitHub's runners, needs
  no Expo account, and uploads the debug APK as an artifact. This is the
  day-to-day safety net.
- **`release.yml`** uses **EAS Build** (cloud) to produce signed, store-ready
  binaries and submit them. This needs `EXPO_TOKEN` + store credentials (see
  [DEPLOYMENT.md](DEPLOYMENT.md)) and only runs for real releases.

## Gating

- Configure `ci.yml` as a required check in repository branch protection/rulesets;
  defining a workflow alone does not enforce it. `npm run check` runs the quality
  gate locally, alongside `npx expo install --check` for SDK dependency alignment.
- OTA publishing and store release jobs run both checks on their own checkout
  before publishing/build submission, independently of merge protection.
- `native-build.yml` builds on native-affecting PRs so a broken pod/gradle change
  can't merge unnoticed. It triggers on **every** PR, with no `paths` filter:
  `Android (Gradle assembleDebug)` is a required check on `main`, and a workflow
  skipped by path filtering never reports its checks, which left docs-only PRs
  unmergeable (#369). Instead a cheap `changes` job diffs the PR against its
  base, and when nothing native-affecting changed (`package.json`,
  `package-lock.json`, `app.config.ts`, `app.json`, `src/`, `app/`, `assets/`,
  `plugins/`, `modules/`, the workflow itself, the Android SDK component list
  `scripts/ci/android{Sdk,-sdk}.*`) the build jobs are skipped by
  `if` — a job skipped by a conditional reports **Success**, so the required
  check passes without a build. If `changes` fails, the builds run anyway.
  Nightly and manual runs always build. Keep the path list in the workflow and
  here in sync.
- Anything that needs secrets (`release.yml`, `ota-update.yml`) **no-ops cleanly
  until those secrets exist**, via a `guard` job — so a fresh clone has green CI
  out of the box.

## Expo SDK patch releases break every branch at once

Expo publishes SDK patch releases (`expo`, `expo-router`, `expo-updates`, …)
whenever it likes. From that moment `npx expo install --check` — the
`Verify SDK-pinned dependency versions` step in `ci.yml`, and expo-doctor's
"Check that packages match versions required by installed Expo SDK" in the
nightly — fails on `main`, on every open PR and on every Dependabot PR, although
nothing in the repo changed. It stays red until someone runs

```sh
npx expo install --fix && npm run check
```

and commits the resulting `package.json` + `package-lock.json` bumps (plus the
usual device pass if a native package moved). Do not hand-edit the lockfile or
acknowledge the check in `expo-doctor-acknowledged.jsonc`: the fix is mechanical
and a stale SDK pin is exactly what the check exists to catch. When the nightly
fails this way, its tracking issue says so and quotes that command.

## No implicit downloads; caches written from `main` only

A red build is a bug or an infrastructure weakness, never "just a flake". The
recurring infrastructure failures were network fetches made deep inside a
long job, with no retry:

- **Android SDK components.** AGP downloads a missing NDK or CMake in the middle
  of the Gradle build. On 2026-10-07 a truncated `ndk;27.0.12077973` zip and a
  refused `cmake;3.22.1` each failed a 20-minute build. Now
  `scripts/ci/android-sdk.mjs install` installs every component the build needs
  (platform, build-tools, React Native's NDK, AGP's default NDK, CMake —
  computed by `scripts/ci/androidSdk.mjs` from React Native's version catalog
  and the per-AGP pins in `scripts/ci/android-sdk.json`) before Gradle runs,
  retrying only that download (3 attempts, each retry a `::warning::`), and
  Gradle runs with `-Pandroid.builder.sdkDownload=false`. If a dependency bump
  needs a component the list lacks, Gradle fails at configuration time naming
  it (and an AGP bump without a pin fails the script in seconds): add it to
  `android-sdk.json`. The NDKs and CMake are also cached (restored everywhere,
  saved from `main`).
- **Maestro** is pinned (`MAESTRO_VERSION` in `e2e.yml`); the installer is
  downloaded to a file, then run, with a bounded retry of that download only.
- **Gradle and NDK caches are saved from `main` only** (`actions/cache/restore`
  everywhere, `actions/cache/save` when `github.ref == refs/heads/main`). Every
  PR used to save its own 2.6 GB Gradle entry, which kept the repository over
  GitHub's 10 GB cache limit and evicted `main`'s entries, so builds ran cold
  and re-fetched everything from Maven Central (2026-10-07: `Could not find
error_prone_annotations-2.15.0.jar`).

Retries never wrap tests or builds: a flow or a compile that fails is reported
as failed.

## Concurrency

On a PR, a new push cancels that PR's previous run. On `main`, `ci.yml` and
`runtime-check.yml` run once per commit (back-to-back merges used to cancel each
other, leaving no verdict for any but the last), and `native-build.yml` /
`e2e.yml` group by event, so a manual dispatch on `main` no longer cancels the
nightly scheduled run.

**Runner queue.** Every PR push starts CI, Native Build Test (a ~40-minute
Android job and a ~40-minute macOS job), the runtime check and sometimes the
release path. With several agents pushing at once, the account's concurrent
job limit saturates. On 2026-10-07 jobs sat _queued_ for 25–60 minutes (an
Android job of #603 waited an hour; a photos E2E build 28 minutes; iOS jobs 20+
minutes for a macOS runner), which looks like "in progress" in the PR list.
Owner decision (2026-10-07): native builds keep running on draft PRs, because
agents need that evidence; superseded runs of the same PR are cancelled
(concurrency above), which is the lever we use.

GitHub delays scheduled runs under load (the 05:00/05:15 UTC nightlies started
at ~11:40 UTC on 2026-10-07); nothing in the repo can fix that, the monitor
below just reports on whatever ran.

## CI health monitor (`ci-health.yml`)

Every 3 hours, for each workflow that ran on `main` in the last 24 h, the
latest completed run decides: failure, timeout, startup failure or
cancellation (no verdict) is red. Any red workflow opens — or rewrites — the
single issue labelled `ci-health`, with links; when all are green it closes it.
The Nightly Health issue (`health-check`) still carries the failing step's
details; this one answers "is `main` green?".

## Coverage

`jest.config.js` enforces 80% line / 80% function / 70% branch coverage on
`src/core/**` — the pure, safety-relevant logic. UI is verified by typecheck,
lint, native compile, and the Maestro smoke flow rather than snapshot tests.

## E2E shards (`e2e.yml`)

One job builds the release APK (x86_64) and uploads it; the flows then run in
parallel **shards**, each on its own freshly booted emulator, with a 35-minute
per-shard timeout. The plan lives in `.maestro/shards.json`:

- `shards` — shard name → flows, in run order. State never crosses shards, so
  a flow that needs another flow's output (category-record's trail) sits after
  it in the same shard; `requires` records those dependencies.
- `parked` — flows CI deliberately does not run, each with its reason (today:
  the weather and marine flows, parked behind their feature flags, and
  waypoint-bubble, whose screen-geometry taps fail on the CI emulator).
- A flow whose `launchApp` clears state, or that is listed in `last`, must end
  its shard.

`scripts/ci/e2eShards.test.mjs` (in `npm run test:scripts`, so on every PR)
fails when a `.maestro/*.yaml` flow is in no shard and not parked, or when the
ordering rules break — a new flow cannot silently stay out of CI again (tides,
geodetic and convert did, until 2026-10). The matrix is read
from the same file, so adding a shard needs no workflow edit.

Run a subset by hand with **Run workflow → shards** (`trails,catalog`), and
locally with `bash .github/scripts/e2e-attempts.sh <shard>` against a running
emulator with the e2e APK installed.

The runner (`.github/scripts/e2e-attempts.sh`) keeps the emulator workarounds
(`hide_error_dialogs`, `immersive_mode_confirmations`, location services on
— see the comments in `e2e.yml`), feeds a background geo-fix loop that
alternates between two points ~86 m apart, serves the fixture catalog, retries
a failed flow once and reports a retried pass as a **warning annotation** (and
uploads its first failure's logcat), so a flake is visible on a green run.
Flows that set the location themselves and then tap by screen position carry
the Maestro tag `own-location`; the loop is paused while they run, because
moving the user moves the follow-camera under the tap (the old `heatmap.yaml`
flake). Each shard writes a per-flow pass/time table to its job summary.

The geo-fix feed is **gated** (run 37628988758, 2026-10-07): the emulator's
GNSS HAL can deadlock `system_server` when a fix's status report races
`GnssNative.stop()`, which happens when Maestro force-stops or relaunches the
app at a flow boundary. The Watchdog then kills `system_server` ("Blocked in
handler on foreground thread (android.fg) for 68s") and every later adb or
Maestro call breaks ("Broken pipe", "Device server died"). A fix is now sent
only while a flow is running (never across transitions or installs), only
once the app process has lived a full tick unchanged (a launch, force-stop or
relaunch pauses it), and every 5 s instead of 2 s. If `system_server` still
restarts, the runner reports **`E2E infra: emulator system_server
restarted`** as its own error annotation, uploads
`logcat-system-server-restart-*.txt`, does not retry the flow, and marks the
shard's remaining flows NOT RUN. Results from a rebooted emulator prove
nothing either way.

## Release path (`release-path.yml`)

The 2.3.0 store builds failed only on EAS, in the `eas-build-pre-install` hook
(`scripts/eas-pre-install.sh` → `modules/inukshuk-proj/scripts/prepare.sh` →
`build-proj.sh`): no CMake on the Android image, `www.sqlite.org` unreachable,
and on iOS the PROJ xcframeworks appearing only after `pod install`.
`native-build.yml` cannot see that class of failure: it calls `proj:prepare`
directly on runners that have CMake. This workflow runs the hook the way EAS
does, before `npm ci`:

- **Android** (ubuntu), CMake removed from `PATH` and from `$ANDROID_HOME/cmake`.
  Variant `sdkmanager` builds all four ABIs with the SDK CMake that
  `build-proj.sh` installs; variant `pip` also hides `sdkmanager`, so CMake comes
  from `pip --user` (one ABI — only the tool discovery differs). On a cold build
  each variant asserts which fallback the log says was used.
- **iOS** (macOS), CMake uninstalled so the hook's own `brew install cmake` runs;
  then `npm ci` → `expo prebuild` → `pod install`, and the Pods project must
  contain `Proj.xcframework` and `Tiff.xcframework`.

The PROJ outputs are cached on the scripts that make them and on the workflow
itself (`proj-eas-<platform>-…`), so an unrelated PR re-runs the hook's
idempotent path in a minute or two. The weekly schedule and **Run workflow → cold** ignore the
cache and build from source, which is what catches runner-image and mirror
drift.

## OTA runtime-match check (`runtime-check.yml`)

An EAS Update reaches only binaries whose runtime — the native fingerprint
(`runtimeVersion.policy: 'fingerprint'`, `fingerprint.config.js`) — equals the
one it was published from (`ota-update.yml`). The job:

1. computes `npx expo-updates fingerprint:generate --platform ios|android` for
   this commit and, on a PR, for its base (a separate checkout with its own
   `npm ci`, since the fingerprint hashes the installed native packages);
2. reads the latest **finished production** build per platform with
   `eas build:list --status finished --build-profile production --limit 1 --json`
   (needs the `EXPO_TOKEN` secret; skipped without it — forks, Dependabot);
3. reports through `scripts/ci/runtime-check.mjs`: a job-summary table
   (base · head · store runtime, store version and build number), a warning
   annotation per affected platform, and on a PR that changes the runtime one
   sticky PR comment (marker `<!-- runtime-check -->`), updated in place on
   later pushes. The comment also lists which fingerprint sources changed.

It **warns and never fails**: native changes are legitimate. What the warning
means — e.g. _"iOS: this PR changes the native runtime; OTAs from main will no
longer reach store 2.3.0 (build 18) until the next store release"_ — is that
the release process owes a store build before installed apps take OTAs from
`main` again. If `main` had already diverged, the message says so instead (the
PR does not make it worse). On push to `main` it compares `main` itself with the
store builds. "Latest store build" means the newest finished `production` EAS
build; a build that was never promoted in the store consoles still counts.

**Remedy until the next store release.** A store build that `main`'s OTAs no
longer reach still takes fixes as OTAs published from a hotfix branch cut at
that build's own commit: `hotfix/<major>.<minor>.x` by convention, with
`ota-update.yml` run on that branch ([DEPLOYMENT.md](DEPLOYMENT.md) › "Field
updates without a store release"). Every warning names the branch and the
build's commit (`gitCommitHash` from `eas build:list`).

The case this check was built for (2026-10-06): #581 changed
`modules/inukshuk-proj/scripts/build-proj.sh` after iOS 2.3.0 build 18
(runtime `f81e7412…`, commit `17cfebb`) was cut, so `main`'s iOS runtime became
`ceb5e692…` and its OTAs stopped reaching build 18, while Android `main` still
matched versionCode 63 (`884f71ce…`). On `main` the check reports exactly that,
one warning, iOS only, and names `hotfix/2.3.x` (cut at `17cfebb`) as the way to
ship iOS fixes until 2.3.1/2.4.0 is in the store.

## Tiles Worker (`ci.yml` › `worker`)

`infra/tiles/worker` is its own npm project (committed `package-lock.json`,
Workers `tsconfig`). CI installs it with `npm ci --ignore-scripts`, typechecks
it, and runs its Jest suites. Deploying it is still the owner's manual step
(`infra/tiles/README.md`).

## Workflow security

- **Least privilege.** Every workflow declares `permissions: contents: read` at
  the top; a job that needs more (the nightly's issue filing, the Dependabot
  auto-merge) declares it on that job only. `runtime-check.yml` (one job) adds
  `pull-requests: write` for its sticky PR comment. The repository default is
  also read-only.
- **Actions are pinned to a commit SHA** (`uses: owner/action@<sha> # vX.Y.Z`).
  A tag can be moved by whoever controls the action's repository; a SHA cannot.
  Dependabot's `github-actions` updater understands the comment and bumps
  both together, so pins don't go stale.
- **No untrusted text in `run:`.** `${{ … }}` inside a script is pasted in
  before the shell parses it. Event data and inputs go through `env:` and are
  read as `"$VAR"`.
- **`pull_request_target`** (and `workflow_run`) are used only by
  `dependabot-automerge.yml` ("Dependabot triage"), which never checks out
  the PR, and acts only on PRs Dependabot opened in this repository
  (`pull_request.user.login`, not just `github.actor`).
- **No automated merges of dependency updates.** The audit flagged the chain
  Dependabot → auto-merge → OTA publish. The triage workflow labels a
  minor/patch, non-native update `dependabot:eligible`; once every check on its
  head commit is green it adds `ready-for-review` and one summary comment, and
  a human merges it.
- Fork PRs get no secrets (`pull_request`), so CI, native builds and E2E never
  see a credential.

### Who can publish to users

An OTA update (`ota-update.yml`) reaches every installed app on the matching
runtime within minutes, and a store build (`release.yml`) goes to TestFlight /
the Play internal track. Both jobs (and their guards) run in the GitHub
**environment `production`**, which is where the owner decides who may do it
(Settings → Environments → production):

1. **Deployment branches and tags → Selected**: `main`, `hotfix/*` (the
   branch-from-a-release-tag fix path in DEPLOYMENT.md), and tag `v*`.
   Without it, anyone with write access can run _OTA Update_ on any branch from
   the Actions tab and ship that branch to users.
2. **Move `EXPO_TOKEN`, `ASC_API_KEY_P8`, `GOOGLE_SERVICE_ACCOUNT_JSON` and
   `ERROR_REPORT_TOKEN` from repository secrets to environment secrets**, so
   only jobs that pass the rules above can read them (a workflow pushed on a
   side branch can read every repository secret).
3. Optional: **Required reviewers** = the owner, if every publish should wait
   for a click.

The guard jobs sit in the same environment, so they keep seeing `EXPO_TOKEN`
after the move.

### `runtime-check.yml` and `EXPO_TOKEN`

`runtime-check.yml` runs on `pull_request` and reads the latest store builds
with the **repository** secret `EXPO_TOKEN` (`eas build:list`, read only). It
keeps working while the token stays at repo level. If `EXPO_TOKEN` moves into
the `production` environment (step 2 above), give this check its own token
instead: a **read-only Expo robot token** stored as the repository secret
`EXPO_READ_TOKEN`, and point the workflow's `HAS_EXPO_TOKEN` / `token:` at
it. Never hand a publishing token to a `pull_request` job.

Without any token the check degrades on its own: the EAS steps are skipped
(`HAS_EXPO_TOKEN` is false), `runtime-check.mjs` treats the missing
`store-*.json` as optional, and the report still compares this PR's
fingerprints with its base's ("Latest store build: n/a"). Fork and
Dependabot PRs run that way today.

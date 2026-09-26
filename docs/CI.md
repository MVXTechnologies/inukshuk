# CI/CD & self-checkups

All automation lives in `.github/workflows/`. The goal is a project that builds,
tests, and corrects itself without anyone watching.

| Workflow                   | Trigger                              | What it does                                                                                   |
| -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `ci.yml`                   | every push / PR                      | typecheck · lint · format-check · unit tests + coverage · expo-doctor (advisory)               |
| `native-build.yml`         | every PR (builds if native); nightly | real **iOS** (`xcodebuild`) + **Android** (`gradlew assembleDebug`) compiles on latest runners |
| `e2e.yml`                  | nightly; manual                      | Maestro smoke flow on an Android emulator                                                      |
| `nightly.yml`              | nightly; manual                      | full gate + **blocking** expo-doctor + `npm audit`; opens a tracking issue on failure          |
| `ota-update.yml`           | push to `main` (JS/assets)           | publishes an EAS Update so installed apps self-correct                                         |
| `release.yml`              | version tag `v*`; manual             | EAS build + auto-submit to App Store & Play Store                                              |
| `dependabot-automerge.yml` | Dependabot PRs                       | auto-merges green minor/patch updates, except native-bearing ones (they need a store build)    |

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
  `plugins/`, `modules/`, the workflow itself) the build jobs are skipped by
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

## Coverage

`jest.config.js` enforces 80% line / 80% function / 70% branch coverage on
`src/core/**` — the pure, safety-relevant logic. UI is verified by typecheck,
lint, native compile, and the Maestro smoke flow rather than snapshot tests.

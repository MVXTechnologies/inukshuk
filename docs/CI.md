# CI/CD & self-checkups

All automation lives in `.github/workflows/`. The goal is a project that builds,
tests, and corrects itself without anyone watching.

| Workflow                   | Trigger                            | What it does                                                                                   |
| -------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ci.yml`                   | every push / PR                    | typecheck · lint · format-check · unit tests + coverage · expo-doctor (advisory)               |
| `native-build.yml`         | PRs touching native files; nightly | real **iOS** (`xcodebuild`) + **Android** (`gradlew assembleDebug`) compiles on latest runners |
| `e2e.yml`                  | nightly; manual                    | Maestro smoke flow on an Android emulator                                                      |
| `nightly.yml`              | nightly; manual                    | full gate + **blocking** expo-doctor + `npm audit`; opens a tracking issue on failure          |
| `ota-update.yml`           | push to `main` (JS/assets)         | publishes an EAS Update so installed apps self-correct                                         |
| `release.yml`              | version tag `v*`; manual           | EAS build + auto-submit to App Store & Play Store                                              |
| `dependabot-automerge.yml` | Dependabot PRs                     | auto-merges green minor/patch dependency updates                                               |

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
- `native-build.yml` runs on native-affecting PRs so a broken pod/gradle change
  can't merge unnoticed.
- Anything that needs secrets (`release.yml`, `ota-update.yml`) **no-ops cleanly
  until those secrets exist**, via a `guard` job — so a fresh clone has green CI
  out of the box.

## Coverage

`jest.config.js` enforces 80% line / 80% function / 70% branch coverage on
`src/core/**` — the pure, safety-relevant logic. UI is verified by typecheck,
lint, native compile, and the Maestro smoke flow rather than snapshot tests.

# CI/CD

GitHub Actions verifies source, EAS builds signed binaries, and Apple/Google process submissions. These are separate outcomes. A green scheduling job is not a successful release.

## Checks and publishing

| Workflow             | Trigger                             | Result                                                                                                                                                                             |
| -------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI                   | PR, main push, manual               | Code quality, workflow validation, and Expo runtime health are separate checks. Runtime health is no longer a hidden advisory failure.                                             |
| Native Build Test    | Every PR; nightly; manual           | Android/iOS compile when native inputs change. JS/docs-only PRs report skipped native jobs. Nightly/manual always compile.                                                         |
| E2E                  | Nightly; manual                     | Builds a bundled release APK and tests on an Android emulator. Preserves diagnostics even when a retry succeeds.                                                                   |
| Nightly Health Check | Nightly; manual                     | Code quality, Expo runtime health, and security run independently. A Doctor failure cannot prevent the security audit. Updates one tracking issue with the failing jobs.           |
| OTA Update           | Relevant main push; manual on main  | Publishes only if every returned production binary in the current runtime has matching native inputs and both platforms have a binary. Otherwise records why no OTA was published. |
| Release              | Version tag on main; manual on main | Validates source and versions; builds each platform independently; waits for build completion; uploads the exact build ID; waits for submission completion.                        |

Release and OTA jobs fail clearly when required credentials are missing. They are serialized and do not cancel an upload already running. CI cancels superseded PR checks; **cancelled is not failed**.

Tool versions used by automation are explicit: Node 22, EAS CLI 23.2.0, Expo Doctor 1.20.4, audit-ci 7.1.0, actionlint 1.7.12, and Xcode 26.3. Update them intentionally and revalidate. Dependency installation uses `npm ci` and the committed lockfile.

## Merge protection

`main` had no branch protection at the September 9, 2026 audit. Workflow files alone cannot enforce merge rules. Configure up-to-date branches and these required checks after this workflow change lands:

- `Typecheck · Lint · Format · Test`
- `Workflow validation`
- `Expo runtime health`
- `Detect native build inputs`
- `Android (Gradle assembleDebug)`
- `iOS (xcodebuild simulator)`

Native jobs may succeed by being skipped when the path detector finds no native input changes. Include the detector itself so a failed detector cannot bypass compilation. Dependabot auto-merge now refuses to enable itself unless the documented checks and strict branch protection can be verified. No privileged PR source checkout is used by that workflow.

## Release procedure

1. Update **both** `package.json`/lockfile and `app.config.ts` marketing versions. Increment iOS `buildNumber` and Android `versionCode`. Native changes need a new app-version runtime.
2. Pass code checks, runtime health, relevant native builds, and app smoke tests. Merge the reviewed release candidate to main.
3. Run **Release (Build & Submit to Stores)** on main, choosing platforms and the Google **track API ID**. Default is `internal`; an existing closed-test track can be supplied by its exact API ID. A display label is not necessarily its API ID. `production` is an explicit choice and requires Play production access. Tag-triggered releases use `internal`.
4. Follow the platform jobs through **Build** and **Submit**. The pipeline validates finished status, platform, store distribution, production build profile, source SHA, runtime, marketing version, and native build number before uploading.
5. If only submission fails, rerun with `ios_build_id` or `android_build_id` on the **same source commit**. This reuses the validated artifact. Do not rebuild with a consumed number or use `--latest`.

Preflight scans paginated EAS store-build history across build profiles for reused/regressed numbers. It cannot detect uploads made outside EAS or prevent an unrelated manual upload racing the pipeline; the actual store submission remains authoritative and must succeed.

Apple upload completion means **App Store Connect/TestFlight**, not App Review approval or public availability. Google upload completion also remains subject to Play review. Confirm store state before telling users a release is live.

## OTA compatibility

The former manual `app_version_override` was removed: changing a version string does not prove that new JS is compatible with an older binary. The current gate compares native source/config/dependency inputs against every finished store build on the production channel for the current runtime (across build profiles), requires both platforms, and fails closed for missing history, unresolvable commits, dirty tracked files, or history exceeding the 5,000-build verification limit. It intentionally prefers a new binary over guessing. Native assets/config changes can conservatively block OTA even when a human might prove them safe.

Production EAS environment variables are used during publishing. A superseded checkout is rejected before publication, and serialized publishing prevents older jobs becoming the latest update after newer jobs. This is a source-based compatibility guard, not a substitute for device testing or native runtime version discipline.

## What the September 9 audit found

- **False release success:** [run 34273705593](https://github.com/MVXTechnologies/inukshuk/actions/runs/34273705593) exited successfully after `--no-wait` scheduled EAS work. Its Android submission later failed with `Precondition check failed`. Build and submission now wait and report independently.
- **Wrong Google destination:** Play Console showed production locked (3 enrolled closed testers; 12 for 14 days required). Build 52 was available through internal and a custom closed-test track, while automation attempted production. The destination is now explicit and defaults to internal testing.
- **Native churn and missing coverage:** recent runs were mostly successful or superseded/cancelled. Every JS edit rebuilt native projects, while `modules/**` could fail to trigger them. Input detection now covers local native modules and build hooks without rebuilding for normal JS/docs edits.
- **Lost emulator diagnostics:** E2E run 34024523773 failed UI assertions amid app/SystemUI ANRs; the same commit passed the next nightly. Its artifact contained logcats but no hidden Maestro screenshots/hierarchy. Diagnostics are now retained, including successful retries. The workflow repair does not claim to fix the underlying responsiveness failure.
- **Security scan hidden by the SDK failure:** splitting the nightly jobs exposed new `xmldom` and `js-yaml` advisories. Three compatible dependency patches now make the existing audit policy pass without adding exceptions.
- **Real SDK health failure:** [nightly 34335377671](https://github.com/MVXTechnologies/inukshuk/actions/runs/34335377671) passed all 2,675 tests, then found the affected Hermes V1 runtime. Expo 56 / RN 0.85.3 includes Hermes `.10`; the memory fix starts at `.16` in SDK 57 / RN 0.86.2. [Expo's maintainer states there is no SDK 56 backport](https://github.com/expo/expo/issues/46519#issuecomment-5286517587). This is exposure to an affected runtime, not a measurement proving that every map crash has this cause. Keep this check red until a separately validated SDK/native upgrade resolves it; do not hide it with an old Doctor version or an ignore flag.

## Local verification

```sh
npm ci
npm run check
node --test scripts/ci/*.test.mjs
actionlint
npx --yes expo-doctor@1.20.4
npx --yes audit-ci@7.1.0 --config ./audit-ci.jsonc
```

`npm run check` covers strict TypeScript, zero-warning lint, formatting, tests, and pure-core coverage thresholds. Release-policy tests exercise wrong/unfinished artifacts, version mismatch, duplicate history, and native OTA changes. No live store upload is necessary to validate workflow policy.

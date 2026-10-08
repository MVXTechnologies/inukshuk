# Inukshuk — agent & contributor guide

Offline trail-navigation app: georeferenced PDF maps + OSM base layer + GPX
route recording. Expo SDK 56 / React Native 0.85 / React 19 / TypeScript.

## Before writing native/Expo code

Expo APIs change between SDKs. Read the **versioned** docs for SDK 56:
https://docs.expo.dev/versions/v56.0.0/ — notably `expo-file-system` uses the
new `File`/`Directory`/`Paths` API (not the legacy `readAsStringAsync` API).

## Conventions

- **Keep `src/core/**`pure** — no`react-native`/`expo`imports there. It's the
  unit-tested logic layer (georeferencing, GPX, track math) with a coverage gate.
  Platform code goes in`src/data`(persistence),`src/state`(Zustand),`src/features` (screens/hooks).
- **Path aliases**: `@core`, `@data`, `@state`, `@features`, `@ui`, `@lib`, `@/`.
  Declared in `tsconfig.json` + `jest.config.js` — keep them in sync.
- **Strict TS**: `strict` + `noUncheckedIndexedAccess`. Index access is
  `T | undefined`; guard it, don't cast it away.
- **Before committing**, run `npm run check` (typecheck + lint + format + tests).
  Lint allows **zero** warnings. Prettier: single quotes, semicolons, width 100.
- New pure logic in `src/core` must come with co-located `*.test.ts`.

## CI discipline (non-negotiable)

Any red CI run is a defect: a bug caught late, or an infrastructure weakness to
remove at its cause. Never mute, skip, loosen a gate, or add blind retries.

- **Nothing is pushed without a green `npm run check`.** The pre-push hook
  (`.githooks/pre-push`, enabled by `npm install`) enforces it and refuses a
  stale `node_modules`. `INUKSHUK_SKIP_PREPUSH=1` is for emergencies only and
  must be explained in the PR.
- **Squash WIP locally.** Don't push intermediate commits to see if CI passes.
  Dispatch E2E or native builds only when the work is ready.
- **After merging a dependency change, refresh the shared install**
  (`npm install` in the root checkout) before anyone tests or builds locally.
- **Flaky = broken.** A test or job that fails intermittently is fixed at its
  cause, with repeated green runs as proof, never retried into green.
- **`main` stays green.** The `ci-health` workflow opens an issue when any
  workflow on `main` is red; fix it before starting new work.
- **Measure, don't assert:** timing tests count work (refolds, renders, ops)
  and use wall-clock only as generous ceilings.

## Layout

See `docs/ARCHITECTURE.md`. Routes are in `app/` (expo-router); each route file
just renders a screen from `src/features`.

## CI / deploy

`docs/CI.md` and `docs/DEPLOYMENT.md`. Workflows that need store/EAS secrets
no-op until those secrets are configured.

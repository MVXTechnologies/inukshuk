# inukshuk-app-update (Android)

Google Play In-App Updates, flexible flow, for the 2.7.0 "New version"
prompt on the Map. `check` / `startFlexible` / `completeUpdate` and an
`onState` download event; no permissions, no config plugin. JS:
`src/lib/playAppUpdate.ts` (the bridge) and `src/data/storeUpdate.ts` (the
check). iPhone needs no native code: the App Store lookup is a plain fetch.
